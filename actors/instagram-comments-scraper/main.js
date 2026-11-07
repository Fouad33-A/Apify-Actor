import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

const VERSION = '2026-11-07-v2.15-coverage';
const dateCutoff = (value) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('sinceDate must be a valid YYYY-MM-DD date');
    return Date.parse(value);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

function normalizeUrl(raw) {
    try {
        const u = new URL(String(raw).trim());
        if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
        const m = u.pathname.match(/^\/(p|reel|reels)\/([A-Za-z0-9_-]+)/i);
        if (!m) return null;
        const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
        return `https://www.instagram.com/${kind}/${m[2]}/`;
    } catch { return null; }
}
function shortcodeFromUrl(url) { return url.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/i)?.[1] ?? null; }
function shortcodeToMediaId(sc) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let n = 0n;
    for (const c of sc) { const i = alphabet.indexOf(c); if (i >= 0) n = n * 64n + BigInt(i); }
    return n.toString();
}
function isComment(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const u = o.user ?? o.owner;
    return typeof o.text === 'string' && (o.pk ?? o.id) != null && u && typeof (u.username ?? u.user_name) === 'string';
}
function rowFromNode(n, postUrl, isReply = false, owner = null) {
    const u = n.user ?? n.owner ?? {};
    const ts = n.created_at ?? n.created_at_utc ?? n.created_time ?? n.taken_at;
    let createdAt = null;
    if (typeof ts === 'number') createdAt = new Date(ts * 1000).toISOString();
    else if (typeof ts === 'string') createdAt = ts;
    return {
        platform: 'instagram', postUrl, postOwnerHandle: owner,
        commentId: String(n.pk ?? n.id ?? '') || null, commentText: n.text ?? null,
        commenterHandle: u.username ?? u.user_name ?? null,
        likes: n.comment_like_count ?? n.like_count ?? n.likes_count ?? null,
        replyCount: n.child_comment_count ?? n.reply_count ?? null,
        isReply: Boolean(isReply), createdAt, scrapedAt: now(),
    };
}
function harvest(root, postUrl, owner = null) {
    const out = [], seen = new Set();
    function walk(v, path = '') {
        if (!v || typeof v !== 'object' || seen.has(v)) return;
        seen.add(v);
        if (isComment(v)) out.push(rowFromNode(v, postUrl, /child|repl/i.test(path), owner));
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
        else Object.entries(v).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k));
    }
    walk(root); return out;
}
function embeddedJson(html) {
    const vals = [];
    const re = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    for (const m of html.matchAll(re)) { try { vals.push(JSON.parse(m[1])); } catch {} }
    return vals;
}
function findOwner(root) {
    let answer = null; const seen = new Set();
    function walk(v) {
        if (answer || !v || typeof v !== 'object' || seen.has(v)) return;
        seen.add(v);
        if (typeof v.username === 'string' && (v.is_verified !== undefined || v.full_name !== undefined)) answer = v.username;
        if (Array.isArray(v)) v.forEach(walk); else Object.values(v).forEach(walk);
    }
    walk(root); return answer;
}
function cursorFrom(j) {
    return j?.next_min_id ?? j?.next_max_id ?? j?.next_page_cursor ?? j?.pagination?.next_min_id ?? null;
}
async function proxyUrl(enabled, mode = 'residential') {
    if (!enabled || mode === 'none') return null;
    const cfg = await Actor.createProxyConfiguration(mode === 'datacenter' ? {} : { groups: ['RESIDENTIAL'] });
    return cfg.newUrl();
}
function safeDiagBody(body) {
    if (typeof body !== 'string') return null;
    return body.replace(/https?:\/\/[^\s"']+:[^\s"']+@/g, 'https://***:***@').slice(0, 240);
}
async function requestJson(client, url, headers) {
    try {
        const r = await client.get(url, { headers, throwHttpErrors: false, followRedirect: false, timeout: { request: 18000 } });
        let json = null; try { json = JSON.parse(r.body); } catch {}
        return { status: r.statusCode, type: r.headers['content-type'] ?? null, location: r.headers.location ?? null, json, body: r.body };
    } catch (e) { return { error: String(e?.message ?? e).slice(0, 220) }; }
}

async function scrapePost(postUrl, cap, minLikes, includeReplies, pUrl, sinceMs = null) {
    const jar = new CookieJar();
    const client = gotScraping.extend({
        cookieJar: jar, proxyUrl: pUrl || undefined,
        retry: { limit: 0 }, timeout: { request: 22000 },
        headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 130 }], devices: ['desktop'], locales: ['en-US'] },
    });
    const rows = new Map();
    let dateExcluded = 0;
    const diag = { bootstrap: null, ssrRows: 0, contracts: [], sourceCoverage: 'unknown', paginationVerified: false };
    const add = (list) => {
        for (const r of list) {
            if (!includeReplies && r.isReply) continue;
            if (Number(r.likes ?? 0) < minLikes) continue;
            if (sinceMs != null && r.createdAt && !Number.isNaN(Date.parse(r.createdAt)) && Date.parse(r.createdAt) < sinceMs) { dateExcluded++; continue; }
            const k = r.commentId || `${r.commenterHandle}|${r.commentText}`;
            if (!rows.has(k) && rows.size < cap) rows.set(k, r);
        }
    };

    const boot = await client.get(postUrl, { throwHttpErrors: false, timeout: { request: 25000 } });
    diag.bootstrap = { status: boot.statusCode, type: boot.headers['content-type'] ?? null, bytes: boot.body?.length ?? 0 };
    if (boot.statusCode >= 400) throw new Error(`Bootstrap HTTP ${boot.statusCode}`);
    const roots = embeddedJson(boot.body || '');
    let owner = null;
    for (const root of roots) { owner ||= findOwner(root); add(harvest(root, postUrl, owner)); }
    diag.ssrRows = rows.size;
    diag.sourceCoverage = rows.size >= cap ? 'requested_cap_reached_from_html' : 'embedded_html_only_or_api_unverified';

    const mediaId = shortcodeToMediaId(shortcodeFromUrl(postUrl));
    const baseHeaders = {
        accept: '*/*', 'accept-language': 'en-US,en;q=0.9',
        'x-ig-app-id': '936619743392459',
        'x-requested-with': 'XMLHttpRequest', referer: postUrl,
        origin: 'https://www.instagram.com',
    };
    const contracts = [
        { name: 'www_web_comments', host: 'https://www.instagram.com' },
        { name: 'i_web_comments', host: 'https://i.instagram.com' },
    ];
    for (const contract of contracts) {
        if (rows.size >= cap) break;
        let cursor = null, stagnant = 0;
        const cd = { name: contract.name, pages: [] };
        for (let page = 1; page <= 40 && rows.size < cap; page++) {
            const qs = new URLSearchParams({ can_support_threading: 'true', permalink_enabled: 'false' });
            if (cursor) qs.set('min_id', cursor);
            const url = `${contract.host}/api/v1/media/${mediaId}/comments/?${qs.toString()}`;
            const res = await requestJson(client, url, baseHeaders);
            if (res.error) { cd.pages.push({ page, error: res.error }); break; }
            const found = res.json ? harvest(res.json, postUrl, owner) : [];
            const before = rows.size; add(found); const added = rows.size - before;
            const next = res.json ? cursorFrom(res.json) : null;
            cd.pages.push({ page, status: res.status, type: res.type, harvested: found.length, added, statusField: res.json?.status ?? null, message: res.json?.message ?? null, cursor: Boolean(next), redirect: res.location ? true : false, body: res.json ? null : safeDiagBody(res.body) });
            if (res.status !== 200 || !res.json || res.json?.status === 'fail') break;
            if (found.length > 0) diag.paginationVerified = true;
            if (!next || next === cursor) break;
            cursor = String(next);
            stagnant = added === 0 ? stagnant + 1 : 0;
            if (stagnant >= 2) break;
            await sleep(180 + Math.floor(Math.random() * 180));
        }
        diag.contracts.push(cd);
    }
    if (diag.paginationVerified) diag.sourceCoverage = 'api_comments_accessible';
    return { rows: [...rows.values()].slice(0, cap), diag, dateExcluded };
}

await Actor.init();
const started = Date.now();
try {
    const input = await Actor.getInput() || {};
    const allowed = new Set(['postUrls','maxCommentsPerPost','includeReplies','minLikes','maxItems','maxVideosPerCreator','useResidentialProxy','runLabel','sinceDate','proxyMode']);
    const unknown = Object.keys(input).filter((k) => !allowed.has(k));
    if (unknown.length) throw new Error(`Unknown input field(s): ${unknown.join(', ')}`);
    if (!Array.isArray(input.postUrls) || !input.postUrls.length) throw new Error('postUrls is required and must be a non-empty array.');
    const maxPer = Math.max(1, Math.min(1000, Number(input.maxCommentsPerPost ?? 300)));
    const maxItems = Math.max(1, Math.min(5000, Number(input.maxItems ?? 500)));
    const maxVPC = Math.max(1, Math.min(100, Number(input.maxVideosPerCreator ?? 10)));
    const minLikes = Math.max(0, Number(input.minLikes ?? 0));
    const includeReplies = Boolean(input.includeReplies ?? false);
    const useResidentialProxy = Boolean(input.useResidentialProxy ?? true);
    const runLabel = input.runLabel == null ? null : String(input.runLabel);
    const proxyMode = input.proxyMode ?? (useResidentialProxy ? 'residential' : 'none');
    if (!['residential','datacenter','none'].includes(proxyMode)) throw new Error('proxyMode must be residential, datacenter or none');
    const sinceMs = dateCutoff(input.sinceDate);
    const urls = [...new Set(input.postUrls.map(normalizeUrl).filter(Boolean))];
    let skipped = input.postUrls.length - urls.length, returned = 0, noData = 0, dateExcluded = 0, postsWithComments = 0, blockedPosts = 0;
    const requestDiagnostics = [];
    let partialCoveragePosts = 0, verifiedPaginationPosts = 0;
    const errors = [];
    const pUrl = await proxyUrl(useResidentialProxy, proxyMode);
    log.info(`[${VERSION}] browserless got-scraping persistent-session candidate. login=false externalProvider=false proxy=${Boolean(pUrl)}`);
    let processed = 0;
    for (const postUrl of urls) {
        if (returned >= maxItems) break;
        if (processed >= urls.length * maxVPC) { skipped++; continue; }
        processed++;
        const amount = Math.min(maxPer, maxItems - returned);
        try {
            const { rows, diag, dateExcluded: excluded } = await scrapePost(postUrl, amount, minLikes, includeReplies, pUrl, sinceMs);
            dateExcluded += excluded;
            requestDiagnostics.push({ postUrl, ...diag });
            if (diag.paginationVerified) verifiedPaginationPosts++;
            else if (rows.length > 0 && rows.length < amount) partialCoveragePosts++;
            for (const row of rows) { await Actor.pushData({ ...row, recordType: 'comment', status: 'ok', sourceUrl: postUrl, runLabel, text: row.commentText, author: row.commenterHandle }); returned++; }
            if (rows.length) postsWithComments++;
            if (!rows.length) {
                const pages = diag.contracts.flatMap(c => c.pages ?? []);
                const denied = pages.length > 0 && pages.every(p => p.error || p.redirect || p.status !== 200 || p.statusField === 'fail');
                if (denied) blockedPosts++;
                const reason = denied ? 'comments_access_unavailable' : excluded > 0 ? 'no_matching_comments' : 'no_public_comments';
                errors.push({ url: postUrl, reason: `${reason}. diag=${JSON.stringify(diag).slice(0, 4000)}` });
                if (returned < maxItems) { await Actor.pushData({ recordType: 'no_data', status: denied ? 'blocked' : 'no_data', postUrl, sourceUrl: postUrl, runLabel, scrapedAt: now(), reason }); returned++; noData++; }
            }
            log.info(`[POST] returned=${rows.length} requestedCap=${amount} diag=${JSON.stringify(diag)}`);
        } catch (e) {
            const reason = String(e?.message ?? e).slice(0, 3000);
            errors.push({ url: postUrl, reason }); log.warning(`[POST ERROR] ${postUrl} ${reason}`);
            if (returned < maxItems) { await Actor.pushData({ recordType: 'no_data', status: 'error', postUrl, sourceUrl: postUrl, runLabel, scrapedAt: now(), reason: 'request_failed' }); returned++; noData++; }
        }
    }
    await Actor.setValue('errors', errors);
    await Actor.setValue('REQUEST_DIAGNOSTICS', requestDiagnostics);
    const summary = {
        version: VERSION, itemsRequested: input.postUrls.length, returned, skipped, errors: errors.length,
        status: blockedPosts > 0 || partialCoveragePosts > 0 || errors.some(e => e.reason.startsWith('request_failed') || !e.reason.startsWith('no_') && !e.reason.startsWith('comments_access_unavailable')) || returned >= maxItems && processed < urls.length ? 'partial' : 'completed',
        stoppedBecause: returned >= maxItems && processed < urls.length ? 'maxItems' : 'completed',
        itemsEmitted: returned, noData, blockedPosts, partialCoveragePosts, verifiedPaginationPosts, proxyMode, dateExcluded, postsWithComments, runLabel, sinceDate: input.sinceDate ?? null,
        exactInput: { ...input, maxItems, maxCommentsPerPost: maxPer, maxVideosPerCreator: maxVPC },
        seconds: Number(((Date.now() - started) / 1000).toFixed(2)), publicDataOnly: true, loginUsed: false,
        externalProviderUsed: false, source: 'instagram_public_got_scraping_v213', residentialProxyRequested: useResidentialProxy,
        residentialProxyUsed: Boolean(pUrl), includeRepliesRequested: includeReplies,
        coverageNote: 'Public Instagram only; no Instagram credentials, supplied cookies, browser, external scraper/provider, or database.',
    };
    await Actor.setValue('SUMMARY', summary); log.info(`[FINAL] ${JSON.stringify(summary)}`);
} finally { await Actor.exit(); }
