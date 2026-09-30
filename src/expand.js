// Discovery without search: start from creators that are already known to fit ("seeds"), read their recent
// posts and comments (pages a logged-out visitor can see), and collect the accounts they mention, tag or
// interact with. Those accounts are the candidates: ranked by how often they appear, then looked up and screened.
//
// This file is the pure part (no browser): handle extraction, candidate ranking and screening. The flow that
// drives the browser lives in run.js.

// Handles that are paths or site features, never creators.
const RESERVED = new Set([
    'explore',
    'p',
    'reel',
    'reels',
    'tv',
    'stories',
    'accounts',
    'about',
    'directory',
    'legal',
    'privacy',
    'web',
    'direct',
    'tags',
    'locations',
    'instagram',
    'tiktok',
    'facebook',
    'username',
    'everyone',
    'all',
]);

const HANDLE = /^[a-z0-9_](?:[a-z0-9_.]{0,28}[a-z0-9_])?$/;

// "129" or "2.4k" is a like/comment count that was read as a name (seen live), not a creator. Purely numeric
// handles do exist on Instagram but are rare enough that dropping them costs less than looking up counts.
const COUNT_LIKE = /^\d[\d.,]*[km]?$/;

export function normalizeHandle(raw) {
    if (raw == null) return null;
    const h = String(raw).trim().replace(/^@/, '').toLowerCase();
    if (!HANDLE.test(h) || RESERVED.has(h) || COUNT_LIKE.test(h)) return null;
    return h;
}

// "@name" mentions in a caption or comment. Skips e-mail addresses (a@b.co) and trailing punctuation.
export function extractMentions(text) {
    if (!text) return [];
    const out = new Set();
    for (const m of String(text).matchAll(/(?<![A-Za-z0-9_.@])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)/g)) {
        const h = normalizeHandle(m[1]);
        if (h) out.add(h);
    }
    return [...out];
}

// events: [{ handle, signal, seed, postUrl }] -> ranked candidates.
// Candidates that are seeds or in `exclude` are dropped. Ranking: distinct seeds that led to it, then how often
// it appeared, then a mention (deliberate) outranks a mere comment; ties are broken alphabetically (stable).
export function rankCandidates(events, { seeds = [], exclude = [] } = {}) {
    const skip = new Set([...seeds, ...exclude].map((h) => normalizeHandle(h)).filter(Boolean));
    const byHandle = new Map();
    for (const e of events) {
        const handle = normalizeHandle(e.handle);
        if (!handle || skip.has(handle)) continue;
        let c = byHandle.get(handle);
        if (!c) {
            c = { handle, timesSeen: 0, signals: new Set(), seeds: new Set(), examples: [] };
            byHandle.set(handle, c);
        }
        c.timesSeen += 1;
        c.signals.add(e.signal);
        if (e.seed) c.seeds.add(e.seed);
        if (e.postUrl && c.examples.length < 3 && !c.examples.includes(e.postUrl)) c.examples.push(e.postUrl);
    }
    const weight = (c) => (c.signals.includes('mention') ? 1 : 0);
    return [...byHandle.values()]
        .map((c) => ({ ...c, signals: [...c.signals].sort(), seeds: [...c.seeds].sort() }))
        .sort(
            (a, b) =>
                b.seeds.length - a.seeds.length ||
                b.timesSeen - a.timesSeen ||
                weight(b) - weight(a) ||
                a.handle.localeCompare(b.handle),
        );
}

// Optional screening of a profile row. Returns { passes, failures }; passes is null when no criterion applies.
// It only reports facts about the row against the criteria given; it never guesses a missing value as a pass.
// includeReach=false is the first screen (before the post-based reach numbers exist).
export function applyScreening(row, criteria = {}, { includeReach = true } = {}) {
    const { minFollowers, maxFollowers, requireContactEmail, excludeBioPatterns, minReachPercent } = criteria;
    const patterns = (excludeBioPatterns ?? []).map((p) => String(p).trim().toLowerCase()).filter(Boolean);
    const reachActive = includeReach && minReachPercent != null;
    const active =
        minFollowers != null ||
        maxFollowers != null ||
        Boolean(requireContactEmail) ||
        patterns.length > 0 ||
        reachActive;
    if (!active) return { passes: null, failures: [] };

    const failures = [];
    if (row.status !== 'found') failures.push(`profile status is "${row.status}", not "found"`);
    if (minFollowers != null || maxFollowers != null) {
        if (row.followerCount == null) failures.push('follower count unknown');
        else {
            if (minFollowers != null && row.followerCount < minFollowers) {
                failures.push(`followers ${row.followerCount} below ${minFollowers}`);
            }
            if (maxFollowers != null && row.followerCount > maxFollowers) {
                failures.push(`followers ${row.followerCount} above ${maxFollowers}`);
            }
        }
    }
    if (requireContactEmail && !(row.contactEmails ?? []).length) failures.push('no contact email in the bio');
    if (patterns.length) {
        // The bio, the links in it, and (when followed) the destinations behind link-in-bio pages.
        const haystack = [row.bio, ...(row.externalLinks ?? []), ...(row.bioLinkTargets ?? [])]
            .filter(Boolean)
            .join(' \n ')
            .toLowerCase();
        for (const p of patterns) if (haystack.includes(p)) failures.push(`bio or link contains "${p}"`);
    }
    if (reachActive) {
        if (row.reachPctOfFollowers == null) failures.push('reach could not be computed (too few posts with counts)');
        else if (row.reachPctOfFollowers < minReachPercent) {
            failures.push(`reach ${row.reachPctOfFollowers}% of followers is below ${minReachPercent}%`);
        }
    }
    return { passes: failures.length === 0, failures };
}
