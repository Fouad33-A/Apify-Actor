// Public web discovery for TikTok hashtag videos. No login, CAPTCHA solving, signature generation, fingerprint evasion,
// or paid search API is used. Discovery fails over between ordinary public search-result pages. A blocked/rate-limited
// source is abandoned immediately instead of sleeping and retrying the same endpoint.
import { gotScraping } from 'got-scraping';

import { handlesIn, videoUrlsIn } from './video.js';

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export const WORDINGS = (tag) => [`site:tiktok.com/@ #${tag}`, `site:tiktok.com #${tag} video`, `#${tag} tiktok video`];
// Brave's own time filter: pw = past week, pm = past month, py = past year (none when the range is longer).
export const freshnessFor = (days) => (days <= 7 ? 'pw' : days <= 31 ? 'pm' : days <= 366 ? 'py' : null);

export const braveUrl = (q, page, freshness = null) =>
    `https://search.brave.com/search?q=${encodeURIComponent(q)}&offset=${page}&source=web${freshness ? `&tf=${freshness}` : ''}`;
export const bingUrl = (q, page) =>
    `https://www.bing.com/search?q=${encodeURIComponent(q)}&first=${page * 10 + 1}&count=10`;
export const duckDuckGoUrl = (q, page) =>
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}${page ? `&s=${page * 30}` : ''}`;

export const SEARCH_SOURCES = [
    { name: 'brave', url: braveUrl },
    { name: 'bing', url: bingUrl },
    { name: 'duckduckgo', url: duckDuckGoUrl },
];

export async function fetchSearch(url) {
    const res = await gotScraping({
        url,
        throwHttpErrors: false,
        timeout: { request: 15_000 },
        headers: {
            'accept-language': 'en-US,en;q=0.9',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
    });
    return { status: res.statusCode, body: res.body };
}

// Kept as a named export for compatibility with older tests/imports.
export const fetchBrave = fetchSearch;

const blockedStatus = (status) => status === 403 || status === 429;

export async function findVideoUrls({
    tag,
    want,
    maxPages = 2,
    freshness = null,
    fetch = fetchSearch,
    sources = SEARCH_SOURCES,
    paceMs = 1200,
    shouldStop = () => false,
    log = () => {},
}) {
    const urls = new Map();
    const handles = new Set();
    const attempts = [];
    const sourceResults = [];
    let anySuccessfulResponse = false;

    for (const source of sources) {
        if (urls.size >= want || shouldStop()) break;
        let sourceBlocked = false;
        let sourceHadSuccess = false;
        let sourceHttpFailure = false;

        for (const q of WORDINGS(tag)) {
            if (sourceBlocked || urls.size >= want || shouldStop()) break;
            for (let page = 0; page < maxPages && urls.size < want && !shouldStop(); page += 1) {
                let res;
                try {
                    res = await fetch(source.url(q, page, source.name === 'brave' ? freshness : null), source.name);
                } catch (error) {
                    attempts.push({
                        source: source.name,
                        query: q,
                        page,
                        status: 'request_failed',
                        detail: String(error?.message ?? error).slice(0, 200),
                        videoUrls: 0,
                        newVideoUrls: 0,
                    });
                    sourceHttpFailure = true;
                    log(`Search ${source.name} "${q}" page ${page + 1}: request failed; moving on`);
                    break;
                }

                const status = Number(res?.status ?? 0);
                if (blockedStatus(status)) {
                    attempts.push({
                        source: source.name,
                        query: q,
                        page,
                        status: status === 429 ? 'rate_limited' : 'blocked',
                        videoUrls: 0,
                        newVideoUrls: 0,
                    });
                    sourceBlocked = true;
                    log(`Search ${source.name} "${q}" page ${page + 1}: HTTP ${status}; abandoning this source`);
                    break;
                }

                if (status !== 200) {
                    attempts.push({
                        source: source.name,
                        query: q,
                        page,
                        status: `http_${status}`,
                        videoUrls: 0,
                        newVideoUrls: 0,
                    });
                    sourceHttpFailure = true;
                    log(`Search ${source.name} "${q}" page ${page + 1}: HTTP ${status}`);
                    break;
                }

                sourceHadSuccess = true;
                anySuccessfulResponse = true;
                const found = videoUrlsIn(res.body);
                for (const h of handlesIn(res.body)) handles.add(h);
                const before = urls.size;
                for (const u of found) urls.set(u.split('/video/')[1], u);
                attempts.push({
                    source: source.name,
                    query: q,
                    page,
                    status: 'ok',
                    videoUrls: found.length,
                    newVideoUrls: urls.size - before,
                });
                log(
                    `Search ${source.name} "${q}" page ${page + 1}: HTTP 200, ${found.length} video address(es), ${urls.size - before} new`,
                );
                if (page > 0 && urls.size === before) break;
                if (paceMs && urls.size < want) await sleep(paceMs);
            }
        }

        sourceResults.push({
            source: source.name,
            status: sourceBlocked ? 'blocked' : sourceHadSuccess ? 'ok' : sourceHttpFailure ? 'failed' : 'not_used',
        });
    }

    const blockedSources = sourceResults.filter((s) => s.status === 'blocked').length;
    const failedSources = sourceResults.filter((s) => s.status === 'failed').length;
    let discoveryStatus = 'ok';
    if (!anySuccessfulResponse && blockedSources > 0 && failedSources === 0) discoveryStatus = 'rate_limited';
    else if (!anySuccessfulResponse) discoveryStatus = 'failed';

    return {
        urls: [...urls.values()],
        handles: [...handles],
        attempts,
        sourceResults,
        discoveryStatus,
        rateLimited: blockedSources > 0,
    };
}
