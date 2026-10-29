// Finding video addresses for a hashtag: Brave Search results for "site:tiktok.com/@ #tag" (plain HTTP). TikTok's own
// hashtag pages are empty for a logged-out visitor, so they are not used. Requests are spaced and a "too many requests"
// answer is waited out; nothing is rotated or bypassed.
import { gotScraping } from 'got-scraping';

import { videoUrlsIn } from './video.js';

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export const WORDINGS = (tag) => [`site:tiktok.com/@ #${tag}`, `site:tiktok.com #${tag} video`, `#${tag} tiktok video`];
export const braveUrl = (q, page) =>
    `https://search.brave.com/search?q=${encodeURIComponent(q)}&offset=${page}&source=web`;

export async function fetchBrave(url) {
    const res = await gotScraping({
        url,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    return { status: res.statusCode, body: res.body };
}

export async function findVideoUrls({
    tag,
    want,
    maxPages = 2,
    fetch = fetchBrave,
    paceMs = 5000,
    backoffMs = 20_000,
    shouldStop = () => false,
    log = () => {},
}) {
    const urls = new Map();
    const attempts = [];
    let rateLimits = 0;
    for (const q of WORDINGS(tag)) {
        for (let page = 0; page < maxPages && urls.size < want && !shouldStop(); page += 1) {
            let res;
            for (let attempt = 0; attempt <= 2; attempt += 1) {
                res = await fetch(braveUrl(q, page));
                if (res.status !== 429) break;
                rateLimits += 1;
                if (attempt < 2) await sleep(backoffMs);
            }
            const found = res.status === 200 ? videoUrlsIn(res.body) : [];
            const before = urls.size;
            for (const u of found) urls.set(u.split('/video/')[1], u);
            attempts.push({
                query: q,
                page,
                status: res.status === 200 ? 'ok' : res.status === 429 ? 'rate_limited' : `http_${res.status}`,
                videoUrls: found.length,
                newVideoUrls: urls.size - before,
            });
            log(
                `Search "${q}" page ${page + 1}: HTTP ${res.status}, ${found.length} video address(es), ${urls.size - before} new`,
            );
            if (res.status === 429) break;
            if (page > 0 && urls.size === before) break;
            await sleep(paceMs);
        }
        if (urls.size >= want) break;
    }
    return { urls: [...urls.values()], attempts, rateLimited: rateLimits > 0 };
}
