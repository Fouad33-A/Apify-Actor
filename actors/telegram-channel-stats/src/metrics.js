// Channel figures computed from the posts the preview page showed. A figure that needs at least 3 posts carrying
// the data is null otherwise; nothing is estimated.

const DAY = 86_400_000;

export function median(values) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const round = (n, digits = 2) => (n == null ? null : Number(n.toFixed(digits)));

// posts: parsed posts (parsePreviewPage), any order. `exhausted` = the channel has no older posts than the ones read.
export function channelMetrics(
    posts,
    { members = null, windowDays = 30, freshHours = 24, exhausted = false, now = Date.now(), self = null } = {},
) {
    const byId = new Map();
    for (const p of posts) byId.set(p.id, p);
    const list = [...byId.values()].sort((a, b) => b.id - a.id);
    const dated = list.filter((p) => p.date);
    const times = dated.map((p) => Date.parse(p.date));
    const newest = times.length ? Math.max(...times) : null;
    const oldest = times.length ? Math.min(...times) : null;

    // Posting frequency: posts inside the window divided by the window, when the sample reaches back to the start of
    // the window (or the channel has nothing older). Otherwise the sample's own span is used and the basis says so.
    let postsPerWeek = null;
    let frequencyBasis = null;
    if (dated.length >= 3) {
        const windowStart = now - windowDays * DAY;
        if (oldest <= windowStart || exhausted) {
            const inWindow = times.filter((t) => t >= windowStart).length;
            postsPerWeek = round((inWindow / windowDays) * 7);
            frequencyBasis = `last ${windowDays} days`;
        } else {
            const spanDays = Math.max(1, (now - oldest) / DAY);
            postsPerWeek = round((dated.length / spanDays) * 7);
            frequencyBasis = `sample span (${round(spanDays, 1)} days; the post limit was reached before the ${windowDays}-day window)`;
        }
    }

    // Views grow for days after posting: very fresh posts are left out of the view statistics.
    const settled = list.filter(
        (p) => p.views != null && (!p.date || now - Date.parse(p.date) >= freshHours * 3_600_000),
    );
    const views = settled.map((p) => p.views);
    const enough = views.length >= 3;
    const medianViews = enough ? median(views) : null;

    const mentionCounts = new Map();
    for (const p of list) {
        for (const m of p.mentions ?? []) {
            if (m !== self) mentionCounts.set(m, (mentionCounts.get(m) ?? 0) + 1);
        }
    }
    const mentioned = [...mentionCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([username, postsMentioning]) => ({ username, postsMentioning }));

    return {
        postsSampled: list.length,
        newestPostDate: newest ? new Date(newest).toISOString() : null,
        oldestPostDate: oldest ? new Date(oldest).toISOString() : null,
        daysSinceLastPost: newest ? round((now - newest) / DAY, 1) : null,
        postsPerWeek,
        frequencyBasis,
        viewsPostsUsed: views.length,
        medianViews,
        meanViews: enough ? Math.round(views.reduce((s, v) => s + v, 0) / views.length) : null,
        minViews: enough ? Math.min(...views) : null,
        maxViews: enough ? Math.max(...views) : null,
        medianViewsPctOfMembers: enough && members > 0 ? round((medianViews / members) * 100) : null,
        forwardedPostsPct: list.length ? round((list.filter((p) => p.forwarded).length / list.length) * 100, 1) : null,
        mentionedAccounts: mentioned,
    };
}
