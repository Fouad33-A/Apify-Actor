import { Actor, log } from 'apify';

import { presetSearches } from './presets.js';
import { defaultEngines, discoverCreators, parseFollowerHint } from './serp.js';

const PROFILE_ACTOR = 'fouad_dp/tiktok-profile-video-stats';
const BATCH = 50; // the profile Actor takes 1-50 usernames per run

const DEFAULTS = {
    excludeWords: [],
    searchModifiers: [],
    maxSearchPages: 2,
    maxSearchSeconds: 300,
    maxCreators: 100,
    enrichProfiles: true,
    profileActor: PROFILE_ACTOR,
    onlyPassing: false,
    regions: [],
    languages: [],
    matchMode: 'prefer',
    examPresets: [],
    addMedianViews: false,
    videosForMedian: 10,
};

export function readInput(raw) {
    const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)) };
    const presets = presetSearches(input.examPresets);
    const keywords = [...(input.keywords ?? []), ...presets.keywords].map((k) => String(k).trim()).filter(Boolean);
    const hashtags = [...(input.hashtags ?? []), ...presets.hashtags]
        .map((h) => String(h).trim().replace(/^#+/, ''))
        .filter(Boolean)
        .map((h) => `#${h}`);
    if (!keywords.length && !hashtags.length)
        throw new Error('Give at least one keyword in "keywords" or one hashtag in "hashtags".');
    for (const key of ['maxSearchPages', 'maxSearchSeconds', 'maxCreators']) {
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
    const wantMedian = input.addMedianViews || input.minMedianViews != null || input.maxMedianViews != null;
    return {
        ...input,
        regions: upper(input.regions).map((r) => r.toUpperCase()),
        languages: upper(input.languages).map((l) => l.toLowerCase()),
        wantMedian,
        searches: [...new Set([...keywords, ...hashtags])],
    };
}

// Candidates in the order they are enriched: a search-snippet follower figure inside the wanted range first, unknown
// next, clearly outside last (only a hint: nothing is dropped because of it), then profile-page hits, then how often seen.
export function orderCandidates(candidates, { minFollowers = null, maxFollowers = null } = {}) {
    const fit = (c) => {
        const n = parseFollowerHint(c.hint);
        if (n == null || (minFollowers == null && maxFollowers == null)) return 1;
        return (minFollowers != null && n < minFollowers) || (maxFollowers != null && n > maxFollowers) ? 2 : 0;
    };
    return [...candidates].sort(
        (a, b) =>
            fit(a) - fit(b) ||
            Number(b.profileHit) - Number(a.profileHit) ||
            b.timesSeen - a.timesSeen ||
            a.handle.localeCompare(b.handle),
    );
}

export function checkFilters(row, { minFollowers, maxFollowers, minMedianViews, maxMedianViews }) {
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
    const asked = (minFollowers != null || maxFollowers != null ? ['followers'] : []).concat(
        minMedianViews != null || maxMedianViews != null ? ['medianViews'] : [],
    );
    // a creator is judged only when every figure the filters need is known (or a known figure already fails)
    if (failures.length) return { passes: false, failures };
    if (row.followers == null && row.medianViews == null) return { passes: null, failures };
    if (asked.some((a) => !judged.includes(a))) return { passes: null, failures };
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
        timesSeen: candidate.timesSeen,
        searchFollowerHint: candidate.hint ?? null,
        searchSnippets: candidate.snippets,
        sampleVideoUrls: candidate.videoUrls,
    };
    const p = profile ?? {};
    return {
        ...base,
        enriched: Boolean(profile),
        enrichNote: enrichNote ?? null,
        profileStatus: profile ? (p.status ?? null) : null,
        displayName: p.displayName ?? null,
        followers: p.followers ?? null,
        following: p.following ?? null,
        likes: p.likes ?? null,
        videos: p.videos ?? null,
        verified: p.verified ?? null,
        bio: p.bio ?? null,
        bioLink: p.bioLink ?? null,
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
export async function callProfileActor(actorId, usernames, { medianViews = false, videosForMedian = 10 } = {}) {
    const perCreator = medianViews ? videosForMedian + 3 : 1;
    const run = await Actor.call(
        actorId,
        {
            usernames,
            mode: medianViews ? 'full' : 'profileOnly',
            ...(medianViews ? { videosPerProfile: videosForMedian } : {}),
            maxItems: usernames.length * perCreator + 5,
            concurrency: 2,
        },
        { waitSecs: 900 },
    );
    if (!run?.defaultDatasetId) throw new Error(`Run of ${actorId} returned no dataset (status ${run?.status})`);
    const { items } = await Actor.apifyClient
        .dataset(run.defaultDatasetId)
        .listItems({ limit: usernames.length * perCreator + 10 });
    const byName = new Map();
    const summaries = new Map();
    for (const item of items) {
        const name = String(item.username ?? '').toLowerCase();
        if (!name) continue;
        if (item.rowType === 'profile') byName.set(name, item);
        else if (item.rowType === 'summary') summaries.set(name, item);
    }
    for (const [name, row] of byName) {
        const s = summaries.get(name);
        if (s)
            byName.set(name, {
                ...row,
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
    shouldStop = () => false,
}) {
    const started = new Date().toISOString();
    const report = { queries: [], blocked: false, stoppedOnTime: false };
    const { candidates } = await discoverCreators({
        keywords: input.searches,
        excludeWords: input.excludeWords,
        maxPages: input.maxSearchPages,
        maxSeconds: input.maxSearchSeconds,
        modifiers: input.searchModifiers,
        serpProxyUrl,
        serpFetch,
        engines,
        report,
        shouldContinue: () => !shouldStop(),
        log: (m) => log.info(m),
    });

    const ordered = orderCandidates(candidates, input).slice(0, input.maxCreators);
    const profiles = new Map();
    let enrichNote = null;
    if (input.enrichProfiles && ordered.length) {
        for (let i = 0; i < ordered.length && !shouldStop(); i += BATCH) {
            const names = ordered.slice(i, i + BATCH).map((c) => c.handle);
            try {
                for (const [name, row] of await enrich(input.profileActor, names, {
                    medianViews: input.wantMedian,
                    videosForMedian: input.videosForMedian,
                }))
                    profiles.set(name, row);
            } catch (error) {
                enrichNote = `Profile enrichment failed: ${String(error?.message ?? error)}`;
                log.warning(enrichNote);
                break;
            }
        }
    }

    const counts = {
        returned: 0,
        passing: 0,
        outOfRange: 0,
        unenriched: 0,
        profileProblems: 0,
        locationMatches: 0,
        locationMismatches: 0,
    };
    const rows = [];
    for (const c of ordered) {
        const profile = profiles.get(c.handle) ?? null;
        const row = creatorRow(
            c,
            profile,
            profile
                ? null
                : (enrichNote ??
                      (input.enrichProfiles
                          ? 'the profile Actor returned no row for this handle'
                          : 'enrichProfiles is off')),
        );
        const { passes, failures } = checkFilters(row, input);
        row.passesFilters = passes;
        row.filterFailures = failures;
        Object.assign(row, matchRegionLanguage(row, input));
        if (!profile) counts.unenriched += 1;
        else if (row.profileStatus !== 'ok') counts.profileProblems += 1;
        if (passes === true) counts.passing += 1;
        if (passes === false) counts.outOfRange += 1;
        if (row.locationMatch === true) counts.locationMatches += 1;
        if (row.locationMatch === false) counts.locationMismatches += 1;
        rows.push(row);
    }
    // "prefer": creators from the wanted countries / languages first, unknown next, confirmed others last. "only": the
    // confirmed others are left out (a creator whose location is not known is kept and marked locationMatch null).
    const locationRank = (r) => (r.locationMatch === true ? 0 : r.locationMatch === null ? 1 : 2);
    if (input.regions.length || input.languages.length) rows.sort((a, b) => locationRank(a) - locationRank(b));
    for (const row of rows) {
        if (input.onlyPassing && row.passesFilters !== true) continue;
        if (input.matchMode === 'only' && row.locationMatch === false) continue;
        await pushData(row);
        counts.returned += 1;
    }

    return {
        startedAt: started,
        finishedAt: new Date().toISOString(),
        searches: input.searches,
        handlesFound: candidates.length,
        ...counts,
        enrichNote,
        search: report,
        note: 'Creators come from Brave Search results (Google as a fallback) for the keywords and hashtags, because TikTok search itself is not available logged out. Search results vary from run to run, so a repeat run can find different creators; the search report lists every attempt. Follower figures come from the profile Actor, not from the search snippets.',
    };
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
        const input = readInput(await Actor.getInput());
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
        await Actor.setValue('OUTPUT', summary);
        log.info(`Done: ${summary.handlesFound} creators found, ${summary.returned} returned.`);
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
