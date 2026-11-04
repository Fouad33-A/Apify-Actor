// Google Play through the "google-play-scraper" library (Google has no public reviews endpoint). The library is loaded
// on first use, so the Apple side keeps working if it is ever missing. `gplay` can be injected (tests).

let cached;
async function loadGplay() {
    cached ??= (await import('google-play-scraper')).default;
    return cached;
}

const wrap = (review, appId, country) => ({
    reviewId: review.id,
    rating: review.score,
    title: review.title ?? null,
    text: review.text ?? null,
    author: review.userName ?? null,
    date: review.date && Number.isFinite(Date.parse(review.date)) ? new Date(review.date).toISOString() : null,
    version: review.version ?? null,
    helpfulVotes: review.thumbsUp ?? 0,
    developerReply: review.replyText ?? null,
    developerReplyDate:
        review.replyDate && Number.isFinite(Date.parse(review.replyDate))
            ? new Date(review.replyDate).toISOString()
            : null,
    url: review.url ?? `https://play.google.com/store/apps/details?id=${appId}&reviewId=${review.id}`,
    country,
});

export async function lookupPlayApp(appId, { country, lang, gplay } = {}) {
    const g = gplay ?? (await loadGplay());
    const app = await g.app({ appId, country, lang });
    return {
        appId,
        name: app.title ?? null,
        developer: app.developer ?? null,
        category: app.genre ?? null,
        averageRating: app.score ?? null,
        ratingCount: app.ratings ?? null,
        version: app.version ?? null,
        url: app.url ?? `https://play.google.com/store/apps/details?id=${appId}`,
    };
}

export async function searchPlayApps(term, { country, lang, limit = 10, gplay } = {}) {
    const g = gplay ?? (await loadGplay());
    const found = await g.search({ term, country, lang, num: limit });
    return found.map((a) => ({
        appId: a.appId,
        name: a.title ?? null,
        developer: a.developer ?? null,
        url: a.url ?? null,
    }));
}

/**
 * Reads reviews filtered by star rating (the store filters, so no low-rating review is skipped by an unfiltered page).
 * Each requested star stream is read independently, then all accepted reviews are merged and the newest `maxReviews`
 * are returned overall. This avoids imposing an artificial equal quota per star rating.
 */
export async function readPlayReviews(
    appId,
    { country = 'us', lang = 'en', maxReviews = 200, stars = [], gplay, accept = () => true } = {},
) {
    const g = gplay ?? (await loadGplay());
    const kept = [];
    const seen = new Set();
    let read = 0;
    let note = null;
    const starList = stars.length ? stars : [null];

    for (const star of starList) {
        let token = null;
        let acceptedForStar = 0;
        try {
            do {
                const remaining = maxReviews - acceptedForStar;
                if (remaining <= 0) break;
                const res = await g.reviews({
                    appId,
                    country,
                    lang,
                    sort: g.sort.NEWEST,
                    num: Math.min(150, remaining),
                    paginate: true,
                    nextPaginationToken: token,
                    ...(star ? { stars: star } : {}),
                });
                token = res.nextPaginationToken ?? null;
                read += res.data.length;
                for (const r of res.data) {
                    const review = wrap(r, appId, country);
                    if (!accept(review)) continue;
                    const key = review.reviewId ?? `${review.rating}:${review.date}:${review.author}:${review.text}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    kept.push(review);
                    acceptedForStar += 1;
                    if (acceptedForStar >= maxReviews) break;
                }
                if (!res.data.length) break;
            } while (token && acceptedForStar < maxReviews);
        } catch (error) {
            note = `Google Play review reading stopped: ${String(error?.message ?? error)}`;
            break;
        }
    }

    kept.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
    return { reviews: kept.slice(0, maxReviews), reviewsRead: read, note };
}
