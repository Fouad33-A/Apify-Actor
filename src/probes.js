// Diagnostic mode: fetch a few PUBLIC URLs through the run's proxy/browser and report
// what came back (status, final URL, title, truncated text, embedded JSON markers), so
// approaches can be compared in one run instead of one build per guess.
//
// Deliberately narrow: HTTPS GET only, instagram/facebook/tiktok hosts only, at most
// MAX_PROBES per run, a small header allowlist, truncated output. It reports login walls
// and blocks as they are; it never tries to get past them.

export const MAX_PROBES = 12;
const NAV_TIMEOUT_MS = 45_000;
const HEAD_CHARS = 6000;
const TEXT_CHARS = 1500;
const JSON_HEAD_CHARS = 1500;
const ALLOWED_HOST = /(^|\.)(instagram|facebook|tiktok)\.com$/i;
const ALLOWED_HEADERS = new Set(['x-ig-app-id', 'x-asbd-id', 'x-requested-with', 'accept', 'accept-language']);

export function validateProbe(probe) {
    let url;
    try {
        url = new URL(probe?.url);
    } catch {
        return { ok: false, reason: 'invalid url' };
    }
    if (url.protocol !== 'https:') return { ok: false, reason: 'only https URLs are allowed' };
    if (!ALLOWED_HOST.test(url.hostname)) return { ok: false, reason: `host not allowed: ${url.hostname}` };
    const type = probe.type ?? 'page';
    if (type !== 'page' && type !== 'fetch') return { ok: false, reason: `unknown type: ${type}` };
    return { ok: true, url, type };
}

export function sanitizeHeaders(headers = {}) {
    const clean = {};
    for (const [k, v] of Object.entries(headers)) {
        if (ALLOWED_HEADERS.has(k.toLowerCase())) clean[k.toLowerCase()] = String(v);
    }
    return clean;
}

const MAX_GREP_TERMS = 8;
const MAX_GREP_HITS = 3;

// Literal (not regex) search; returns short snippets around the first few matches.
export function grepText(text, terms) {
    const out = {};
    for (const term of (terms ?? []).slice(0, MAX_GREP_TERMS)) {
        const needle = String(term).slice(0, 60);
        if (!needle) continue;
        const hits = [];
        let from = 0;
        while (hits.length < MAX_GREP_HITS) {
            const i = text.indexOf(needle, from);
            if (i === -1) break;
            hits.push(text.slice(Math.max(0, i - 200), i + needle.length + 300));
            from = i + needle.length;
        }
        out[needle] = hits;
    }
    return out;
}

// Walks a JSON document along `path` (array of keys, so keys containing dots work).
export function extractJsonPath(jsonText, path) {
    let node;
    try {
        node = JSON.parse(jsonText);
    } catch {
        return { error: 'script content is not valid JSON' };
    }
    for (const key of path ?? []) {
        if (node == null || typeof node !== 'object' || !(key in node)) {
            return {
                error: `path not found at "${key}"`,
                keysAtFailure: node && typeof node === 'object' ? Object.keys(node).slice(0, 40) : null,
            };
        }
        node = node[key];
    }
    return {
        keys: node && typeof node === 'object' ? Object.keys(node).slice(0, 60) : null,
        head: JSON.stringify(node)?.slice(0, 6000) ?? null,
    };
}

// Runs in the page: compact outline of the visible DOM (tag, role/aria/href, own text, text length).
function outlinePage({ selector, maxDepth, maxLines }) {
    const root = document.querySelector(selector) || document.body;
    const lines = [];
    const short = (v, n) => (v || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const ownText = (el) =>
        short(
            [...el.childNodes]
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent)
                .join(' '),
            80,
        );
    const attrsOf = (el) => {
        const parts = [];
        for (const a of ['role', 'aria-label', 'title', 'datetime']) {
            const v = el.getAttribute(a);
            if (v) parts.push(`${a}="${short(v, 40)}"`);
        }
        if (el.tagName === 'A' && el.getAttribute('href')) parts.push(`href="${short(el.getAttribute('href'), 70)}"`);
        return parts.length ? ` ${parts.join(' ')}` : '';
    };
    const walk = (start, depth) => {
        if (lines.length >= maxLines || depth > maxDepth) return;
        let el = start;
        const total = short(el.innerText, 100000).length;
        if (!total) return;
        while (el.children.length === 1 && !ownText(el) && !attrsOf(el)) el = el.children[0];
        lines.push(`${'  '.repeat(depth)}<${el.tagName.toLowerCase()}${attrsOf(el)}> ${ownText(el)} [${total}ch]`);
        for (const child of el.children) walk(child, depth + 1);
    };
    walk(root, 0);
    return lines;
}

// Runs in the page: summarises the document without dumping it.
function summarizePage(limits) {
    const jsonScripts = [...document.querySelectorAll('script')]
        .filter((s) => {
            const id = s.id || '';
            return (
                s.type === 'application/json' ||
                s.type === 'application/ld+json' ||
                /REHYDRATION|NEXT_DATA|SIGI_STATE|sharedData/i.test(id)
            );
        })
        .slice(0, 12)
        .map((s) => ({
            id: s.id || null,
            type: s.type || null,
            length: s.textContent.length,
            head: s.textContent.slice(0, limits.jsonHead),
        }));
    const meta = (p) => {
        const el = document.querySelector(`meta[property="${p}"]`);
        return el ? el.content : null;
    };
    return {
        title: document.title,
        ogTitle: meta('og:title'),
        ogDescription: meta('og:description'),
        bodyText: (document.body ? document.body.innerText : '').slice(0, limits.text),
        jsonScripts,
    };
}

async function probePage(context, url, probe) {
    const page = await context.newPage();
    try {
        const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await page.waitForTimeout(probe.waitMs ?? 2500);
        const summary = await page.evaluate(summarizePage, { jsonHead: JSON_HEAD_CHARS, text: TEXT_CHARS });
        const html = await page.content();
        const extra = {};
        if (probe.grep) extra.grep = grepText(html, probe.grep);
        if (probe.outline) {
            extra.outline = await page.evaluate(outlinePage, {
                selector: String(probe.outline.selector ?? 'body'),
                maxDepth: Math.min(Number(probe.outline.maxDepth ?? 10), 20),
                maxLines: Math.min(Number(probe.outline.maxLines ?? 150), 300),
            });
        }
        if (probe.jsonScriptId) {
            const text = await page.evaluate((id) => {
                const el = document.getElementById(id);
                return el ? el.textContent : null;
            }, String(probe.jsonScriptId));
            extra.json = text == null ? { error: 'script id not found' } : extractJsonPath(text, probe.jsonPath);
        }
        return {
            httpStatus: response ? response.status() : null,
            finalUrl: page.url(),
            htmlLength: html.length,
            ...summary,
            ...extra,
        };
    } finally {
        await page.close();
    }
}

async function probeFetch(context, url, probe) {
    const page = await context.newPage();
    try {
        // Load the site's own origin first so the request is same-origin with normal cookies.
        await page.goto(`${url.origin}/`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await page.waitForTimeout(1500);
        const result = await page.evaluate(
            async ({ target, headers, headChars }) => {
                const r = await fetch(target, { headers, credentials: 'include' });
                const text = await r.text();
                return {
                    httpStatus: r.status,
                    finalUrl: r.url,
                    redirected: r.redirected,
                    contentType: r.headers.get('content-type'),
                    bodyLength: text.length,
                    bodyHead: text.slice(0, headChars),
                    fullBody: text.length <= 400_000 ? text : null,
                };
            },
            { target: url.href, headers: sanitizeHeaders(probe.headers), headChars: HEAD_CHARS },
        );
        const { fullBody, ...rest } = result;
        return probe.grep && fullBody ? { ...rest, grep: grepText(fullBody, probe.grep) } : rest;
    } finally {
        await page.close();
    }
}

export async function runProbes({ context, probes }) {
    const results = [];
    for (const probe of (probes ?? []).slice(0, MAX_PROBES)) {
        const check = validateProbe(probe);
        if (!check.ok) {
            results.push({ url: probe?.url ?? null, error: check.reason });
            continue;
        }
        try {
            const data =
                check.type === 'fetch'
                    ? await probeFetch(context, check.url, probe)
                    : await probePage(context, check.url, probe);
            results.push({ url: check.url.href, type: check.type, ...data });
        } catch (err) {
            results.push({ url: check.url.href, type: check.type, error: String(err?.message ?? err).split('\n')[0] });
        }
    }
    return results;
}
