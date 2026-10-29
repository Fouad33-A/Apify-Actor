import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { isLoginWall, normalizeGroup, parseGroupMeta, parsePosts } from './parse.js';

const DEFAULTS = { maxPostsPerGroup: 50, includeAuthors: false, delayBetweenGroupsMs: 3000, sinceDate: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chronologicalUrl = (url) => `${String(url).replace(/\/$/, '')}/?sorting_setting=CHRONOLOGICAL`;

export function readInput(raw) {
    const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)) };
    const groups = [], invalid = [];
    for (const g of input.groups ?? []) {
        const n = normalizeGroup(typeof g === 'string' ? g : g?.url);
        if (n.error) invalid.push(String(typeof g === 'string' ? g : g?.url)); else groups.push(n);
    }
    if (!groups.length && !invalid.length) throw new Error('Give at least one public group address in "groups".');
    const sinceMs = input.sinceDate ? Date.parse(input.sinceDate) : null;
    if (input.sinceDate && Number.isNaN(sinceMs)) throw new Error('"sinceDate" must be a date such as 2026-01-31.');
    return { ...input, groups, invalid, sinceMs, maxPostsPerGroup: Math.min(Math.max(1, input.maxPostsPerGroup), 500) };
}

function splitSetCookie(header) {
    if (!header) return [];
    if (Array.isArray(header)) return header;
    return String(header).split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map((x) => x.trim()).filter(Boolean);
}
function anonymousCookies(headers) {
    const raw = headers?.['set-cookie'] ?? headers?.['Set-Cookie'];
    return splitSetCookie(raw).map((line) => {
        const first = line.split(';', 1)[0];
        const eq = first.indexOf('=');
        if (eq < 1) return null;
        return { name: first.slice(0, eq).trim(), value: first.slice(eq + 1), domain: '.facebook.com', path: '/' };
    }).filter(Boolean);
}

export async function fetchGroup(url, { proxyUrl } = {}) {
    const res = await gotScraping({ url: chronologicalUrl(url), proxyUrl, throwHttpErrors: false, timeout: { request: 30_000 }, headers: { 'accept-language': 'en-US,en;q=0.9' } });
    return { status: res.statusCode, html: res.body, finalUrl: res.url, cookies: anonymousCookies(res.headers) };
}

function countFromText(text, word) {
    const match = new RegExp(`([\\d][\\d.,]*\\s*[KMB]?)\\s+${word}`, 'i').exec(String(text ?? ''));
    if (!match) return null;
    const m = /([\d][\d.,]*)\s*([KMB])?/i.exec(match[1]);
    if (!m) return null;
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
    return Math.round(Number.parseFloat(m[1].replace(/,/g, '')) * mult);
}
function proxyForPlaywright(proxyUrl) {
    const u = new URL(proxyUrl);
    return { server: `${u.protocol}//${u.host}`, ...(u.username ? { username: decodeURIComponent(u.username) } : {}), ...(u.password ? { password: decodeURIComponent(u.password) } : {}) };
}

export async function createLoggedOutBrowserReader({ proxyUrl, shouldStop = () => false } = {}) {
    const { chromium } = await import('playwright');
    const executablePath = process.env.APIFY_CHROME_EXECUTABLE_PATH || process.env.APIFY_DEFAULT_BROWSER_PATH || undefined;
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), ...(proxyUrl ? { proxy: proxyForPlaywright(proxyUrl) } : {}) });
    const close = async () => browser.close().catch(() => {});
    const read = async (group, { maxPosts = 50, includeAuthors = false, cookies = [] } = {}) => {
        const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1365, height: 900 } });
        if (cookies.length) await context.addCookies(cookies).catch((e) => log.warning(`Could not carry anonymous Facebook cookies into browser: ${e.message}`));
        const page = await context.newPage();
        let response = null;
        try {
            response = await page.goto(chronologicalUrl(group.url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
            await page.waitForTimeout(2500);
            const dismiss = async () => {
                await page.keyboard.press('Escape').catch(() => {});
                const b = page.locator('[role="dialog"] [aria-label="Close"], [role="dialog"] [aria-label="close"]');
                if (await b.count()) await b.first().click({ timeout: 1000 }).catch(() => {});
            };
            await dismiss();
            let last = -1;
            const rounds = Math.min(12, Math.max(3, Math.ceil(maxPosts / 3) + 1));
            for (let i = 0; i < rounds && !shouldStop(); i++) {
                const n = await page.locator('[role="feed"] [role="article"], div[role="article"]').count();
                if (n >= maxPosts) break;
                await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 1.5, 1000)));
                await page.waitForTimeout(n === last ? 1800 : 1200); await dismiss(); last = n;
            }
            const raw = await page.evaluate(({ limit, authors }) => {
                const nodes = [...document.querySelectorAll('[role="feed"] [role="article"], div[role="article"]')], seen = new Set(), out = [];
                for (const article of nodes) {
                    const links = [...article.querySelectorAll('a[href]')];
                    const permalink = links.map((a) => a.href).find((h) => /facebook\.com\/groups\/[^/]+\/posts\/\d+/i.test(h));
                    if (!permalink) continue;
                    const postId = /\/posts\/(\d+)/i.exec(permalink)?.[1] ?? null, key = postId ?? permalink;
                    if (seen.has(key)) continue; seen.add(key);
                    const text = (article.innerText || '').replace(/\n{3,}/g, '\n\n').trim(); if (!text) continue;
                    let createdAt = null;
                    for (const a of links.filter((x) => /\/posts\/\d+/i.test(x.href))) {
                        const d = Date.parse(a.getAttribute('aria-label') || a.getAttribute('title') || a.textContent || '');
                        if (Number.isFinite(d)) { createdAt = new Date(d).toISOString(); break; }
                    }
                    let author = null;
                    if (authors) {
                        const a = links.find((x) => { const h = x.getAttribute('href') || '', t = (x.textContent || '').trim(); return t && !/\/posts\/|\/groups\//i.test(h) && !/^(like|comment|share)$/i.test(t); });
                        author = a ? (a.textContent || '').trim() : null;
                    }
                    out.push({ postId, url: permalink.split('?')[0], text: text.slice(0, 5000), createdAt, author }); if (out.length >= limit) break;
                }
                return out;
            }, { limit: maxPosts, authors: includeAuthors });
            const posts = raw.map((p) => ({ ...p, reactions: countFromText(p.text, '(?:reactions?|likes?)'), comments: countFromText(p.text, 'comments?'), shares: countFromText(p.text, 'shares?'), ...(!includeAuthors ? { author: undefined } : {}) }));
            return { status: response?.status() ?? 200, html: await page.content(), finalUrl: page.url(), posts };
        } finally { await context.close().catch(() => {}); }
    };
    return { read, close };
}

export async function run({ input, pushData, fetch = fetchGroup, browserRead = null, saveDiagnostic = async () => null, shouldStop = () => false, now = () => new Date() }) {
    const totals = { groups: 0, ok: 0, loginWall: 0, posts: 0, diagnostics: 0, browserFallbacks: 0 };
    const stamp = () => now().toISOString();
    const capture = async (group, res, label) => { try { const k = await saveDiagnostic(group, res, label); if (k) totals.diagnostics++; return k; } catch (e) { log.warning(`Could not save diagnostic for group ${group.id}: ${e.message}`); return null; } };
    for (const bad of input.invalid) await pushData({ recordType: 'group', input: bad, status: 'invalid_input', statusDetail: 'Not a Facebook group address (https://www.facebook.com/groups/<name or id>)', scrapedAt: stamp() });
    for (const [i, group] of input.groups.entries()) {
        if (shouldStop()) break; totals.groups++;
        let desktop;
        try { desktop = await fetch(group.url); } catch (e) { await pushData({ recordType: 'group', groupId: group.id, url: group.url, status: 'error', statusDetail: String(e.message ?? e).split('\n')[0], scrapedAt: stamp() }); continue; }
        const base = { groupId: group.id, url: group.url };
        if (desktop.status >= 400) { await pushData({ recordType: 'group', ...base, status: desktop.status === 404 ? 'not_found' : 'http_error', statusDetail: `HTTP ${desktop.status}`, scrapedAt: stamp() }); continue; }
        const desktopMeta = parseGroupMeta(desktop.html), desktopWall = isLoginWall({ finalUrl: desktop.finalUrl, html: desktop.html });
        let selected = desktop, surface = 'desktop_html', posts = desktopWall ? [] : parsePosts(desktop.html, { includeAuthors: input.includeAuthors });
        const hasMeta = !desktopWall && (Boolean(desktopMeta.name && desktopMeta.name !== 'Facebook') || Boolean(desktopMeta.description));
        if (!posts.length && browserRead && hasMeta && !shouldStop()) {
            totals.browserFallbacks++;
            log.info(`group ${group.id}: public HTML has metadata but no feed records; continuing the same anonymous residential session in Chromium on the chronological feed.`);
            try {
                const rendered = await browserRead(group, { maxPosts: input.maxPostsPerGroup, includeAuthors: input.includeAuthors, cookies: desktop.cookies ?? [] });
                selected = rendered; surface = 'logged_out_browser_chronological'; posts = rendered.posts?.length ? rendered.posts : parsePosts(rendered.html, { includeAuthors: input.includeAuthors });
                log.info(`group ${group.id}: continued logged-out browser session rendered ${posts.length} public post(s).`);
            } catch (e) { log.warning(`group ${group.id}: logged-out browser continuation failed: ${e.message}`); }
        }
        if (input.sinceMs != null) posts = posts.filter((p) => p.createdAt && Number.isFinite(Date.parse(p.createdAt)) && Date.parse(p.createdAt) >= input.sinceMs);
        posts = posts.slice(0, input.maxPostsPerGroup);
        const sm = parseGroupMeta(selected.html), meta = { name: sm.name && sm.name !== 'Facebook' ? sm.name : desktopMeta.name, description: sm.description ?? desktopMeta.description, memberCount: sm.memberCount ?? desktopMeta.memberCount, privacy: sm.privacy ?? desktopMeta.privacy };
        const wall = isLoginWall({ finalUrl: selected.finalUrl, html: selected.html });
        if (wall && !posts.length && !hasMeta) {
            totals.loginWall++; const diagnosticKey = await capture(group, selected, surface);
            await pushData({ recordType: 'group', ...base, status: 'login_wall', statusDetail: 'Facebook returned no usable public group content; the Actor never logs in, supplies credentials, or bypasses the wall.', diagnosticKey, scrapedAt: stamp() });
        } else {
            const diagnosticKey = posts.length ? null : await capture(group, selected, surface);
            await pushData({ recordType: 'group', ...base, ...meta, postsVisible: posts.length, sourceSurface: surface, status: posts.length ? 'ok' : 'no_posts_visible', statusDetail: posts.length ? null : `Facebook exposed public group metadata but no parseable posts after the ${surface} attempt.`, diagnosticKey, scrapedAt: stamp() });
            for (const p of posts) await pushData({ recordType: 'post', groupId: group.id, groupUrl: group.url, sourceSurface: surface, ...p, status: 'ok', scrapedAt: stamp() });
            totals.posts += posts.length; if (posts.length) totals.ok++;
        }
        log.info(`group ${group.id} done`); if (i < input.groups.length - 1) await sleep(input.delayBetweenGroupsMs);
    }
    return { ...totals, note: 'Reads only public logged-out Facebook surfaces. Anonymous cookies set by Facebook during the Actor own initial public request may be carried into the same-IP browser continuation; no account cookies, credentials, access tokens, CAPTCHA solving, or private API credentials are used.' };
}

async function main() {
    await Actor.init(); let stop = false, browserReader = null;
    Actor.on('aborting', async () => { stop = true; await browserReader?.close?.().catch(() => {}); await sleep(500); await Actor.exit(); });
    try {
        const input = readInput(await Actor.getInput());
        const proxyConfiguration = input.proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
        const proxy = await Actor.createProxyConfiguration(proxyConfiguration); if (!proxy) throw new Error('Apify proxy configuration was not created.');
        const sessionId = `fb-public-${Math.random().toString(36).slice(2, 12)}`;
        const proxyUrl = await proxy.newUrl(sessionId);
        log.info(`Network route: ${input.proxyConfiguration ? 'input proxy configuration' : 'Apify RESIDENTIAL default'} with one sticky anonymous session; Facebook authentication is not used.`);
        browserReader = await createLoggedOutBrowserReader({ proxyUrl, shouldStop: () => stop });
        const summary = await run({ input, pushData: (r) => Actor.pushData(r), fetch: (u) => fetchGroup(u, { proxyUrl }), browserRead: browserReader.read,
            saveDiagnostic: async (group, res, label) => { const suffix = String(label ?? 'response').replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase(), key = `DIAGNOSTIC_GROUP_${String(group.id).replace(/[^A-Za-z0-9_-]/g, '_')}_${suffix}`; const header = `<!-- facebook-group-reader diagnostic\nrequested group: ${group.url}\nsurface: ${label}\nfinal: ${res.finalUrl}\nhttpStatus: ${res.status}\nExact logged-out response/render used by the Actor.\n-->\n`; await Actor.setValue(key, `${header}${res.html}`, { contentType: 'text/html; charset=utf-8' }); log.info(`Saved response diagnostic to key-value store key ${key} (${Buffer.byteLength(res.html, 'utf8')} bytes).`); return key; }, shouldStop: () => stop });
        await Actor.setValue('OUTPUT', summary); log.info(`Done: ${summary.groups} group(s), ${summary.posts} post(s), ${summary.loginWall} login-wall classification(s), ${summary.browserFallbacks} browser fallback(s), ${summary.diagnostics} diagnostic(s).`);
    } catch (e) { log.error(String(e.stack ?? e.message ?? e)); await Actor.fail(String(e.message ?? e)); return; } finally { await browserReader?.close?.().catch(() => {}); }
    await Actor.exit();
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
