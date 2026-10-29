import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

import { isLoginWall, normalizeGroup, parseGroupMeta, parsePosts } from './parse.js';

const DEFAULTS = { maxPostsPerGroup: 50, includeAuthors: false, delayBetweenGroupsMs: 3000, sinceDate: null };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readInput(raw) {
    const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)) };
    const groups = [];
    const invalid = [];
    for (const g of input.groups ?? []) {
        const n = normalizeGroup(typeof g === 'string' ? g : g?.url);
        if (n.error) invalid.push(String(typeof g === 'string' ? g : g?.url));
        else groups.push(n);
    }
    if (!groups.length && !invalid.length) throw new Error('Give at least one public group address in "groups".');
    const sinceMs = input.sinceDate ? Date.parse(input.sinceDate) : null;
    if (input.sinceDate && Number.isNaN(sinceMs)) throw new Error('"sinceDate" must be a date such as 2026-01-31.');
    return { ...input, groups, invalid, sinceMs, maxPostsPerGroup: Math.min(Math.max(1, input.maxPostsPerGroup), 500) };
}

export async function fetchGroup(url, { proxyUrl } = {}) {
    const res = await gotScraping({ url, proxyUrl, throwHttpErrors: false, timeout: { request: 30_000 }, headers: { 'accept-language': 'en-US,en;q=0.9' } });
    return { status: res.statusCode, html: res.body, finalUrl: res.url };
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
    const browser = await chromium.launch({ headless: true, ...(proxyUrl ? { proxy: proxyForPlaywright(proxyUrl) } : {}) });
    const close = async () => browser.close().catch(() => {});

    const read = async (group, { maxPosts = 50, includeAuthors = false } = {}) => {
        const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1365, height: 900 } });
        const page = await context.newPage();
        let response = null;
        try {
            response = await page.goto(`${group.url}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
            await page.waitForTimeout(2500);
            const dismissPrompt = async () => {
                await page.keyboard.press('Escape').catch(() => {});
                const closeButtons = page.locator('[role="dialog"] [aria-label="Close"], [role="dialog"] [aria-label="close"]');
                if (await closeButtons.count()) await closeButtons.first().click({ timeout: 1000 }).catch(() => {});
            };
            await dismissPrompt();

            let lastArticleCount = -1;
            const rounds = Math.min(12, Math.max(3, Math.ceil(maxPosts / 3) + 1));
            for (let i = 0; i < rounds && !shouldStop(); i += 1) {
                const articleCount = await page.locator('[role="feed"] [role="article"], div[role="article"]').count();
                if (articleCount >= maxPosts) break;
                await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 1.5, 1000)));
                await page.waitForTimeout(articleCount === lastArticleCount ? 1800 : 1200);
                await dismissPrompt();
                lastArticleCount = articleCount;
            }

            const rawPosts = await page.evaluate(({ limit, authors }) => {
                const candidates = [...document.querySelectorAll('[role="feed"] [role="article"], div[role="article"]')];
                const seen = new Set();
                const out = [];
                for (const article of candidates) {
                    const links = [...article.querySelectorAll('a[href]')];
                    const permalink = links.map((a) => a.href).find((href) => /facebook\.com\/groups\/[^/]+\/posts\/\d+/i.test(href));
                    if (!permalink) continue;
                    const postId = /\/posts\/(\d+)/i.exec(permalink)?.[1] ?? null;
                    const key = postId ?? permalink;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const fullText = (article.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
                    if (!fullText) continue;
                    let createdAt = null;
                    for (const a of links.filter((x) => x.href === permalink || /\/posts\/\d+/i.test(x.href))) {
                        const label = a.getAttribute('aria-label') || a.getAttribute('title') || a.textContent || '';
                        const parsed = Date.parse(label);
                        if (Number.isFinite(parsed)) { createdAt = new Date(parsed).toISOString(); break; }
                    }
                    let author = null;
                    if (authors) {
                        const authorLink = links.find((a) => {
                            const href = a.getAttribute('href') || '';
                            const text = (a.textContent || '').trim();
                            return text && !/\/posts\/|\/groups\//i.test(href) && !/^(like|comment|share)$/i.test(text);
                        });
                        author = authorLink ? (authorLink.textContent || '').trim() : null;
                    }
                    out.push({ postId, url: permalink.split('?')[0], text: fullText.slice(0, 5000), createdAt, author });
                    if (out.length >= limit) break;
                }
                return out;
            }, { limit: maxPosts, authors: includeAuthors });

            const posts = rawPosts.map((p) => ({ postId: p.postId, url: p.url, text: p.text, createdAt: p.createdAt, reactions: countFromText(p.text, '(?:reactions?|likes?)'), comments: countFromText(p.text, 'comments?'), shares: countFromText(p.text, 'shares?'), ...(includeAuthors ? { author: p.author } : {}) }));
            return { status: response?.status() ?? 200, html: await page.content(), finalUrl: page.url(), posts };
        } finally {
            await context.close().catch(() => {});
        }
    };
    return { read, close };
}

export async function run({ input, pushData, fetch = fetchGroup, browserRead = null, saveDiagnostic = async () => null, shouldStop = () => false, now = () => new Date() }) {
    const totals = { groups: 0, ok: 0, loginWall: 0, posts: 0, diagnostics: 0, browserFallbacks: 0 };
    const stamp = () => now().toISOString();
    const captureDiagnostic = async (group, res, label = 'desktop') => {
        try { const key = await saveDiagnostic(group, res, label); if (key) totals.diagnostics += 1; return key; }
        catch (error) { log.warning(`Could not save diagnostic for group ${group.id}: ${String(error?.message ?? error)}`); return null; }
    };

    for (const bad of input.invalid) await pushData({ recordType: 'group', input: bad, status: 'invalid_input', statusDetail: 'Not a Facebook group address (https://www.facebook.com/groups/<name or id>)', scrapedAt: stamp() });

    for (const [i, group] of input.groups.entries()) {
        if (shouldStop()) break;
        totals.groups += 1;
        let desktop;
        try { desktop = await fetch(group.url); }
        catch (error) { await pushData({ recordType: 'group', groupId: group.id, url: group.url, status: 'error', statusDetail: String(error?.message ?? error).split('\n')[0], scrapedAt: stamp() }); continue; }

        const base = { groupId: group.id, url: group.url };
        if (desktop.status >= 400) { await pushData({ recordType: 'group', ...base, status: desktop.status === 404 ? 'not_found' : 'http_error', statusDetail: `HTTP ${desktop.status}`, scrapedAt: stamp() }); continue; }

        const desktopMeta = parseGroupMeta(desktop.html);
        const desktopWall = isLoginWall({ finalUrl: desktop.finalUrl, html: desktop.html });
        let selected = desktop;
        let selectedSurface = 'desktop_html';
        let posts = desktopWall ? [] : parsePosts(desktop.html, { includeAuthors: input.includeAuthors });
        const hasPublicMeta = !desktopWall && (Boolean(desktopMeta.name && desktopMeta.name !== 'Facebook') || Boolean(desktopMeta.description));

        if (!posts.length && browserRead && hasPublicMeta && !shouldStop()) {
            totals.browserFallbacks += 1;
            log.info(`group ${group.id}: initial HTML has public metadata but no feed records; loading the same public group in a logged-out browser session.`);
            try {
                const rendered = await browserRead(group, { maxPosts: input.maxPostsPerGroup, includeAuthors: input.includeAuthors });
                selected = rendered;
                selectedSurface = 'logged_out_browser';
                posts = rendered.posts?.length ? rendered.posts : parsePosts(rendered.html, { includeAuthors: input.includeAuthors });
                log.info(`group ${group.id}: logged-out browser rendered ${posts.length} public post(s).`);
            } catch (error) { log.warning(`group ${group.id}: logged-out browser load failed: ${String(error?.message ?? error)}`); }
        }

        if (input.sinceMs != null) posts = posts.filter((p) => p.createdAt && Number.isFinite(Date.parse(p.createdAt)) && Date.parse(p.createdAt) >= input.sinceMs);
        posts = posts.slice(0, input.maxPostsPerGroup);
        const selectedMeta = parseGroupMeta(selected.html);
        const mergedMeta = { name: selectedMeta.name && selectedMeta.name !== 'Facebook' ? selectedMeta.name : desktopMeta.name, description: selectedMeta.description ?? desktopMeta.description, memberCount: selectedMeta.memberCount ?? desktopMeta.memberCount, privacy: selectedMeta.privacy ?? desktopMeta.privacy };
        const selectedWall = isLoginWall({ finalUrl: selected.finalUrl, html: selected.html });

        if (selectedWall && !posts.length && !hasPublicMeta) {
            totals.loginWall += 1;
            const diagnosticKey = await captureDiagnostic(group, selected, selectedSurface);
            await pushData({ recordType: 'group', ...base, status: 'login_wall', statusDetail: 'Facebook returned no usable public group content; the Actor never logs in, supplies credentials, or bypasses the wall.', diagnosticKey, scrapedAt: stamp() });
        } else {
            const diagnosticKey = posts.length ? null : await captureDiagnostic(group, selected, selectedSurface);
            await pushData({ recordType: 'group', ...base, name: mergedMeta.name, description: mergedMeta.description, memberCount: mergedMeta.memberCount, privacy: mergedMeta.privacy, postsVisible: posts.length, sourceSurface: selectedSurface, status: posts.length ? 'ok' : 'no_posts_visible', statusDetail: posts.length ? null : `Facebook exposed public group metadata but no parseable posts after the ${selectedSurface} attempt. The exact response was saved for validation.`, diagnosticKey, scrapedAt: stamp() });
            for (const p of posts) await pushData({ recordType: 'post', groupId: group.id, groupUrl: group.url, sourceSurface: selectedSurface, ...p, status: 'ok', scrapedAt: stamp() });
            totals.posts += posts.length;
            if (posts.length) totals.ok += 1;
        }
        log.info(`group ${group.id} done`);
        if (i < input.groups.length - 1) await sleep(input.delayBetweenGroupsMs);
    }
    return { ...totals, note: 'Reads only what Facebook exposes to a normal logged-out public browser session. It does not use a Facebook account, supplied Facebook cookies, access tokens, CAPTCHA solving, or private API credentials.' };
}

async function main() {
    await Actor.init();
    let stop = false;
    let browserReader = null;
    Actor.on('aborting', async () => { stop = true; await browserReader?.close?.().catch(() => {}); await sleep(500); await Actor.exit(); });
    try {
        const input = readInput(await Actor.getInput());
        const proxyConfiguration = input.proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
        const proxy = await Actor.createProxyConfiguration(proxyConfiguration);
        if (!proxy) throw new Error('Apify proxy configuration was not created.');
        const proxyUrl = await proxy.newUrl();
        log.info(`Network route: ${input.proxyConfiguration ? 'input proxy configuration' : 'Apify RESIDENTIAL default'}; Facebook authentication is not used.`);
        browserReader = await createLoggedOutBrowserReader({ proxyUrl, shouldStop: () => stop });
        const summary = await run({
            input, pushData: (r) => Actor.pushData(r), fetch: (u) => fetchGroup(u, { proxyUrl }), browserRead: browserReader.read,
            saveDiagnostic: async (group, res, label) => {
                const suffix = String(label ?? 'response').replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase();
                const key = `DIAGNOSTIC_GROUP_${String(group.id).replace(/[^A-Za-z0-9_-]/g, '_')}_${suffix}`;
                const header = `<!-- facebook-group-reader diagnostic\nrequested group: ${group.url}\nsurface: ${label}\nfinal: ${res.finalUrl}\nhttpStatus: ${res.status}\nExact logged-out response/render used by the Actor.\n-->\n`;
                await Actor.setValue(key, `${header}${res.html}`, { contentType: 'text/html; charset=utf-8' });
                log.info(`Saved response diagnostic to key-value store key ${key} (${Buffer.byteLength(res.html, 'utf8')} bytes).`);
                return key;
            }, shouldStop: () => stop,
        });
        await Actor.setValue('OUTPUT', summary);
        log.info(`Done: ${summary.groups} group(s), ${summary.posts} post(s), ${summary.loginWall} login-wall classification(s), ${summary.browserFallbacks} browser fallback(s), ${summary.diagnostics} diagnostic(s).`);
    } catch (error) { log.error(String(error?.stack ?? error?.message ?? error)); await Actor.fail(String(error?.message ?? error)); return; }
    finally { await browserReader?.close?.().catch(() => {}); }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
