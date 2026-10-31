// The Marketing Agent's mechanical score (approved criteria, 2026-10-01). Pure functions, no browser.
//
//   B1 not monetised (20)   no shop/course/coaching link, and at most 1 sponsored post in the last 10
//   B2 engagement (15)      median (likes + comments) of the last 10 posts as % of followers: >=2% 15, 1-2% 7, <1% 0
//   B3 size (10)            50k-100k 10, 20k-<50k 8, 10k-<20k 5, above 100k 0
//   B4 reachable (10)       a public e-mail in the bio, a link-in-bio page or the creator's own website
//   B5 activity (5)         3 or more posts per week over the last 30 days
//
// A rule whose data the platform did not show is "unknown": it is listed, never guessed. On the platforms named in
// `unknownFullScorePlatforms` (TikTok, by the Agent's decision) an unknown rule is given its full points, marked as
// unknown, so the Agent can fill it in by hand; everywhere else it counts 0 and carries a "check by hand" warning.

import { median } from './reach.js';

export const DEFAULT_SCORECARD = {
    agencyEmailPatterns: [
        'management',
        'mgmt',
        'talent',
        'agency',
        'represent',
        'entertainment',
        'collective',
        'artists',
        'viralnation',
        'bookings',
    ],
    monetisationPatterns: [
        'shop',
        'store',
        'merch',
        'etsy',
        'checkout',
        'liketoknow',
        'ltk.',
        'course',
        'coaching',
        'mentorship',
    ],
    warnPatterns: [],
    maxSponsoredPosts: 1,
    unknownFullScorePlatforms: ['tiktok'],
    minScore: null,
};

// points of the first [minimum, points] step the value reaches (steps listed highest first), else 0
const tier = (value, steps) => steps.find(([min]) => value >= min)?.[1] ?? 0;
const lower = (list) => (list ?? []).map((p) => String(p).trim().toLowerCase()).filter(Boolean);
const DAY = 86_400_000;

// #ad, #sponsored, #paidpartnership or the words "paid partnership" in the caption, or the platform's own flag.
export function isSponsoredPost(post) {
    if (post?.isSponsored === true) return true;
    const caption = String(post?.caption ?? '');
    return /(^|[^\w])#(ad|sponsored|paidpartnership)\b/i.test(caption) || /paid partnership/i.test(caption);
}

// A3: e-mail addresses written in the BIO that look like a management/agency address. Returns [{ email, pattern }].
export function agencyEmails(emails, patterns) {
    const pats = lower(patterns);
    const out = [];
    for (const email of emails ?? []) {
        const e = String(email).toLowerCase();
        const hit = pats.find((p) => e.includes(p));
        if (hit) out.push({ email, pattern: hit });
    }
    return out;
}

// Words that only raise a warning (not a fail): found in the bio, the links or the creator's site text.
export function warnHits(row, patterns) {
    const pats = lower(patterns);
    if (!pats.length) return [];
    const siteText = (row.creatorSites ?? []).map((s) =>
        [s.url, s.title, s.description, s.text].filter(Boolean).join(' '),
    );
    const hay = [row.bio, ...(row.externalLinks ?? []), ...(row.bioLinkTargets ?? []), ...siteText]
        .filter(Boolean)
        .join(' \n ')
        .toLowerCase();
    return pats.filter((p) => hay.includes(p));
}

// Facts from the sampled posts (post rows): sponsored count, engagement, posting rate. Nothing is guessed: a figure
// needs at least 3 posts that carry the data, otherwise it is null.
export function postStats(posts, followerCount, { now = Date.now() } = {}) {
    const list = (posts ?? []).filter((p) => (p.status ?? 'found') === 'found');
    const readable = list.filter((p) => p.caption != null || p.isSponsored === true);
    const sponsoredPosts = readable.length >= 3 ? readable.filter(isSponsoredPost).length : null;

    const withLikes = list.filter((p) => Number.isFinite(p.likeCount));
    let medianInteractions = null;
    let engagementPct = null;
    if (withLikes.length >= 3) {
        medianInteractions = median(
            withLikes.map((p) => p.likeCount + (Number.isFinite(p.commentCount) ? p.commentCount : 0)),
        );
        if (followerCount > 0) engagementPct = Number(((medianInteractions / followerCount) * 100).toFixed(2));
    }

    let postsPerWeek = null;
    const dates = list.map((p) => Date.parse(p.publishDate)).filter(Number.isFinite);
    if (dates.length >= 3) {
        const oldest = Math.min(...dates);
        const windowDays = Math.min(30, Math.max(7, (now - oldest) / DAY));
        const inWindow = dates.filter((d) => d >= now - windowDays * DAY).length;
        postsPerWeek = Number(((inWindow / windowDays) * 7).toFixed(2));
    }
    return {
        postsReadForScore: list.length,
        sponsoredPosts,
        medianInteractions,
        engagementPctOfFollowers: engagementPct,
        postsPerWeek,
    };
}

function monetisationHits(row, patterns) {
    const pats = lower(patterns);
    const siteText = (row.creatorSites ?? []).map((s) => [s.url, s.title, s.text].filter(Boolean).join(' '));
    const hay = [...(row.externalLinks ?? []), ...(row.bioLinkTargets ?? []), ...siteText].join(' \n ').toLowerCase();
    return pats.filter((p) => hay.includes(p));
}

// Scores one profile that passed the hard filters. `row` must already carry the post stats (postStats) and the
// contact e-mails. Returns { scorecard, scoreTotal, scoreMax, scoreUnknownRules, scoreWarnings, failures }.
export function scoreRow(row, { platform, config = {} } = {}) {
    const cfg = { ...DEFAULT_SCORECARD, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v != null)) };
    const full = lower(cfg.unknownFullScorePlatforms).includes(String(platform ?? '').toLowerCase());
    const rules = {};
    const unknown = [];
    const warnings = [];
    const followers = row.followerCount;

    const setKnown = (id, max, points, value) => {
        rules[id] = { points, max, value, unknown: false };
    };
    const setUnknown = (id, max, value, why) => {
        const points = full ? max : 0;
        rules[id] = {
            points,
            max,
            value,
            unknown: true,
            note: full ? 'unknown: full points given' : 'unknown: counted as 0',
        };
        unknown.push(id);
        warnings.push(`${id} ${why}: ${full ? 'given full points' : 'counted as 0'}, check by hand`);
    };

    // B1
    const shops = monetisationHits(row, cfg.monetisationPatterns);
    if (shops.length) {
        setKnown('B1', 20, 0, `shop/course/coaching link ("${shops.join('", "')}")`);
    } else if (row.sponsoredPosts == null) {
        setUnknown(
            'B1',
            20,
            'no shop link found; sponsored posts unknown',
            'sponsored posts could not be counted (too few posts read)',
        );
    } else if (row.sponsoredPosts > cfg.maxSponsoredPosts) {
        setKnown(
            'B1',
            20,
            0,
            `${row.sponsoredPosts} sponsored posts in the last ${row.postsReadForScore} (max ${cfg.maxSponsoredPosts})`,
        );
    } else {
        setKnown(
            'B1',
            20,
            20,
            `no shop link, ${row.sponsoredPosts} sponsored post(s) in the last ${row.postsReadForScore}`,
        );
    }

    // B2
    const eng = row.engagementPctOfFollowers;
    if (eng == null) {
        setUnknown(
            'B2',
            15,
            'engagement not computed',
            'engagement not computed (likes hidden by the creator, or too few posts read)',
        );
    } else {
        const points = tier(eng, [
            [2, 15],
            [1, 7],
        ]);
        setKnown('B2', 15, points, `${eng}% of followers (median likes + comments of ${row.postsReadForScore} posts)`);
    }

    // B3
    if (followers == null) {
        setUnknown('B3', 10, 'follower count unknown', 'follower count unknown');
    } else {
        const points =
            followers > 100_000
                ? 0
                : tier(followers, [
                      [50_000, 10],
                      [20_000, 8],
                      [10_000, 5],
                  ]);
        setKnown('B3', 10, points, `${followers} followers`);
    }

    // B4 (known on every platform: an e-mail is either found or not)
    const emails = row.contactEmails ?? [];
    setKnown('B4', 10, emails.length ? 10 : 0, emails.length ? emails.join(', ') : 'no public e-mail found');

    // B5
    if (row.postsPerWeek == null) {
        setUnknown(
            'B5',
            5,
            'posting rate not computed',
            'posting rate not computed (post dates not shown, or too few posts read)',
        );
    } else {
        setKnown('B5', 5, row.postsPerWeek >= 3 ? 5 : 0, `${row.postsPerWeek} posts per week`);
    }

    const total = Object.values(rules).reduce((s, r) => s + r.points, 0);
    const max = Object.values(rules).reduce((s, r) => s + r.max, 0);
    const failures = [];
    if (cfg.minScore != null && total < cfg.minScore)
        failures.push(`score ${total} of ${max} is below ${cfg.minScore}`);
    return {
        scorecard: rules,
        scoreTotal: total,
        scoreMax: max,
        scoreUnknownRules: unknown,
        scoreUnknownTreatedAsFull: full && unknown.length > 0,
        scoreWarnings: warnings,
        failures,
    };
}
