import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const braveUrl = (query, page = 0) =>
    `https://search.brave.com/search?q=${encodeURIComponent(query)}&offset=${page}&source=web`;

export async function fetchBrave(url) {
    const res = await gotScraping({
        url,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    return { status: res.statusCode, body: res.body };
}

export function redditResultsIn(html, subreddit) {
    const $ = cheerio.load(String(html ?? ''));
    const out = [];
    const seen = new Set();
    $('a[href]').each((_, el) => {
        let href = $(el).attr('href') ?? '';
        try {
            href = decodeURIComponent(href);
        } catch {}
        const m = href.match(/https?:\/\/(?:www\.)?reddit\.com\/r\/([^/?#]+)\/comments\/([a-z0-9]+)(?:\/([^/?#]*))?/i);
        if (!m || m[1].toLowerCase() !== String(subreddit).toLowerCase()) return;
        const id = m[2].toLowerCase();
        if (seen.has(id)) return;
        seen.add(id);
        const box = $(el).closest('div').parent();
        const title = $(el).text().trim() || box.find('a').first().text().trim();
        const text = box.text().replace(/\s+/g, ' ').trim();
        out.push({
            id: `t3_${id}`,
            title: title || m[3]?.replace(/_/g, ' ') || `Reddit thread ${id}`,
            text: text.slice(0, 2000),
            url: `https://www.reddit.com/r/${m[1]}/comments/${id}/${m[3] ?? ''}`.replace(/\/$/, ''),
            author: null,
            updated: null,
        });
    });
    return out;
}

export async function discoverRedditThreads({
    subreddit,
    keywords = [],
    maxThreads = 100,
    maxPages = 2,
    fetch = fetchBrave,
    paceMs = 4000,
    backoffMs = 20_000,
    shouldStop = () => false,
    log = () => {},
}) {
    const terms = keywords.length ? keywords : [''];
    const found = new Map();
    const attempts = [];
    let rateLimited = false;
    for (const keyword of terms) {
        const query = `site:reddit.com/r/${subreddit}/comments ${keyword}`.trim();
        for (let page = 0; page < maxPages && found.size < maxThreads && !shouldStop(); page += 1) {
            let res;
            for (let attempt = 0; attempt <= 2; attempt += 1) {
                res = await fetch(braveUrl(query, page));
                if (res.status !== 429) break;
                rateLimited = true;
                if (attempt < 2) await sleep(backoffMs);
            }
            const rows = res.status === 200 ? redditResultsIn(res.body, subreddit) : [];
            const before = found.size;
            for (const row of rows) {
                const known = found.get(row.id);
                if (known) {
                    if (keyword && !known.matchedKeywords.includes(keyword)) known.matchedKeywords.push(keyword);
                } else if (found.size < maxThreads) {
                    found.set(row.id, { ...row, matchedKeywords: keyword ? [keyword] : [] });
                }
            }
            attempts.push({ query, page, status: res.status, found: rows.length, added: found.size - before });
            log(`Search "${query}" page ${page + 1}: HTTP ${res.status}, ${rows.length} Reddit thread(s), ${found.size - before} new`);
            if (res.status !== 200 || (page > 0 && found.size === before)) break;
            if (paceMs) await sleep(paceMs);
        }
        if (found.size >= maxThreads) break;
    }
    return { threads: [...found.values()], attempts, rateLimited };
}
