// Apple App Store through Apple's public JSON endpoints (no login, no key):
//   customer reviews feed  https://itunes.apple.com/<cc>/rss/customerreviews/page=<n>/id=<id>/sortby=mostrecent/json
//   lookup / search        https://itunes.apple.com/lookup?id=...   https://itunes.apple.com/search?term=...
// The reviews feed returns 50 reviews a page and at most 10 pages (500 most recent reviews per app and country).

import { gotScraping } from 'got-scraping';

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export async function getJson(url, { timeoutMs = 30_000, retries = 2 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await gotScraping({
                url,
                timeout: { request: timeoutMs },
                retry: { limit: 0 },
                throwHttpErrors: false,
                headers: { accept: 'application/json' },
            });
            if (res.statusCode === 429 || res.statusCode >= 500) {
                lastError = new Error(`HTTP ${res.statusCode}`);
                await sleep(1500 * (attempt + 1));
                continue;
            }
            if (res.statusCode !== 200) return { status: res.statusCode, json: null };
            try {
                return { status: 200, json: JSON.parse(res.body) };
            } catch {
                return { status: 200, json: null, error: 'the answer was not JSON' };
            }
        } catch (error) {
            lastError = error;
            await sleep(1000 * (attempt + 1));
        }
    }
    return { status: 0, json: null, error: lastError?.message ?? 'request failed' };
}

const label = (node) => (node && typeof node === 'object' ? (node.label ?? null) : (node ?? null));
const toArray = (v) => {
    if (Array.isArray(v)) return v;
    return v ? [v] : [];
};

// Parses one page of the reviews feed. The first entry of page 1 describes the app itself (it has no rating).
export function parseReviewsFeed(json) {
    const entries = toArray(json?.feed?.entry);
    const reviews = [];
    for (const e of entries) {
        const ratingText = label(e['im:rating']);
        const rating = ratingText == null ? NaN : Number(ratingText);
        if (!Number.isFinite(rating)) continue;
        reviews.push({
            reviewId: label(e.id),
            rating,
            title: label(e.title),
            text: label(e.content),
            author: label(e.author?.name),
            date:
                label(e.updated) && Number.isFinite(Date.parse(label(e.updated)))
                    ? new Date(label(e.updated)).toISOString()
                    : null,
            version: label(e['im:version']),
            helpfulVotes: Number(label(e['im:voteSum'])) || 0,
            totalVotes: Number(label(e['im:voteCount'])) || 0,
        });
    }
    const last = toArray(json?.feed?.link).find((l) => l?.attributes?.rel === 'last')?.attributes?.href ?? '';
    const lastPage = Number(/page=(\d+)/.exec(last)?.[1]) || null;
    return { reviews, lastPage };
}

export function parseLookup(json) {
    const r = json?.results?.[0];
    if (!r) return null;
    return {
        appId: String(r.trackId),
        name: r.trackName ?? null,
        developer: r.sellerName ?? null,
        category: r.primaryGenreName ?? null,
        averageRating: r.averageUserRating ?? null,
        ratingCount: r.userRatingCount ?? null,
        currentVersionRating: r.averageUserRatingForCurrentVersion ?? null,
        version: r.version ?? null,
        url: r.trackViewUrl ?? null,
    };
}

export function parseSearch(json) {
    return (json?.results ?? []).filter((r) => r.trackId).map((r) => parseLookup({ results: [r] }));
}

export async function lookupApp(appId, country, get = getJson) {
    const res = await get(`https://itunes.apple.com/lookup?id=${appId}&country=${country}`);
    return { ...res, app: res.json ? parseLookup(res.json) : null };
}

export async function searchApps(term, country, limit, get = getJson) {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=software&country=${country}&limit=${limit}`;
    const res = await get(url);
    return { ...res, apps: res.json ? parseSearch(res.json) : [] };
}

/**
 * Reads up to `maxReviews` of the most recent reviews. `accept(review)` decides which ones to keep;
 * pages are read until enough kept reviews, the last page, or `maxPages`.
 */
export async function readAppleReviews(
    appId,
    country,
    { maxReviews = 200, maxPages = 10, accept = () => true, get = getJson, delayMs = 400 } = {},
) {
    const kept = [];
    let read = 0;
    let pages = 0;
    let note = null;
    for (let page = 1; page <= Math.min(maxPages, 10) && kept.length < maxReviews; page++) {
        const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;
        const res = await get(url);
        pages += 1;
        if (res.status === 404) {
            note = 'Apple has no review feed for this app in this country';
            break;
        }
        if (!res.json) {
            note = `Review feed stopped at page ${page} (${res.error ?? `HTTP ${res.status}`})`;
            break;
        }
        const parsed = parseReviewsFeed(res.json);
        if (!parsed.reviews.length) break;
        read += parsed.reviews.length;
        for (const r of parsed.reviews) {
            if (accept(r) && kept.length < maxReviews) kept.push(r);
        }
        if (parsed.lastPage && page >= parsed.lastPage) break;
        if (delayMs) await sleep(delayMs);
    }
    return { reviews: kept, reviewsRead: read, pages, note };
}
