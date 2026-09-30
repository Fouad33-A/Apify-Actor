// Discovery by web search: the Marketing Agent supplies topic keywords, this module asks public search engines
// for Instagram / Facebook / TikTok profile pages about them and returns the account handles found.
//
// Logged-out and public only. A search engine that answers with a bot check or CAPTCHA is reported as blocked and
// the next engine is tried; nothing is solved, clicked through or worked around. Follower counts shown in the
// result snippets are kept only as an untrusted hint: every account is re-read from its own profile afterwards.

const enc = encodeURIComponent;

export const SEARCH_ENGINES = {
    bing: {
        label: 'Bing',
        url: (q, page) => `https://www.bing.com/search?q=${enc(q)}&count=50&first=${page * 50 + 1}&setlang=en-US`,
    },
    duckduckgo: {
        label: 'DuckDuckGo',
        url: (q, page) => `https://html.duckduckgo.com/html/?q=${enc(q)}${page ? `&s=${page * 30}` : ''}`,
    },
    brave: {
        label: 'Brave Search',
        url: (q, page) => `https://search.brave.com/search?q=${enc(q)}&source=web${page ? `&offset=${page}` : ''}`,
    },
};
export const DEFAULT_ENGINES = ['bing', 'duckduckgo', 'brave'];
export const PLATFORM_SITES = { instagram: 'instagram.com', facebook: 'facebook.com', tiktok: 'tiktok.com' };

// ---- pure helpers ----

// "budgeting tips" + ["course", "-my book"] -> `site:instagram.com budgeting tips followers -course -"my book"`
export function buildQuery({ platform, keyword, excludeWords = [] }) {
    const site = PLATFORM_SITES[platform];
    const minus = (excludeWords ?? [])
        .map((w) =>
            String(w ?? '')
                .trim()
                .replace(/^-+/, ''),
        )
        .filter(Boolean)
        .map((w) => (/\s/.test(w) ? `-"${w}"` : `-${w}`));
    const hint = platform === 'facebook' ? 'page followers' : 'followers';
    return [`site:${site}`, String(keyword).trim(), hint, ...minus].join(' ');
}

// Search engines wrap result links in their own redirect; the real address is inside the wrapper.
export function unwrapSearchUrl(href) {
    if (!href) return null;
    let u;
    try {
        u = new URL(String(href).startsWith('//') ? `https:${href}` : href);
    } catch {
        return null;
    }
    const host = u.hostname.toLowerCase();
    try {
        if (/(^|\.)bing\.com$/.test(host) && u.pathname.startsWith('/ck/')) {
            const v = u.searchParams.get('u');
            if (v && /^a1/.test(v)) {
                const decoded = Buffer.from(v.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
                    'utf8',
                );
                return /^https?:\/\//i.test(decoded) ? decoded : null;
            }
            return null;
        }
        if (/(^|\.)duckduckgo\.com$/.test(host) && u.pathname.startsWith('/l/')) {
            const v = u.searchParams.get('uddg');
            return v && /^https?:\/\//i.test(v) ? v : null;
        }
        if (/(^|\.)google\.[a-z.]+$/.test(host) && u.pathname === '/url') {
            const v = u.searchParams.get('q') ?? u.searchParams.get('url');
            return v && /^https?:\/\//i.test(v) ? v : null;
        }
    } catch {
        return null;
    }
    return u.href;
}

const IG_RESERVED = new Set([
    'p',
    'reel',
    'reels',
    'tv',
    'stories',
    'explore',
    'accounts',
    'directory',
    'about',
    'legal',
    'web',
    'api',
    'developer',
    'direct',
    'challenge',
    'oauth',
    'privacy',
    'locations',
    'tags',
    'share',
    'emails',
    'session',
]);
const FB_RESERVED = new Set([
    'groups',
    'watch',
    'events',
    'marketplace',
    'share',
    'sharer',
    'sharer.php',
    'login',
    'pages',
    'profile.php',
    'photo',
    'photo.php',
    'photos',
    'video',
    'videos',
    'reel',
    'reels',
    'story.php',
    'permalink.php',
    'hashtag',
    'public',
    'people',
    'gaming',
    'stories',
    'help',
    'policies',
    'business',
    'ads',
    'privacy',
    'l.php',
    'tr',
    'plugins',
    'dialog',
    'home.php',
    'friends',
    'notifications',
    'messages',
    'settings',
    'search',
    'directory',
    'about',
    'legal',
    'careers',
    'fundraisers',
    'games',
    'lite',
    'login.php',
    'recover',
    'r.php',
    'twitter',
    'instagram',
    'facebook',
]);
const IG_NAME = /^[A-Za-z0-9._]{1,30}$/;
const FB_NAME = /^[A-Za-z0-9.-]{3,80}$/;
const TT_NAME = /^[A-Za-z0-9._]{2,24}$/;

// One result URL -> { platform, handle, kind } or null. kind "profile" = the account's own page (best evidence),
// "post" = one of its posts/videos (the account still exists and posts about the topic).
export function handleFromUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    } catch {
        return null;
    }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase().replace(/^(www|m|web|mobile)\./, '');
    const segs = u.pathname.split('/').filter(Boolean);
    if (!segs.length) return null;
    if (host === 'instagram.com') {
        const name = segs[0];
        if (IG_RESERVED.has(name.toLowerCase()) || !IG_NAME.test(name)) return null;
        const kind = segs.length === 1 || !['p', 'reel', 'tv'].includes(segs[1]) ? 'profile' : 'post';
        return { platform: 'instagram', handle: name.toLowerCase(), kind };
    }
    if (host === 'tiktok.com') {
        if (!segs[0].startsWith('@')) return null;
        const name = decodeURIComponent(segs[0].slice(1));
        if (!TT_NAME.test(name)) return null;
        return { platform: 'tiktok', handle: name.toLowerCase(), kind: segs[1] === 'video' ? 'post' : 'profile' };
    }
    if (host === 'facebook.com') {
        const name = segs[0];
        if (FB_RESERVED.has(name.toLowerCase()) || !FB_NAME.test(name) || /^\d+$/.test(name)) return null;
        const kind =
            segs.length === 1 || (segs.length === 2 && ['about', 'posts', 'photos', 'videos'].includes(segs[1]))
                ? 'profile'
                : 'post';
        return { platform: 'facebook', handle: name, kind };
    }
    return null;
}

// The follower figure a snippet shows ("12.4K Followers, 300 Following ..."). Only a hint: never trusted or filtered on.
export function followerHint(text) {
    const m = String(text ?? '').match(/([\d][\d.,]*\s*[KMB]?)\s+(?:Followers|followers)/);
    return m ? m[1].replace(/\s+/g, '') : null;
}

const BLOCKED =
    /captcha|unusual traffic|verify you are|are you a robot|not a robot|automated (queries|requests)|bots use duckduckgo|anomaly|security check|too many requests|access denied|temporarily blocked|please solve|confirm this search was made by a human/i;
const NO_RESULTS =
    /no results (found )?for|did not match any|0 results|no web results|can't find anything|nothing matched/i;

// Pure: classify what a search page showed. anchors = [{ href, text, container }]
export function classifySearchPage({ title = '', text = '', anchors = [], platform }) {
    if (BLOCKED.test(title) || (text.length < 1500 && BLOCKED.test(text))) return { status: 'blocked' };
    const hits = [];
    const seenKey = new Set();
    let resultLinks = 0;
    for (const a of anchors) {
        const url = unwrapSearchUrl(a.href);
        if (!url) continue;
        const found = handleFromUrl(url);
        if (found) resultLinks += 1;
        if (!found || found.platform !== platform) continue;
        const key = `${found.platform}:${found.handle}:${found.kind}`;
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        hits.push({
            ...found,
            url,
            snippet: String(a.container || a.text || '').slice(0, 300),
            hint: followerHint(a.container),
        });
    }
    if (hits.length) return { status: 'ok', hits };
    if (NO_RESULTS.test(text)) return { status: 'no_results', hits: [] };
    return { status: resultLinks || anchors.length > 5 ? 'no_platform_results' : 'unrecognised', hits: [] };
}

// Runs in the page: every link with the text of the result block it sits in.
export function domSearchAnchors() {
    const blockOf = (a) => {
        let el = a;
        for (let i = 0; i < 6 && el.parentElement; i += 1) {
            el = el.parentElement;
            if (el.matches('li, article, .result, .snippet, [data-testid="result"], .b_algo')) return el;
        }
        return a.parentElement ?? a;
    };
    return [...document.querySelectorAll('a[href]')].slice(0, 600).map((a) => ({
        href: a.getAttribute('href'),
        text: (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        container: (blockOf(a).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    }));
}

export function domSearchPageInfo() {
    const text = document.body ? document.body.innerText : '';
    return { title: document.title || '', text: text.slice(0, 4000), length: text.length };
}

// ---- the flow (needs a browser page) ----

// Runs every keyword x platform query. Tries the engines in order for each query (an engine that blocks is skipped
// for the rest of the run). Returns { candidates, report }. The report lists, per query, which engine answered
// and what it showed, so a block or an unrecognised page is visible in the run output.
export async function discoverByWebSearch({
    page,
    keywords,
    excludeWords = [],
    platforms = ['instagram', 'facebook', 'tiktok'],
    engines = DEFAULT_ENGINES,
    maxPages = 2,
    maxQueries = 60,
    shouldContinue = () => true,
    log = () => {},
}) {
    const report = { queries: [], enginesBlocked: [], totalHits: 0 };
    const byKey = new Map();
    const blocked = new Set();
    const list = [];
    for (const keyword of keywords ?? []) {
        for (const platform of platforms)
            list.push({ platform, keyword, query: buildQuery({ platform, keyword, excludeWords }) });
    }
    for (const q of list.slice(0, maxQueries)) {
        if (!shouldContinue()) break;
        const entry = { platform: q.platform, keyword: q.keyword, query: q.query, attempts: [], handlesFound: 0 };
        report.queries.push(entry);
        for (const engineName of engines) {
            const engine = SEARCH_ENGINES[engineName];
            if (!engine || blocked.has(engineName)) continue;
            let got = 0;
            let outcome = 'error';
            let detail = null;
            for (let p = 0; p < maxPages; p += 1) {
                try {
                    await page.goto(engine.url(q.query, p), { waitUntil: 'domcontentloaded', timeout: 30_000 });
                    await page.waitForTimeout(1200);
                    const info = await page.evaluate(domSearchPageInfo);
                    const anchors = await page.evaluate(domSearchAnchors);
                    const res = classifySearchPage({
                        title: info.title,
                        text: info.text,
                        anchors,
                        platform: q.platform,
                    });
                    outcome = res.status;
                    if (res.status !== 'ok') {
                        detail = `${info.title} | ${info.text.replace(/\s+/g, ' ').slice(0, 160)}`;
                        break;
                    }
                    const before = got;
                    for (const h of res.hits) {
                        const key = `${h.platform}:${h.handle}`;
                        const cand = byKey.get(key) ?? {
                            platform: h.platform,
                            handle: h.handle,
                            queries: [],
                            timesSeen: 0,
                            profileHit: false,
                            snippet: null,
                            hint: null,
                            engines: [],
                        };
                        cand.timesSeen += 1;
                        if (!cand.queries.includes(q.keyword)) cand.queries.push(q.keyword);
                        if (!cand.engines.includes(engineName)) cand.engines.push(engineName);
                        if (h.kind === 'profile') cand.profileHit = true;
                        cand.snippet ??= h.snippet;
                        cand.hint ??= h.hint;
                        byKey.set(key, cand);
                        got += 1;
                    }
                    if (got === before) break; // a further page added nothing
                } catch (err) {
                    outcome = 'error';
                    detail = String(err?.message ?? err)
                        .split('\n')[0]
                        .slice(0, 160);
                    break;
                }
            }
            entry.attempts.push({
                engine: engineName,
                status: got ? 'ok' : outcome,
                results: got,
                ...(detail ? { detail } : {}),
            });
            if (outcome === 'blocked') {
                blocked.add(engineName);
                if (!report.enginesBlocked.includes(engineName)) report.enginesBlocked.push(engineName);
                log(
                    `${engine.label} answered with a bot check: not used any more in this run (nothing was solved or clicked through)`,
                );
            }
            if (got) {
                entry.handlesFound = got;
                break; // this engine answered: no need to ask the next one
            }
        }
    }
    const candidates = [...byKey.values()];
    report.totalHits = candidates.length;
    return { candidates, report };
}

// Candidates in the order they should be looked up: profile-page hits before post hits, then how often seen; the
// platforms take turns so one platform cannot use the whole budget. Handles in `exclude` (already in the tracker)
// are dropped and counted.
export function orderCandidates(candidates, { exclude = [], limit = 30, platforms = [] } = {}) {
    const skip = new Set((exclude ?? []).map((h) => String(h).trim().replace(/^@/, '').toLowerCase()));
    const dropped = [];
    const per = new Map();
    for (const c of candidates) {
        if (skip.has(c.handle.toLowerCase())) {
            dropped.push(c);
            continue;
        }
        if (!per.has(c.platform)) per.set(c.platform, []);
        per.get(c.platform).push(c);
    }
    const rank = (a, b) =>
        Number(b.profileHit) - Number(a.profileHit) || b.timesSeen - a.timesSeen || a.handle.localeCompare(b.handle);
    for (const arr of per.values()) arr.sort(rank);
    const order = platforms.length ? platforms.filter((p) => per.has(p)) : [...per.keys()];
    const out = [];
    for (let i = 0; out.length < limit; i += 1) {
        let any = false;
        for (const p of order) {
            const c = per.get(p)[i];
            if (c) {
                out.push(c);
                any = true;
                if (out.length >= limit) break;
            }
        }
        if (!any) break;
    }
    return { ordered: out, skippedDuplicates: dropped.map((c) => `${c.platform}:${c.handle}`) };
}
