// Dataset rows: one per review (recordType "review") and one summary per app and country (recordType "app").

export function reviewRow(review, app, themeHits) {
    return {
        recordType: 'review',
        store: app.store,
        appId: app.appId,
        appName: app.name ?? null,
        country: app.country,
        reviewId: review.reviewId ?? null,
        rating: review.rating,
        title: review.title ?? null,
        text: review.text ?? null,
        author: review.author ?? null,
        date: review.date ?? null,
        version: review.version ?? null,
        helpfulVotes: review.helpfulVotes ?? null,
        developerReply: review.developerReply ?? null,
        themes: themeHits.map((h) => h.theme),
        themeMatches: Object.fromEntries(themeHits.map((h) => [h.theme, h.matched])),
        url: review.url ?? null,
    };
}

const clip = (s, n = 280) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

// themeCounts over the kept reviews, with up to 3 example quotes (most helpful first) per theme.
export function themeSummary(reviewsWithHits) {
    const byTheme = new Map();
    for (const { review, hits } of reviewsWithHits) {
        for (const h of hits) {
            const list = byTheme.get(h.theme) ?? [];
            list.push(review);
            byTheme.set(h.theme, list);
        }
    }
    const total = reviewsWithHits.length;
    return [...byTheme.entries()]
        .map(([theme, list]) => ({
            theme,
            reviews: list.length,
            pctOfKeptReviews: total ? Number(((list.length / total) * 100).toFixed(1)) : null,
            examples: [...list]
                .sort((a, b) => (b.helpfulVotes ?? 0) - (a.helpfulVotes ?? 0))
                .slice(0, 3)
                .map((r) => ({
                    rating: r.rating,
                    date: r.date,
                    text: clip([r.title, r.text].filter(Boolean).join(' – ')),
                })),
        }))
        .sort((a, b) => b.reviews - a.reviews || a.theme.localeCompare(b.theme));
}

export function appRow(app, details, result, kept, { maxRating, status = 'ok', statusDetail = null } = {}) {
    const themeCounts = themeSummary(kept);
    return {
        recordType: 'app',
        store: app.store,
        appId: app.appId,
        country: app.country,
        name: details?.name ?? null,
        developer: details?.developer ?? null,
        category: details?.category ?? null,
        averageRating: details?.averageRating ?? null,
        ratingCount: details?.ratingCount ?? null,
        url: details?.url ?? null,
        status,
        statusDetail: statusDetail ?? result?.note ?? null,
        reviewsRead: result?.reviewsRead ?? 0,
        ratingFilter: maxRating >= 5 ? 'all ratings' : `${maxRating} stars or fewer`,
        reviewsKept: kept.length,
        reviewsWithTheme: kept.filter((k) => k.hits.length).length,
        themeCounts,
        topThemes: themeCounts.slice(0, 3).map((t) => t.theme),
    };
}
