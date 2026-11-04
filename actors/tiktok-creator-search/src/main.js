import { Actor, log } from 'apify';

import { presetSearches } from './presets.js';
import { defaultEngines, discoverCreators, parseFollowerHint, CRITERIA_QUERY } from './serp.js';
import { fetchVideoPlace } from './video.js';
import { fromCandidateFeed } from './candidate-source.js';
import { discoverFromCreativeCenter } from './creative-center.js';

const PROFILE_ACTOR = 'fouad_dp/tiktok-profile-video-stats';
const RUNTIME_FIX_VERSION = '2026-11-04-v14';
const BATCH = 5;
const MAX_PROFILE_CALLS = 4; // use available runtime to screen more candidates

const DEFAULTS = {
    excludeWords: [],
    searchModifiers: [],
    maxSearchPages: 2,
    maxSearchSeconds: 45,
    maxRunSeconds: 300,
    resumeToken: null,
    maxCreators: 100,
    enrichProfiles: true,
    profileActor: PROFILE_ACTOR,
    onlyPassing: true,
    regions: [],
    languages: [],
    matchMode: 'prefer',
    examPresets: [],
    seedHandles: [],
    candidateFeed: [],
    discoverySource: 'search',
    knownHandles: [],
    rememberProcessedHandles: true,
    addMedianViews: false,
    videosForMedian: 10,
    hashtagsFirst: true,
    excludeVerified: true,
    minFollowers: 10000,
    maxFollowers: 150000,
    minMedianViews: 5000,
    maxDaysSinceLastPost: 7,
};

export function readInput(raw) {
    const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)) };
    const required = { minFollowers: 10000, maxFollowers: 150000, minMedianViews: 5000, maxDaysSinceLastPost: 7, excludeVerified: true, onlyPassing: true, enrichProfiles: true };
    for (const key of Object.keys(required)) {
        if (input[key] !== required[key]) throw new Error('Required screening setting invalid: ' + key);
    }
    const presets = presetSearches(input.examPresets);
    const splitTerms = (values) => values.flatMap((v) => String(v).split(/[,;\n]+/)).map((v) => v.trim()).filter(Boolean);
    const keywords = splitTerms([...(input.keywords ?? []), ...presets.keywords]);
    const hashtags = splitTerms([...(input.hashtags ?? []), ...presets.hashtags])
        .map((h) => h.replace(/^#+/, ''))
        .filter(Boolean)
        .map((h) => `#${h}`);
    const cleanHandle = (v) => String(v ?? '').trim().replace(/^@+/, '').toLowerCase();
    const seedHandles = [...new Set((input.seedHandles ?? []).map(cleanHandle).filter(Boolean))];
    if (!Array.isArray(input.candidateFeed)) throw new Error('candidateFeed must be an array of handles or profile URLs.');
    if (!['search', 'creativeCenter'].includes(input.discoverySource)) throw new Error('discoverySource must be search or creativeCenter.');
    const token = input.resumeToken ?? {};
    if (typeof token !== 'object' || Array.isArray(token)) throw new Error('resumeToken must be an object from a prior RUN_SUMMARY.');
    const resumeIndex = Number.isInteger(token.nextSearchIndex) && token.nextSearchIndex >= 0 ? token.nextSearchIndex : 0;
    const priorProcessed = Array.isArray(token.processedHandles) ? token.processedHandles : [];
    const knownHandles = [...new Set([...(input.knownHandles ?? []), ...(input.excludeHandles ?? []), ...priorProcessed].map(cleanHandle).filter(Boolean))];
    for (const key of ['maxSearchPages', 'maxSearchSeconds', 'maxCreators', 'maxRunSeconds']) {
        if (!Number.isInteger(input[key]) || input[key] < 1)
            throw new Error(`Input "${key}" must be a whole number of 1 or more.`);
    }
    if (input.minFollowers != null && input.maxFollowers != null && input.minFollowers > input.maxFollowers) {
        throw new Error('"minFollowers" is larger than "maxFollowers".');
    }
    if (input.minMedianViews != null && input.maxMedianViews != null && input.minMedianViews > input.maxMedianViews) {
        throw new Error('"minMedianViews" is larger than "maxMedianViews".');
    }
    if (!Number.isInteger(input.videosForMedian) || input.videosForMedian < 1 || input.videosForMedian > 10)
        throw new Error(
            'Input "videosForMedian" must be a whole number from 1 to 10 (TikTok\'s public embed exposes up to 10 recent videos).',
        );
    if (!['prefer', 'only'].includes(input.matchMode)) throw new Error('"matchMode" must be "prefer" or "only".');
    const upper = (xs) => [...new Set((xs ?? []).map((x) => String(x).trim()).filter(Boolean))];
    if (!Number.isInteger(input.maxDaysSinceLastPost) || input.maxDaysSinceLastPost < 1) throw new Error('Input "maxDaysSinceLastPost" must be a whole number of 1 or more.');
    const wantMedian = true; // every returned creator is enriched with median views
    const criteriaSearches = (!keywords.length && !hashtags.length && !seedHandles.length)
        ? [CRITERIA_QUERY]
        : [];
    const orderedTopicSearches = input.hashtagsFirst ? [...hashtags, ...keywords] : [...keywords, ...hashtags];
    return {
        ...input,
        regions: upper(input.regions).map((r) => r.toUpperCase()),
        languages: upper(input.languages).map((l) => l.toLowerCase()),
        wantMedian,
        seedHandles,
        knownHandles,
        resumeIndex,
        priorProcessed,
        criteriaOnly: criteriaSearches.length > 0,
        searches: [...new Set([...orderedTopicSearches, ...criteriaSearches, ...seedHandles.map((h) => `@${h} similar creators`)])],
    };
}

// Prioritize promising individual creators without excluding any candidate based on its name.
// Follower hints are unverified search evidence; final acceptance always uses Profile Stats.
export function orderCandidates(candidates, { minFollowers = null, maxFollowers = null } = {}) {
    const fit = (c) => {
        const n = parseFollowerHint(c.hint);
        if (n == null || (minFollowers == null && maxFollowers == null)) return 1;
        return (minFollowers != null && n < minFollowers) || (maxFollowers != null && n > maxFollowers) ? 2 : 0;
    };
    // Soft tie-breaker only: an app/service-looking handle may still be a legitimate creator.
    const serviceLike = (c) => /(?:^|[._-])(?:app|officialapp|software|platform|store|shop|group|brand|company)(?:$|[._-])/i.test(c.handle ?? '') || /^(?:anytimefitness|thegymgroup)$/i.test(c.handle ?? '') ? 1 : 0;
    return [...candidates].sort(
        (a, b) =>
            fit(a) - fit(b) ||
            serviceLike(a) - serviceLike(b) ||
            Number(b.profileHit) - Number(a.profileHit) ||
            (Number(b.timesSeen) || 0) - (Number(a.timesSeen) || 0) ||
            a.handle.localeCompare(b.handle),
    );
}

export function checkFilters(row, { minFollowers, maxFollowers, minMedianViews, maxMedianViews, maxDaysSinceLastPost = null, excludeVerified = true }) {
    const failures = [];
    const judged = [];
    if (row.followers != null) {
        judged.push('followers');
        if (minFollowers != null && row.followers < minFollowers)
            failures.push(`followers ${row.followers} below ${minFollowers}`);
        if (maxFollowers != null && row.followers > maxFollowers)
            failures.push(`followers ${row.followers} above ${maxFollowers}`);
    }
    if (row.medianViews != null) {
        judged.push('medianViews');
        if (minMedianViews != null && row.medianViews < minMedianViews)
            failures.push(`median views ${row.medianViews} below ${minMedianViews}`);
        if (maxMedianViews != null && row.medianViews > maxMedianViews)
            failures.push(`median views ${row.medianViews} above ${maxMedianViews}`);
    }
    if (excludeVerified && row.verified === true) failures.push('verified/celebrity');
    if (row.daysSinceLastPost != null) judged.push('activity');
    if (row.daysSinceLastPost != null && maxDaysSinceLastPost != null && row.daysSinceLastPost > maxDaysSinceLastPost) failures.push(`inactive: last post ${row.daysSinceLastPost} days ago, maximum ${maxDaysSinceLastPost}`);
    const asked = (minFollowers != null || maxFollowers != null ? ['followers'] : []).concat(
        minMedianViews != null || maxMedianViews != null ? ['medianViews'] : [],
    ).concat(maxDaysSinceLastPost != null ? ['activity'] : []);
    // a creator is judged only when every figure the filters need is known (or a known figure already fails)
    if (failures.length) return { passes: false, failures };
    if (row.followers == null && row.medianViews == null) return { passes: null, failures };
    if (asked.some((a) => !judged.includes(a))) return { passes: null, failures };
    if (excludeVerified && row.verified == null) return { passes: null, failures };
    if (row.profileStatus != null && row.profileStatus !== 'ok') return { passes: null, failures };
    return { passes: true, failures };
}

// Where the creator's own profile says they are: a requested country or language matches or not (null = unknown)
export function matchRegionLanguage(row, { regions = [], languages = [] }) {
    const m = (wanted, value, fold) => (!wanted.length ? null : value == null ? null : wanted.includes(fold(value)));
    const region = m(regions, row.region, (v) => String(v).toUpperCase());
    const language = m(languages, row.language, (v) => String(v).toLowerCase().split('-')[0]);
    const parts = [region, language].filter((x) => x != null);
    if (!regions.length && !languages.length) return { regionMatch: null, languageMatch: null, locationMatch: null };
    return { regionMatch: region, languageMatch: language, locationMatch: parts.length ? parts.every(Boolean) : null };
}

export function creatorRow(candidate, profile, enrichNote) {
    const base = {
        recordType: 'creator',
        handle: candidate.handle,
        profileUrl: `https://www.tiktok.com/@${candidate.handle}`,
        foundVia: candidate.profileHit ? 'profile page' : 'video',
        queriesMatched: candidate.queries,
        matchedQuery: candidate.queries?.[0] ?? 'criteria',
        timesSeen: candidate.timesSeen,
        searchFollowerHint: candidate.hint ?? null,
        searchSnippets: candidate.snippets,
        sampleVideoUrls: candidate.videoUrls,
    };
    const p = profile ?? {};
    return {
        ...base,
        enriched: Boolean(profile),
        enrichStatus: profile?.status === 'ok' ? 'ok' : 'failed',
        enrichReason: profile?.status === 'ok' ? null : (enrichNote ?? profile?.statusDetail ?? profile?.status ?? 'profile data unavailable'),
        enrichNote: enrichNote ?? null,
        profileStatus: profile ? (p.status ?? null) : null,
        displayName: p.displayName ?? null,
        followers: p.followers ?? null,
        following: p.following ?? null,
        likes: p.likes ?? null,
        videos: p.videos ?? null,
        verified: p.verified ?? null,
        lastPostDate: p.lastPostDate ?? p.latestPostDate ?? p.lastVideoDate ?? p.latestVideoDate ?? null,
        daysSinceLastPost: p.daysSinceLastPost ?? p.daysSinceLastVideo ?? null,
        bio: p.bio ?? null,
        bioLink: p.bioLink ?? null,
        bioLinkDomain: (() => { try { return p.bioLink ? new URL(/^https?:\/\//i.test(p.bioLink) ? p.bioLink : `https://${p.bioLink}`).hostname.replace(/^www\./, '') : null; } catch { return null; } })(),
        emails: p.emails ?? [],
        region: p.region ?? null,
        language: p.language ?? null,
        medianViews: p.medianPlays ?? null,
        videosAnalyzed: p.videosAnalyzed ?? null,
        medianViewsPctOfFollowers: p.medianPlaysPctFollowers ?? null,
        postsPerWeek: p.postsPerWeek ?? null,
    };
}

// Default enrichment: runs the account's own profile Actor (profileOnly) and returns its profile rows by username.
// With { medianViews: true } the profile Actor runs in "full" mode (recent videos too) and its per-creator summary row
// (medianPlays over the recent videos) is merged into the profile row; otherwise it runs in profileOnly mode.
export async function callProfileActor(
    actorId,
    usernames,
    { medianViews = false, videosForMedian = 10, needLatestVideo = false, waitSecs = 45 } = {},
) {
    const full = medianViews || needLatestVideo;
    const videos = medianViews ? videosForMedian : 1;
    const perCreator = full ? videos + 3 : 1;
    const run = await Actor.call(
        actorId,
        {
            usernames,
            mode: full ? 'full' : 'profileOnly',
            ...(full ? { videosPerProfile: videos } : {}),
            maxItems: usernames.length * perCreator + 5,
            concurrency: 2,
        },
        { waitSecs: Math.max(10, Math.min(waitSecs, 100)), maxTotalChargeUsd: 0.20, restartOnError: false },
    );
    if (!run?.defaultDatasetId) throw new Error(`Run of ${actorId} returned no dataset (status ${run?.status})`);
    const terminal = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
    if (run.id && !terminal.has(run.status)) {
        log.warning(`Profile child ${run.id} did not finish within ${waitSecs}s (status ${run.status}); aborting it and using any partial dataset rows.`);
        await Actor.apifyClient.run(run.id).abort().catch(() => null);
    }
    const { items } = await Actor.apifyClient
        .dataset(run.defaultDatasetId)
        .listItems({ limit: usernames.length * perCreator + 10 });
    const byName = new Map();
    const summaries = new Map();
    const latest = new Map();
    for (const item of items) {
        const name = String(item.username ?? '').toLowerCase();
        if (!name) continue;
        if (item.rowType === 'profile') byName.set(name, item);
        else if (item.rowType === 'summary') summaries.set(name, item);
        else if (item.rowType === 'video' && item.videoUrl && (item.rankNewest === 1 || !latest.has(name)))
            latest.set(name, item);
    }
    for (const [name, row] of byName) {
        const s = summaries.get(name);
        if (latest.has(name)) {
            const v = latest.get(name);
            const lastPostDate = v.createdAt ?? v.createTimeISO ?? v.postedAt ?? v.date ?? null;
            let daysSinceLastPost = null;
            if (lastPostDate) { const ms = Date.parse(lastPostDate); if (Number.isFinite(ms)) daysSinceLastPost = Math.max(0, Math.floor((Date.now() - ms) / 86400000)); }
            byName.set(name, { ...byName.get(name), latestVideoUrl: v.videoUrl, lastPostDate, daysSinceLastPost });
        }
        if (s)
            byName.set(name, {
                ...byName.get(name),
                medianPlays: s.medianPlays ?? null,
                videosAnalyzed: s.videosAnalyzed ?? null,
                medianPlaysPctFollowers: s.medianPlaysPctFollowers ?? null,
                postsPerWeek: s.postsPerWeek ?? null,
            });
    }
    return byName;
}

export async function runSearch({
    input,
    pushData,
    serpProxyUrl,
    serpFetch,
    engines,
    enrich = callProfileActor,
    readPlace = fetchVideoPlace,
    shouldStop = () => false,
    now = () => Date.now(),
}) {
    // Bound enrichment by both call count and remaining runtime.
    let profileCalls = 0;
    const budgetedEnrich = async (...args) => {
        if (profileCalls >= MAX_PROFILE_CALLS) throw new Error('Nested profile enrichment call limit reached; skipping further calls.');
        profileCalls += 1;
        return enrich(...args);
    };
    const startedMs = now();
    const started = new Date(startedMs).toISOString();
    const elapsed = () => Math.max(0, (now() - startedMs) / 1000);
    const secondsLeft = () => input.maxRunSeconds - elapsed();
    const outOfTime = () => shouldStop() || secondsLeft() < 25;
    const report = { queries: [], blocked: false, stoppedOnTime: false, requestedMaxSearchSeconds: input.maxSearchSeconds, effectiveMaxSearchSeconds: input.maxSearchSeconds };
    const known = new Set(input.knownHandles ?? []);
    let nextSearchIndex = input.resumeIndex ?? 0;
    const seen = new Map();
    const processed = new Set();
    const emitted = new Set();
    const rows = [];
    let enrichNote = null;
    let rateLimitedOrUnavailable = 0;
    let skippedByHint = 0;
    let skippedKnownHandles = 0;
    const skippedKnown = new Set();
    const counts = {
        returned: 0, passing: 0, outOfRange: 0, unknownFilter: 0, unenriched: 0, profileProblems: 0,
        locationMatches: 0, locationMismatches: 0, errors: 0,
    };

    log.info(`[${RUNTIME_FIX_VERSION}] Bounded runtime ${input.maxRunSeconds}s, per-query ${input.maxSearchSeconds}s; hashtagsFirst=${input.hashtagsFirst}; criteriaOnly=${input.criteriaOnly}; resume index=${nextSearchIndex}.`);

    const makeRow = (c, profile, note = null) => {
        const row = creatorRow(c, profile, profile ? null : (note ?? (input.enrichProfiles ? 'the profile Actor returned no row for this handle' : 'enrichProfiles is off')));
        if (input.criteriaOnly) row.matchedQuery = 'criteria';
        const { passes, failures } = checkFilters(row, input);
        row.passesFilters = passes;
        row.filterFailures = failures;
        Object.assign(row, matchRegionLanguage(row, input));
        row.regionSource = row.region ? 'profile' : null;
        return row;
    };
    const countRow = (row, profile) => {
        if (!profile || row.enrichStatus !== 'ok') counts.unenriched += 1;
        else if (row.profileStatus !== 'ok') counts.profileProblems += 1;
        if (row.passesFilters === true) counts.passing += 1;
        else if (row.passesFilters === false) counts.outOfRange += 1;
        else counts.unknownFilter += 1;
        if (row.locationMatch === true) counts.locationMatches += 1;
        if (row.locationMatch === false) counts.locationMismatches += 1;
    };
    const emitRow = async (row, force = false) => {
        if (emitted.has(row.handle) || counts.returned >= input.maxCreators) return false;
        if (!force && input.onlyPassing && row.passesFilters !== true) return false;
        if (!force && input.matchMode === 'only' && row.locationMatch === false) return false;
        await pushData(row);
        emitted.add(row.handle);
        counts.returned += 1;
        return true;
    };
    const hintFailure = (c) => {
        const n = parseFollowerHint(c.hint);
        if (n == null) return null;
        if (input.minFollowers != null && n < input.minFollowers) return { n, reason: `search follower hint ${n} below ${input.minFollowers}` };
        if (input.maxFollowers != null && n > input.maxFollowers) return { n, reason: `search follower hint ${n} above ${input.maxFollowers}` };
        return null;
    };
    const processCandidates = async (candidates) => {
        const fresh = orderCandidates(candidates.filter((c) => !processed.has(c.handle) && !known.has(c.handle)), input)
            .slice(0, Math.max(0, input.maxCreators * 10 - processed.size));
        for (let i = 0; i < fresh.length && !outOfTime(); i += BATCH) {
            // Preserve unscreened handles for a later run rather than treating the call cap as a profile failure.
            if (input.enrichProfiles && profileCalls >= MAX_PROFILE_CALLS) break;
            if (input.enrichProfiles && secondsLeft() < 35) break; // leave time to save summary
            const rawBatch = fresh.slice(i, i + BATCH);
            const enrichable = [];
            for (const c of rawBatch) {
                const hf = hintFailure(c);
                if (hf && input.enrichProfiles && (input.maxFollowers != null && hf.n > input.maxFollowers)) {
                    skippedByHint += 1;
                    const row = makeRow(c, null, `profile enrichment skipped because ${hf.reason}`);
                    row.followers = null;
                    row.passesFilters = false;
                    row.filterFailures = [hf.reason];
                    row.skippedByFollowerHint = true;
                    rows.push(row);
                    countRow(row, null);
                    await emitRow(row);
                    processed.add(c.handle);
                } else enrichable.push(c);
            }
            if (!enrichable.length) continue;
            if (!input.enrichProfiles) {
                for (const c of enrichable) {
                    const row = makeRow(c, null);
                    rows.push(row); countRow(row, null); await emitRow(row); processed.add(c.handle);
                }
                continue;
            }
            const names = enrichable.map((c) => c.handle);
            log.info(`[${RUNTIME_FIX_VERSION}] Profile screening batch: ${names.length} creator(s) [${names.join(', ')}].`);
            // A single full-mode call provides followers, verification, latest activity and
            // the ten-video median together. Avoid the former profileOnly + full two-call
            // sequence, which exhausted the call allowance after one batch.
            let full = new Map();
            try {
                full = await budgetedEnrich(input.profileActor, names, {
                    medianViews: true,
                    videosForMedian: 10,
                    needLatestVideo: true,
                    waitSecs: Math.max(30, Math.min(100, Math.floor(secondsLeft() - 20))),
                });
            } catch (error) {
                enrichNote = `Full profile enrichment failed for batch: ${String(error?.message ?? error)}`;
                counts.errors += 1;
                log.warning(enrichNote);
            }
            log.info(`[${RUNTIME_FIX_VERSION}] Full profile batch: ${[...full.values()].filter((p) => p?.status === 'ok').length}/${names.length} profile(s) retrieved; applying all strict filters.`);
            for (const c of enrichable) {
                const profile = full.get(c.handle) ?? null;
                if (profile && input.regions.length && !profile.region) {
                    const url = profile.latestVideoUrl ?? c.videoUrls?.[0];
                    if (url) try {
                        const place = await readPlace(url);
                        if (place?.region) { profile.region = place.region; profile.language ??= place.language; profile.__regionSource = 'latest video'; }
                    } catch { /* unknown remains null */ }
                }
                const row = makeRow(c, profile, enrichNote);
                if (profile?.status !== 'ok' || profile?.medianPlays == null || profile?.daysSinceLastPost == null) {
                    row.dataAvailability = 'incomplete';
                    row.dataAvailabilityReason = !profile ? 'profile not retrieved' : profile.status !== 'ok' ? 'profile retrieval failed' : 'video metrics or latest-post date unavailable';
                    rateLimitedOrUnavailable += 1;
                } else {
                    row.dataAvailability = 'complete';
                    row.dataAvailabilityReason = null;
                }
                if (profile?.__regionSource) row.regionSource = profile.__regionSource;
                rows.push(row); countRow(row, profile); await emitRow(row); processed.add(c.handle);
            }
        }
    };

    const explicitCandidateFeed = input.candidateFeed.length > 0;
    const suppliedCandidates = fromCandidateFeed(input.candidateFeed, [...known]);
    if (suppliedCandidates.length) {
        for (const candidate of suppliedCandidates) seen.set(candidate.handle, candidate);
        log.info('Offline candidate feed: ' + suppliedCandidates.length + ' new handles (no search request).');
        await processCandidates(suppliedCandidates);
    }
    if (input.discoverySource === 'creativeCenter' && !explicitCandidateFeed) {
        const free = await discoverFromCreativeCenter({ known: [...known] });
        report.freeDiscovery = free.diagnostics;
        for (const candidate of free.candidates) seen.set(candidate.handle, candidate);
        log.info('Creative Center public pages: ' + free.candidates.length + ' new candidate handles.');
        await processCandidates(free.candidates);
    }
    for (let searchIndex = nextSearchIndex; searchIndex < (explicitCandidateFeed || input.discoverySource === 'creativeCenter' ? 0 : input.searches.length); searchIndex += 1) {
        const keyword = input.searches[searchIndex];
        if (outOfTime() || (counts.returned >= input.maxCreators && input.onlyPassing)) break;
        // Stop discovery once there is a useful pool; the expensive step is verifying profiles.
        const waiting = [...seen.values()].filter((c) => !processed.has(c.handle) && !known.has(c.handle)).length;
        if (input.enrichProfiles && waiting >= 20) {
            log.info(`[${RUNTIME_FIX_VERSION}] Discovery pool has ${waiting} unprocessed candidates; switching to profile screening.`);
            break;
        }
        // Spend at most ~60 seconds discovering; reserve the remainder for screening.
        if (input.enrichProfiles && secondsLeft() < Math.max(120, input.maxRunSeconds - 60)) break;
        const remainingSearchSeconds = Math.max(1, Math.min(input.maxSearchSeconds, input.enrichProfiles ? 15 : 45, Math.floor(secondsLeft() - (input.enrichProfiles ? Math.max(120, input.maxRunSeconds - 90) : 25))));
        const localReport = { queries: [], blocked: false, stoppedOnTime: false };
        const { candidates } = await discoverCreators({
            keywords: [keyword], excludeWords: input.excludeWords, maxPages: input.maxSearchPages,
            maxSeconds: remainingSearchSeconds, modifiers: input.searchModifiers, serpProxyUrl, serpFetch, engines,
            report: localReport, shouldContinue: () => !outOfTime(),
            log: (m) => log.info(m),
        });
        report.queries.push(...localReport.queries);
        report.blocked ||= localReport.blocked;
        report.stoppedOnTime ||= localReport.stoppedOnTime;
        for (const c of candidates) {
            if (known.has(c.handle) && !skippedKnown.has(c.handle)) { skippedKnown.add(c.handle); skippedKnownHandles += 1; }
            const old = seen.get(c.handle);
            if (!old) seen.set(c.handle, c);
            else {
                old.queries = [...new Set([...(old.queries ?? []), ...(c.queries ?? [])])];
                old.timesSeen = (old.timesSeen ?? 0) + (c.timesSeen ?? 0);
                old.profileHit ||= c.profileHit;
                old.hint ??= c.hint;
                old.snippets = [...new Set([...(old.snippets ?? []), ...(c.snippets ?? [])])].slice(0, 3);
                old.videoUrls = [...new Set([...(old.videoUrls ?? []), ...(c.videoUrls ?? [])])].slice(0, 5);
            }
        }
        const newlyFound = [...seen.values()].filter((c) => c.queries?.includes(keyword) && !processed.has(c.handle) && !known.has(c.handle));
        log.info(`[${RUNTIME_FIX_VERSION}] "${keyword}": ${candidates.length} handle(s) found; queued ${newlyFound.length} candidate(s) for cross-query ranking.`);
        // Search completion means discovery completed, not that every candidate was enriched.
        if (!localReport.stoppedOnTime) nextSearchIndex = searchIndex + 1;
        else break;
    }

    // Rank all discovered candidates together; otherwise the first hashtag consumes
    // every enrichment slot and later keywords never get a fair opportunity.
    if (!explicitCandidateFeed && input.discoverySource !== 'creativeCenter' && !outOfTime()) {
        const pool = [...seen.values()].filter((c) => !processed.has(c.handle) && !known.has(c.handle));
        log.info(`[${RUNTIME_FIX_VERSION}] Cross-query candidate pool: ${pool.length} handles from ${report.queries.length} search attempts; enriching best-ranked candidates.`);
        await processCandidates(pool);
    }

    // Rank zero-pass diagnostics by normalized distance to the requested numeric bounds, not by follower size.
    let nearMissesReturned = 0;
    if (!input.onlyPassing && counts.returned === 0 && rows.length) {
        const distance = (row) => {
            const parts = [];
            const add = (v, min, max, label) => {
                if (v == null) return;
                if (min != null && v < min) parts.push({ d: (min - v) / Math.max(min, 1), reason: `${label} ${v} is ${min - v} below minimum ${min}` });
                if (max != null && v > max) parts.push({ d: (v - max) / Math.max(max, 1), reason: `${label} ${v} is ${v - max} above maximum ${max}` });
            };
            add(row.followers, input.minFollowers, input.maxFollowers, 'followers');
            add(row.medianViews, input.minMedianViews, input.maxMedianViews, 'median views');
            if (!parts.length && row.skippedByFollowerHint) return { score: 10, reason: row.filterFailures?.[0] ?? 'outside follower range by search hint' };
            if (!parts.length) return { score: 9, reason: 'required filter value was unavailable' };
            parts.sort((a, b) => a.d - b.d);
            return { score: parts.reduce((a, p) => a + p.d, 0), reason: parts.map((p) => p.reason).join('; ') };
        };
        const ranked = rows.map((row) => ({ row, ...distance(row) })).sort((a, b) => a.score - b.score).slice(0, 5);
        for (const { row, reason, score } of ranked) {
            const diagnostic = { ...row, recordType: 'near_miss', nearMiss: true, nearMissReason: reason, nearMissScore: Number(score.toFixed(4)) };
            if (await emitRow(diagnostic, true)) nearMissesReturned += 1;
        }
    }

    const searchedKeywords = report.queries.filter((q) => q.attempts?.length).map((q) => q.keyword);
    const keywordYield = input.searches.map((keyword) => {
        const matched = rows.filter((r) => r.queriesMatched?.includes(keyword));
        return {
            keyword,
            handlesFound: [...seen.values()].filter((c) => c.queries?.includes(keyword)).length,
            processed: matched.length,
            inRange: matched.filter((r) => r.passesFilters === true).length,
            passing: matched.filter((r) => r.passesFilters === true && (input.matchMode !== 'only' || r.locationMatch !== false)).length,
        };
    });
    const summary = {
        screeningDecisions: rows.map((r) => ({ handle: r.handle, passesFilters: r.passesFilters, enrichStatus: r.enrichStatus, filterFailures: r.filterFailures, dataAvailability: r.dataAvailability ?? 'unknown', dataAvailabilityReason: r.dataAvailabilityReason ?? null })),
        incompleteDataProfiles: rateLimitedOrUnavailable,
        activeFilters: { minFollowers: input.minFollowers, maxFollowers: input.maxFollowers, minMedianViews: input.minMedianViews, maxDaysSinceLastPost: input.maxDaysSinceLastPost, excludeVerified: input.excludeVerified },
        recordType: 'RUN_SUMMARY', version: RUNTIME_FIX_VERSION, startedAt: started, finishedAt: new Date(now()).toISOString(),
        searches: input.searches, keywordsDone: searchedKeywords, keywordsRequested: input.searches.length, keywordsCompleted: searchedKeywords.length,
        handlesFound: seen.size, candidatesSelected: processed.size, creatorsProcessed: rows.length, skippedByHint, skippedKnownHandles,
        knownHandlesSupplied: known.size, seedHandlesSupplied: input.seedHandles.length, keywordYield,
        ...counts, nearMissesReturned, enrichNote,
        failedByReason: {
            followers: rows.filter((r) => r.filterFailures?.some((x) => x.startsWith('followers') || x.includes('follower hint'))).length,
            views: rows.filter((r) => r.filterFailures?.some((x) => x.startsWith('median views'))).length,
            inactive: rows.filter((r) => r.filterFailures?.some((x) => x.startsWith('inactive'))).length,
            verifiedCelebrity: rows.filter((r) => r.filterFailures?.includes('verified/celebrity')).length,
            enrichment: rows.filter((r) => r.enrichStatus === 'failed').length,
        },
        stoppedEarly: outOfTime() || nextSearchIndex < input.searches.length,
        searchVariantsAttempted: report.queries.reduce((total, q) => total + (q.attempts?.length ?? 0), 0),
        searchVariantsPlanned: input.criteriaOnly ? 6 : input.searches.length * 3,
        searchVariantsExhausted: input.criteriaOnly ? report.queries.some((q) => (q.attempts?.length ?? 0) >= 6) : null,
        nextSearchIndex,
        resumeToken: nextSearchIndex < input.searches.length ? { nextSearchIndex, processedHandles: [...new Set([...(input.priorProcessed ?? []), ...rows.map((r) => r.handle)])] } : null,
        runtimeBudgetSeconds: input.maxRunSeconds,
        search: report, estimatedCostUsd: null, billedEvents: null,
        estimatedCostNote: 'Exact run cost and billed events are not available authoritatively inside the Actor; use the Apify run billing/usage record.',
        note: 'Creators come from public search-engine indexing; this is not an exhaustive or statistically unbiased sample of TikTok. The Actor may return fewer than requested if discovery or enrichment is limited.',
    };
    await pushData(summary);
    log.info(`[${RUNTIME_FIX_VERSION}] RUN_SUMMARY written: processed=${summary.creatorsProcessed}, skippedByHint=${skippedByHint}, returned=${summary.returned}, stoppedEarly=${summary.stoppedEarly}.`);
    return summary;
}

async function main() {
    await Actor.init();
    let stop = false;
    Actor.on('aborting', async () => {
        stop = true;
        await new Promise((resolve) => {
            setTimeout(resolve, 1000);
        });
        await Actor.exit();
    });
    try {
        log.info(`[${RUNTIME_FIX_VERSION}] TikTok Creator Search runtime-safe build active; child enrichment batch size=${BATCH}.`);
        const input = readInput(await Actor.getInput());
        let rejectionCache = {};
        let historyStore = null;
        let previousHandles = [];
        if (input.rememberProcessedHandles) {
            try {
                historyStore = await Actor.openKeyValueStore('tiktok-creator-search-history');
                const stored = await historyStore.getValue('REJECTED_HANDLES_V1');
                const cutoff = Date.now() - 30 * 86400000;
                rejectionCache = Object.fromEntries(Object.entries(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}).filter(([, v]) => Number(v?.at) > cutoff));
                input.knownHandles = [...new Set([...input.knownHandles, ...Object.keys(rejectionCache)])];
                log.info('Cached stable rejections: ' + Object.keys(rejectionCache).length);
                const history = await historyStore.getValue('PROCESSED_HANDLES');
                previousHandles = Array.isArray(history) ? history.filter((h) => typeof h === 'string') : [];
                input.knownHandles = [...new Set([...input.knownHandles, ...previousHandles])];
                log.info('Persistent history loaded: ' + previousHandles.length + ' handles.');
            } catch (error) {
                historyStore = null;
                log.warning('History unavailable: ' + String(error?.message ?? error));
            }
        }
        // Brave Search needs no proxy; the Google SERP proxy, when the account has it, is the fallback engine.
        const serp = await Actor.createProxyConfiguration({ groups: ['GOOGLE_SERP'] }).catch(() => null);
        const serpProxyUrl = serp ? await serp.newUrl() : null;
        const summary = await runSearch({
            input,
            pushData: (row) => Actor.pushData(row),
            serpProxyUrl,
            engines: defaultEngines({ serpProxyUrl }),
            shouldStop: () => stop,
        });
        if (historyStore) {
            try {
                const { items } = await (await Actor.openDataset()).getData({ limit: 1000 });
                const confirmed = items.filter((r) => r.recordType === 'creator' && r.enrichStatus === 'ok').map((r) => r.handle);
                const rejected = Object.fromEntries((summary.screeningDecisions ?? []).filter((r) => r.passesFilters === false && r.enrichStatus === 'ok' && r.filterFailures?.some((x) => x.startsWith('followers') || x === 'verified/celebrity')).map((r) => [r.handle, { at: Date.now() }]));
                await historyStore.setValue('REJECTED_HANDLES_V1', { ...rejectionCache, ...rejected });
                const merged = [...new Set([...previousHandles, ...input.knownHandles, ...confirmed])].slice(-5000);
                await historyStore.setValue('PROCESSED_HANDLES', merged);
                log.info('Persistent history saved: ' + merged.length + ' handles (including supplied exclusions and newly qualified creators).');
            } catch (error) {
                log.warning('History save failed: ' + String(error?.message ?? error));
            }
        }
        delete summary.screeningDecisions;
        await Actor.setValue('OUTPUT', summary);
        await Actor.setValue('RESUME_TOKEN', summary.resumeToken);
        log.info(`Done: ${summary.handlesFound} creators found, ${summary.returned} creator/near-miss row(s) returned; ${summary.creatorsProcessed} processed.`);
    } catch (error) {
        log.error(String(error?.message ?? error));
        await Actor.fail(String(error?.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    await main();
}
