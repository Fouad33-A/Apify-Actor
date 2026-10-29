// Finding TikTok creators from a keyword or hashtag: Google's results for "site:tiktok.com <keyword>" through Apify's
// Google SERP proxy (plain HTTP, no browser). TikTok's own search and hashtag pages do not load for a logged-out
// visitor, so they are not used; nothing is solved, clicked through or worked around.
//
// What Google returns varies from run to run (some wordings come back empty, some requests time out). Every attempt is
// recorded in the report so a thin result can be explained. Follower figures printed in snippets are kept only as
// hints; they are never used to judge an account.

import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';

const enc = encodeURIComponent;
export const SITE = 'tiktok.com';
export const QUERY_VARIANTS = 3;
const SEARCH_PARALLEL = 3;
const TT_NAME = /^[A-Za-z0-9._]{2,24}$/;

export const googleUrl = (q, page) =>
    `http://www.google.com/search?q=${enc(q)}&hl=en${page ? `&start=${page * 10}` : ''}`;

// Three ways to ask, since Google sometimes ignores the site: operator.
export function buildQuery({ keyword, variant = 0, modifiers = [] }) {
    const kw = String(keyword).trim();
    const extra = (modifiers ?? [])
        .map((m) => String(m ?? '').trim())
        .filter(Boolean)
        .join(' ');
    let query;
    if (variant === 0) query = `site:${SITE} ${kw}`;
    else if (variant === 1) query = `${kw} tiktok followers`;
    else query = `${kw} "${SITE}"`;
    return extra ? `${query} ${extra}` : query;
}

export function mentionsExcluded(text, excludeWords) {
    const hay = String(text ?? '').toLowerCase();
    return (excludeWords ?? [])
        .map((w) =>
            String(w ?? '')
                .trim()
                .replace(/^-+/, '')
                .toLowerCase(),
        )
        .filter(Boolean)
        .find((w) => hay.includes(w));
}

// Google wraps result links in /url?q=<real address>; the real address is returned.
export function unwrapSearchUrl(href) {
    if (!href) return null;
    let u;
    try {
        u = new URL(String(href).startsWith('//') ? `https:${href}` : href);
    } catch {
        return null;
    }
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname.toLowerCase()) && u.pathname === '/url') {
        const v = u.searchParams.get('q') || u.searchParams.get('url');
        return v && /^https?:\/\//i.test(v) ? v : null;
    }
    return u.href;
}

// One result URL -> { handle, kind, videoId } or null. "profile" = the account's own page, "post" = one of its videos.
export function handleFromUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    } catch {
        return null;
    }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase().replace(/^(www|m|web|mobile|vm)\./, '');
    if (host !== SITE) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (!segs.length || !segs[0].startsWith('@')) return null;
    let name;
    try {
        name = decodeURIComponent(segs[0].slice(1));
    } catch {
        return null;
    }
    if (!TT_NAME.test(name)) return null;
    const isVideo = segs[1] === 'video';
    return {
        handle: name.toLowerCase(),
        kind: isVideo ? 'post' : 'profile',
        videoId: isVideo ? (segs[2] ?? null) : null,
    };
}

// A result whose address has no account name can name it in the title: "Jane (@jane) | TikTok".
export function handleFromTitle(text) {
    const m = String(text ?? '').match(/\(@([A-Za-z0-9._]{2,24})\)/);
    return m ? m[1].toLowerCase() : null;
}

// Google prints a TikTok result's account as "TikTok · handle" above the snippet. A handle is lower case and followed by
// a count, a separator or the end; a capitalised word or another plain word after it is a display name.
export function handleFromSnippet(text) {
    const m = String(text ?? '').match(/TikTok\s*[·•|]\s*@?([A-Za-z0-9._]{2,24})(.{0,12})/);
    if (!m) return null;
    const raw = m[1].replace(/\.+$/, '');
    const name = raw.toLowerCase();
    if (/^\d[\d.,]*[kmb]?$/i.test(name)) return null; // "TikTok · 85K views" is a count
    if (raw !== name) return null;
    if (
        /^\s+[A-Za-z]{2,}/.test(m[2]) &&
        !/^\s+(likes?|views?|followers?|posts?|comments?|reels?|videos?)\b/i.test(m[2])
    ) {
        return null;
    }
    return name;
}

export function accountsInText(text) {
    const out = [];
    const seen = new Set();
    for (const m of String(text ?? '').matchAll(/TikTok\s*[·•|]\s*@?([A-Za-z0-9._]{2,24})/g)) {
        const handle = handleFromSnippet(m[0]);
        if (!handle || seen.has(handle)) continue;
        seen.add(handle);
        out.push({ handle, snippet: String(text).slice(Math.max(0, m.index - 160), m.index + 60) });
    }
    return out;
}

// "12.4K" / "1,234" / "9M" -> number
export function parseFollowerHint(hint) {
    const m = String(hint ?? '')
        .replace(/,/g, '')
        .trim()
        .match(/^([\d.]+)\s*([KMB])?$/i);
    if (!m) return null;
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
    return Math.round(parseFloat(m[1]) * mult);
}

export function followerHint(text) {
    const m = String(text ?? '').match(/([\d][\d.,]*\s*[KMB]?)\s+(?:Followers|followers)/);
    return m ? m[1].replace(/\s+/g, '') : null;
}

const BLOCKED =
    /captcha|unusual traffic|verify you are|are you a robot|not a robot|automated (queries|requests)|anomaly|security check|too many requests|access denied|temporarily blocked|please solve|confirm this search was made by a human/i;
const NO_RESULTS =
    /no results (found )?for|did not match any|0 results|no web results|can't find anything|nothing matched/i;

// Pure: what did one result page show? anchors = [{ href, text, container }]
export function classifySearchPage({ title = '', text = '', anchors = [], excludeWords = [] }) {
    if (BLOCKED.test(title) || (text.length < 1500 && BLOCKED.test(text))) return { status: 'blocked' };
    const hits = [];
    const seenKey = new Set();
    let resultLinks = 0;
    let excluded = 0;
    const skipped = new Set(); // handles dropped by the exclude words
    for (const a of anchors) {
        const url = unwrapSearchUrl(a.href);
        if (!url) continue;
        let found = handleFromUrl(url);
        if (!found) {
            let host = '';
            try {
                host = new URL(url).hostname.replace(/^(www|m|vm)\./, '');
            } catch {
                host = '';
            }
            const named =
                host === SITE ? (handleFromTitle(a.text) ?? handleFromSnippet(`${a.text} ${a.container}`)) : null;
            if (named) found = { handle: named, kind: 'post', videoId: null };
        }
        if (found) resultLinks += 1;
        if (!found) continue;
        const snippet = String(a.container || a.text || '').slice(0, 300);
        if (mentionsExcluded(`${a.text} ${snippet}`, excludeWords)) {
            excluded += 1;
            skipped.add(found.handle);
            continue;
        }
        const key = `${found.handle}:${found.kind}:${found.videoId ?? ''}`;
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        const videoUrl =
            found.kind === 'post' && found.videoId
                ? `https://www.tiktok.com/@${found.handle}/video/${found.videoId}`
                : null;
        hits.push({ ...found, url, videoUrl, snippet, hint: followerHint(a.container) });
    }
    const handled = new Set(hits.map((h) => h.handle));
    for (const account of accountsInText(text)) {
        // an account already taken from a link is not counted a second time
        if (handled.has(account.handle) || skipped.has(account.handle)) continue;
        if (mentionsExcluded(account.snippet, excludeWords)) {
            excluded += 1;
            continue;
        }
        handled.add(account.handle);
        resultLinks += 1;
        hits.push({
            handle: account.handle,
            kind: 'post',
            videoId: null,
            url: null,
            videoUrl: null,
            snippet: account.snippet,
            hint: followerHint(account.snippet),
        });
    }
    if (hits.length) return { status: 'ok', hits, excluded };
    if (excluded) return { status: 'all_excluded', hits: [], excluded };
    if (NO_RESULTS.test(text)) return { status: 'no_results', hits: [] };
    return { status: resultLinks || anchors.length > 5 ? 'no_platform_results' : 'unrecognised', hits: [] };
}

// TikTok addresses written anywhere in the page source (plain, JSON-escaped or percent-encoded in a redirect).
export function tiktokUrlsInText(html) {
    const text = String(html ?? '')
        .replace(/\\u003d/gi, '=')
        .replace(/\\u0026/gi, '&')
        .replace(/\\u002F/gi, '/')
        .replace(/&amp;/g, '&');
    const found = [];
    const add = (u) => {
        const cleaned = u.replace(/[).,;'"\\]+$/, '');
        if (!found.includes(cleaned)) found.push(cleaned);
    };
    for (const m of text.matchAll(/https?:\/\/(?:www\.|m\.)?tiktok\.com\/[^\s"'<>\\)&]+/gi)) add(m[0]);
    for (const m of text.matchAll(/https?%3A%2F%2F(?:www\.|m\.)?tiktok\.com%2F[^&"'<>\s\\]+/gi)) {
        try {
            add(decodeURIComponent(m[0]));
        } catch {
            // not decodable: skip
        }
    }
    return found.slice(0, 200);
}

// Result page HTML -> { title, text, head, links, diag, anchors }
export function parseSerpHtml(html) {
    // a space after closing tags, so neighbouring elements' text does not run together
    const $ = cheerio.load(String(html ?? '').replace(/<\/(span|div|a|p|li|cite|h3|b|td)>/gi, '$& '));
    const clean = (t) =>
        String(t ?? '')
            .replace(/\s+/g, ' ')
            .trim();
    const anchors = [];
    $('a[href]').each((_, el) => {
        if (anchors.length >= 600) return;
        let href = $(el).attr('href') ?? '';
        if (href.startsWith('/url?')) href = `https://www.google.com${href}`;
        const text = clean($(el).text()).slice(0, 200);
        let block = $(el).parent();
        // stop before a container that holds several results (more than one result title)
        for (
            let i = 0;
            i < 5 &&
            clean(block.text()).length < text.length + 40 &&
            block.parent().length &&
            block.parent().find('h3').length <= 1;
            i += 1
        ) {
            block = block.parent();
        }
        anchors.push({ href, text, container: clean(block.text()).slice(0, 400) });
    });
    // addresses found in the source that no link carried (a link already seen keeps its title and snippet, which the
    // exclude words are checked against)
    const canonical = (u) => String(u ?? '').split(/[?&#]/)[0];
    const seen = new Set(anchors.map((a) => canonical(unwrapSearchUrl(a.href) ?? a.href)));
    const extra = tiktokUrlsInText(html).filter((u) => !seen.has(canonical(u)));
    for (const u of extra) anchors.push({ href: u, text: '', container: '' });
    $('style, script, noscript').remove();
    const body = clean($('body').text());
    return {
        title: clean($('title').text()),
        text: body.slice(0, 20_000),
        head: body.slice(0, 300),
        links: anchors
            .map((a) => a.href)
            .filter((h) => /^https?:/.test(h) && !/google\./.test(h))
            .slice(0, 8),
        diag: `html ${String(html ?? '').length} bytes, ${anchors.length} links (${extra.length} from the page source), tiktok addresses in source: ${tiktokUrlsInText(html).length}, asks for JavaScript: ${/enablejs|enable javascript/i.test(String(html))}`,
        anchors,
    };
}

// Default page fetcher: one GET through the Google SERP proxy, one more try after a timeout. Replaced in tests.
export async function fetchSerpPage({ url, proxyUrl, timeoutMs = 40_000 }) {
    const get = () => gotScraping({ url, proxyUrl, timeout: { request: timeoutMs }, throwHttpErrors: false });
    const response = await get().catch((err) => (/timeout/i.test(String(err?.message)) ? get() : Promise.reject(err)));
    if (response.statusCode >= 400) throw new Error(`HTTP ${response.statusCode} from the search proxy`);
    return parseSerpHtml(response.body);
}

/**
 * Runs every keyword (hashtags are keywords written with a leading #). Returns { candidates, report }.
 * candidates: [{ handle, queries, timesSeen, profileHit, snippets, hint, videoUrls }]
 * The report lists every attempt (query wording, status, results, seconds) so a thin result can be explained.
 */
export async function discoverCreators({
    keywords,
    excludeWords = [],
    maxPages = 2,
    maxQueries = 60,
    serpProxyUrl,
    serpFetch = fetchSerpPage,
    maxSeconds = 600,
    modifiers = [],
    report: reportSink = { queries: [], blocked: false, stoppedOnTime: false },
    shouldContinue = () => true,
    log = () => {},
}) {
    const report = reportSink; // filled in place, so a stopped run still leaves what was found
    const deadline = Date.now() + maxSeconds * 1000;
    const timeLeft = () => Date.now() < deadline;
    const byHandle = new Map();

    function addHits(hits, keyword) {
        for (const h of hits) {
            const cand = byHandle.get(h.handle) ?? {
                handle: h.handle,
                queries: [],
                timesSeen: 0,
                profileHit: false,
                snippets: [],
                hint: null,
                videoUrls: [],
            };
            cand.timesSeen += 1;
            if (!cand.queries.includes(keyword)) cand.queries.push(keyword);
            if (h.kind === 'profile') cand.profileHit = true;
            if (h.snippet && cand.snippets.length < 3 && !cand.snippets.includes(h.snippet))
                cand.snippets.push(h.snippet);
            cand.hint ??= h.hint;
            if (h.videoUrl && cand.videoUrls.length < 5 && !cand.videoUrls.includes(h.videoUrl))
                cand.videoUrls.push(h.videoUrl);
            byHandle.set(h.handle, cand);
        }
    }

    async function ask(keyword, query) {
        let got = 0;
        let outcome = 'error';
        let detail = null;
        if (!serpProxyUrl)
            return { got: 0, outcome: 'unavailable', detail: 'the Google SERP proxy is not available to this run' };
        for (let p = 0; p < maxPages && timeLeft(); p += 1) {
            try {
                const { anchors, ...info } = await serpFetch({ url: googleUrl(query, p), proxyUrl: serpProxyUrl });
                const res = classifySearchPage({ title: info.title, text: info.text, anchors, excludeWords });
                outcome = res.status;
                if (res.status !== 'ok') {
                    const links = info.links.map((h) => unwrapSearchUrl(h) ?? h).map((h) => h.slice(0, 100));
                    detail = `${info.title} | ${info.head} | ${info.diag} | links: ${links.join(' ')}`.slice(0, 900);
                    break;
                }
                const before = byHandle.size;
                addHits(res.hits, keyword);
                got += res.hits.length;
                if (byHandle.size === before && p > 0) break; // a further page added no new creator
            } catch (err) {
                outcome = 'error';
                detail = String(err?.message ?? err)
                    .split('\n')[0]
                    .slice(0, 160);
                break;
            }
        }
        return { got, outcome: got ? 'ok' : outcome, detail };
    }

    async function runKeyword(entryRef) {
        const entry = entryRef; // filled in place
        for (let variant = 0; variant < QUERY_VARIANTS && timeLeft(); variant += 1) {
            const query = buildQuery({ keyword: entry.keyword, variant, modifiers });
            const startedMs = Date.now();
            const { got, outcome, detail } = await ask(entry.keyword, query);
            const seconds = Math.round((Date.now() - startedMs) / 1000);
            log(`Search "${query}": ${outcome}, ${got} hit(s), ${seconds} s`);
            entry.attempts.push({ query, status: outcome, results: got, seconds, ...(detail ? { detail } : {}) });
            if (outcome === 'blocked') {
                report.blocked = true;
                log('Google answered with a bot check: no more searches are asked in this run (nothing was solved)');
                return;
            }
            if (outcome === 'unavailable') return;
            if (got) {
                entry.hits = got;
                return;
            }
        }
    }

    const queue = [...new Set((keywords ?? []).map((k) => String(k).trim()).filter(Boolean))]
        .slice(0, maxQueries)
        .map((keyword) => ({ keyword, attempts: [], hits: 0 }));
    for (const item of queue) report.queries.push(item);
    let next = 0;
    async function worker() {
        while (next < queue.length) {
            const item = queue[next];
            next += 1;
            if (!shouldContinue() || report.blocked) return;
            if (!timeLeft()) {
                if (!report.stoppedOnTime) {
                    report.stoppedOnTime = true;
                    log(`Search time budget (${maxSeconds} s) used up: the remaining keywords were not searched`);
                }
                return;
            }
            await runKeyword(item);
        }
    }
    await Promise.all(Array.from({ length: SEARCH_PARALLEL }, () => worker()));
    report.queries = report.queries.filter((e) => e.attempts.length);
    return { candidates: [...byHandle.values()], report };
}
