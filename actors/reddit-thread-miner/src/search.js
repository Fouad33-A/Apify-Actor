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

function decodedHref(value) {
    let href = String(value ?? '');
    try { href = decodeURIComponent(href); } catch {}
    return href;
}

export function redditResultsIn(html, subreddit) {
    const $ = cheerio.load(String(html ?? ''));
    const out = [];
    const seen = new Set();
    $('a[href]').each((_, el) => {
        const href = decodedHref($(el).attr('href'));
        const m = href.match(/https?:\/\/(?:www\.)?reddit\.com\/r\/([^/?#]+)\/comments\/([a-z0-9]+)(?:\/([^/?#]*))?/i);
        if (!m || m[1].toLowerCase() !== String(subreddit).toLowerCase()) return;
        const id = m[2].toLowerCase();
        if (seen.has(id)) return;
        seen.add(id);
        const box = $(el).closest('div').parent();
        const rawTitle = $(el).text().replace(/\s+/g, ' ').trim() || box.find('a').first().text().trim();
        const title = rawTitle.replace(/^Reddit\s+reddit\.com\s*›.*?on Reddit:\s*/i, '').replace(/\s*:\s*r\/[^ ]+\s*$/i, '').trim() || m[3]?.replace(/_/g, ' ') || `Reddit thread ${id}`;
        const text = box.text().replace(/\s+/g, ' ').trim();
        const dateMatch = text.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}\b/i);
        const updated = dateMatch && Number.isFinite(Date.parse(dateMatch[0])) ? new Date(dateMatch[0]).toISOString() : null;
        out.push({
            id: `t3_${id}`,
            title: title || m[3]?.replace(/_/g, ' ') || `Reddit thread ${id}`,
            text: text.slice(0, 2000),
            url: `https://www.reddit.com/r/${m[1]}/comments/${id}/${m[3] ?? ''}`.replace(/\/$/, ''),
            author: null,
            updated,
        });
    });
    return out;
}

export function redditCommentsIn(html, subreddit, submissionId) {
    const $ = cheerio.load(String(html ?? ''));
    const out = [];
    const seen = new Set();
    $('a[href]').each((_, el) => {
        const href = decodedHref($(el).attr('href'));
        const m = href.match(/https?:\/\/(?:www\.)?reddit\.com\/r\/([^/?#]+)\/comments\/([a-z0-9]+)\/[^/?#]+\/([a-z0-9]+)(?:[/?#]|$)/i);
        if (!m || m[1].toLowerCase() !== String(subreddit).toLowerCase() || m[2].toLowerCase() !== String(submissionId).toLowerCase()) return;
        const commentId = m[3].toLowerCase();
        if (seen.has(commentId)) return;
        const box = $(el).closest('div').parent();
        const raw = box.text().replace(/\s+/g, ' ').trim();
        const anchorText = $(el).text().replace(/\s+/g, ' ').trim();
        const text = (raw.length >= anchorText.length ? raw : anchorText).slice(0, 1500);
        if (!text || text.length < 12) return;
        seen.add(commentId);
        out.push({
            id: commentId,
            author: null,
            createdAt: null,
            text,
            url: `https://www.reddit.com/r/${m[1]}/comments/${m[2]}/_/${commentId}/`,
            score: null,
            source: 'public_search',
            rankBasis: 'search_relevance',
        });
    });
    return out;
}

export async function discoverRedditThreads({
    subreddit, keywords = [], maxThreads = 100, maxPages = 2, dateFromMs = null, dateToMs = null, fetch = fetchBrave,
    paceMs = 4000, backoffMs = 20_000, shouldStop = () => false, beforeRequest = () => true, log = () => {},
}) {
    const terms = keywords.length ? keywords : [''];
    const found = new Map();
    const attempts = [];
    let rateLimited = false;
    for (const keyword of terms) {
        const dateTerms = [dateFromMs != null ? `after:${new Date(dateFromMs - 86400000).toISOString().slice(0, 10)}` : '', dateToMs != null ? `before:${new Date(dateToMs + 86400000).toISOString().slice(0, 10)}` : ''].filter(Boolean).join(' ');
        const query = `site:reddit.com/r/${subreddit}/comments ${keyword} ${dateTerms}`.trim();
        for (let page = 0; page < maxPages && found.size < maxThreads && !shouldStop(); page += 1) {
            let res;
            for (let attempt = 0; attempt <= 2; attempt += 1) {
                if (shouldStop() || !beforeRequest()) break;
                res = await fetch(braveUrl(query, page));
                if (res.status !== 429) break;
                rateLimited = true;
                if (attempt < 2) await sleep(backoffMs);
            }
            if (!res) break;
            const rows = res.status === 200 ? redditResultsIn(res.body, subreddit) : [];
            const before = found.size;
            for (const row of rows) {
                if (dateFromMs != null || dateToMs != null) {
                    const timestamp = Date.parse(row.updated);
                    if (!Number.isFinite(timestamp) || (dateFromMs != null && timestamp < dateFromMs) || (dateToMs != null && timestamp > dateToMs)) continue;
                }
                const known = found.get(row.id);
                if (known) {
                    if (keyword && !known.matchedKeywords.includes(keyword)) known.matchedKeywords.push(keyword);
                } else if (found.size < maxThreads) found.set(row.id, { ...row, matchedKeywords: keyword ? [keyword] : [] });
            }
            attempts.push({ query, page, status: res.status, found: rows.length, added: found.size - before });
            log(`Search "${query}" page ${page + 1}: HTTP ${res.status}, ${rows.length} Reddit thread(s), ${found.size - before} new`);
            if (res.status !== 200 || !rows.length || (page > 0 && found.size === before && rows.length < 5)) break;
            if (paceMs) await sleep(paceMs);
        }
        if (found.size >= maxThreads) break;
    }
    return { threads: [...found.values()], attempts, rateLimited };
}

export async function discoverRedditComments({
    subreddit, threadId, maxComments = 20, maxPages = 2, fetch = fetchBrave,
    paceMs = 1200, backoffMs = 10_000, shouldStop = () => false, log = () => {},
}) {
    const id = String(threadId).replace(/^t3_/, '').toLowerCase();
    const query = `site:reddit.com/r/${subreddit}/comments/${id}/`;
    const found = new Map();
    const attempts = [];
    for (let page = 0; page < maxPages && found.size < maxComments && !shouldStop(); page += 1) {
        let res;
        for (let attempt = 0; attempt <= 1; attempt += 1) {
            res = await fetch(braveUrl(query, page));
            if (res.status !== 429) break;
            if (attempt < 1) await sleep(backoffMs);
        }
        const rows = res.status === 200 ? redditCommentsIn(res.body, subreddit, id) : [];
        const before = found.size;
        for (const row of rows) if (!found.has(row.id) && found.size < maxComments) found.set(row.id, row);
        attempts.push({ query, page, status: res.status, found: rows.length, added: found.size - before });
        log(`Comment search ${id} page ${page + 1}: HTTP ${res.status}, ${rows.length} indexed comment(s), ${found.size - before} new`);
        if (res.status !== 200 || !rows.length || (page > 0 && found.size === before)) break;
        if (paceMs) await sleep(paceMs);
    }
    return { status: found.size ? 'ok' : attempts.some((a) => a.status === 429) ? 'rate_limited' : 'no_comments', comments: [...found.values()], attempts };
}
