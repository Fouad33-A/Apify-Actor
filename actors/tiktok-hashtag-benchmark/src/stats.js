export function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

const sortedNums = (xs) => xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);

export function summariseVideos(videos) {
    const views = sortedNums(videos.map((v) => v.views));
    if (!views.length) return null;
    const likes = sortedNums(videos.map((v) => v.likes));
    const comments = sortedNums(videos.map((v) => v.comments));
    const er = sortedNums(videos.filter((v) => v.views > 0).map((v) => (v.likes + v.comments + v.shares) / v.views));
    const dates = videos
        .map((v) => v.createdAt)
        .filter(Boolean)
        .sort();
    const regions = {};
    for (const v of videos) regions[v.region ?? 'unknown'] = (regions[v.region ?? 'unknown'] ?? 0) + 1;
    const median = percentile(views, 0.5);
    return {
        videosUsed: views.length,
        medianViews: median,
        meanViews: Math.round(views.reduce((a, b) => a + b, 0) / views.length),
        p25Views: percentile(views, 0.25),
        p75Views: percentile(views, 0.75),
        p90Views: percentile(views, 0.9),
        minViews: views[0],
        maxViews: views.at(-1),
        medianLikes: percentile(likes, 0.5),
        medianComments: percentile(comments, 0.5),
        medianEngagementRatePct: er.length
            ? Math.round(
                  percentile(
                      er.map((x) => x * 1e6),
                      0.5,
                  ),
              ) / 1e4
            : null,
        oldestVideo: dates[0] ?? null,
        newestVideo: dates.at(-1) ?? null,
        regions,
        viewTargets: { conservative: percentile(views, 0.25), typical: median, ambitious: percentile(views, 0.75) },
    };
}
