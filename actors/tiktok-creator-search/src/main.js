import { Actor, log } from 'apify';

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
};

export function readInput(raw) {
    const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)) };
    const keywords = (input.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
    const hashtags = (input.hashtags ?? [])
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
    return { ...input, searches: [...keywords, ...hashtags] };
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

export function checkFilters(row, { minFollowers, maxFollowers }) {
    const failures = [];
    if (row.followers == null) return { passes: null, failures };
    if (minFollowers != null && row.followers < minFollowers)
        failures.push(`followers ${row.followers} below ${minFollowers}`);
    if (maxFollowers != null && row.followers > maxFollowers)
        failures.push(`followers ${row.followers} above ${maxFollowers}`);
    return { passes: failures.length === 0, failures };
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
    };
}

// Default enrichment: runs the account's own profile Actor (profileOnly) and returns its profile rows by username.
export async function callProfileActor(actorId, usernames) {
    const run = await Actor.call(
        actorId,
        { usernames, mode: 'profileOnly', maxItems: usernames.length + 5, concurrency: 2 },
        { waitSecs: 600 },
    );
    if (!run?.defaultDatasetId) throw new Error(`Run of ${actorId} returned no dataset (status ${run?.status})`);
    const { items } = await Actor.apifyClient.dataset(run.defaultDatasetId).listItems({ limit: usernames.length + 10 });
    const byName = new Map();
    for (const item of items)
        if (item.rowType === 'profile' && item.username) byName.set(String(item.username).toLowerCase(), item);
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
                for (const [name, row] of await enrich(input.profileActor, names)) profiles.set(name, row);
            } catch (error) {
                enrichNote = `Profile enrichment failed: ${String(error?.message ?? error)}`;
                log.warning(enrichNote);
                break;
            }
        }
    }

    const counts = { returned: 0, passing: 0, outOfRange: 0, unenriched: 0, profileProblems: 0 };
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
        if (!profile) counts.unenriched += 1;
        else if (row.profileStatus !== 'ok') counts.profileProblems += 1;
        if (passes === true) counts.passing += 1;
        if (passes === false) counts.outOfRange += 1;
        if (input.onlyPassing && passes !== true) continue;
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
