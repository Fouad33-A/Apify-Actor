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
        return {
            httpStatus: response ? response.status() : null,
            finalUrl: page.url(),
            htmlLength: html.length,
            ...summary,
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
        return await page.evaluate(
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
                };
            },
            { target: url.href, headers: sanitizeHeaders(probe.headers), headChars: HEAD_CHARS },
        );
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
