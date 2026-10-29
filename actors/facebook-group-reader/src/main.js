import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { isLoginWall, normalizeGroup, parseGroupMeta, parsePosts } from './parse.js';

const DEFAULTS = { maxPostsPerGroup: 50, includeAuthors: false, delayBetweenGroupsMs: 3000, sinceDate: null };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chronologicalUrl = (url) => `${String(url).replace(/\/$/, '')}/?sorting_setting=CHRONOLOGICAL`;

export function readInput(raw) {
    const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, value]) => value != null)) };
    const groups = [];
    const invalid = [];
    for (const value of input.groups ?? []) {
        const original = typeof value === 'string' ? value : value?.url;
        const normalized = normalizeGroup(original);
        if (normalized.error) invalid.push(String(original));
        else groups.push(normalized);
    }
    if (!groups.length && !invalid.length) throw new Error('Give at least one public group address in "groups".');
    const sinceMs = input.sinceDate ? Date.parse(input.sinceDate) : null;
    if (input.sinceDate && Number.isNaN(sinceMs)) throw new Error('"sinceDate" must be a date such as 2026-01-31.');
    return {
        ...input,
        groups,
        invalid,
        sinceMs,
        maxPostsPerGroup: Math.min(Math.max(1, Number(input.maxPostsPerGroup) || 50), 500),
    };
}

function splitSetCookie(header) {
    if (!header) return [];
    if (Array.isArray(header)) return header;
    return String(header).split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map((part) => part.trim()).filter(Boolean);
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
    const response = await gotScraping({
        url: chronologicalUrl(url),
        proxyUrl,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    return {
        status: response.statusCode,
        html: response.body,
        finalUrl: response.url,
        cookies: anonymousCookies(response.headers),
    };
}

function countFromText(text, word) {
    const match = new RegExp(`([\\d][\\d.,]*\\s*[KMB]?)\\s+${word}`, 'i').exec(String(text ?? ''));
    if (!match) return null;
    const number = /([\d][\d.,]*)\s*([KMB])?/i.exec(match[1]);
    if (!number) return null;
    const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[(number[2] || '').toUpperCase()] || 1;
    return Math.round(Number.parseFloat(number[1].replace(/,/g, '')) * multiplier);
}

function proxyForPlaywright(proxyUrl) {
    const url = new URL(proxyUrl);
    return {
        server: `${url.protocol}//${url.host}`,
        ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
        ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    };
}

export async function createLoggedOutBrowserReader({ proxyUrl, shouldStop = () => false } = {}) {
    const { chromium } = await import('playwright');
    const executablePath = process.env.APIFY_CHROME_EXECUTABLE_PATH || process.env.APIFY_DEFAULT_BROWSER_PATH || undefined;
    const browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        ...(proxyUrl ? { proxy: proxyForPlaywright(proxyUrl) } : {}),
    });

    const close = async () => browser.close().catch(() => {});

    const read = async (group, { maxPosts = 50, includeAuthors = false, cookies = [] } = {}) => {
        const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1365, height: 900 } });
        if (cookies.length) await context.addCookies(cookies).catch(() => {});
        const page = await context.newPage();
        let response = null;
        let consentAction = 'not_present';

        const dismissLoginModal = async () => {
            await page.keyboard.press('Escape').catch(() => {});
            const closeButton = page.locator('[role="dialog"] [aria-label="Close"], [role="dialog"] [aria-label="close"]');
            if (await closeButton.count()) await closeButton.first().click({ timeout: 1200 }).catch(() => {});
        };

        const handleCookieConsent = async () => {
            const choices = [
                { label: 'declined_optional', re: /decline optional cookies|only allow essential cookies|reject optional cookies/i },
                { label: 'accepted', re: /allow all cookies|accept all cookies|^allow cookies$/i },
            ];
            for (const choice of choices) {
                const button = page.getByRole('button', { name: choice.re });
                if (await button.count()) {
                    const clicked = await button.first().click({ timeout: 2500 }).then(() => true).catch(() => false);
                    if (clicked) {
                        consentAction = choice.label;
                        await page.waitForTimeout(1200);
                        return true;
                    }
                }
            }
            return false;
        };

        const collectVisible = async () => page.evaluate(({ limit, authors }) => {
            const nodes = [...document.querySelectorAll('[role="feed"] [role="article"], div[role="article"], div[data-pagelet^="FeedUnit"]')];
            const output = [];
            for (const article of nodes) {
                const links = [...article.querySelectorAll('a[href]')];
                const permalink = links.map((a) => a.href).find((href) => /facebook\.com\/groups\/[^/]+\/(?:posts|permalink)\/\d+/i.test(href));
                if (!permalink) continue;
                const postId = /\/(?:posts|permalink)\/(\d+)/i.exec(permalink)?.[1] ?? null;
                const text = (article.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
                if (!text) continue;
                let createdAt = null;
                for (const link of links.filter((item) => /\/(?:posts|permalink)\/\d+/i.test(item.href))) {
                    const parsed = Date.parse(link.getAttribute('aria-label') || link.getAttribute('title') || link.textContent || '');
                    if (Number.isFinite(parsed)) {
                        createdAt = new Date(parsed).toISOString();
                        break;
                    }
                }
                let author = null;
                if (authors) {
                    const link = links.find((item) => {
                        const href = item.getAttribute('href') || '';
                        const label = (item.textContent || '').trim();
                        return label && !/\/(?:posts|permalink)\/|\/groups\//i.test(href) && !/^(like|comment|share)$/i.test(label);
                    });
                    author = link ? (link.textContent || '').trim() : null;
                }
                output.push({ postId, url: permalink.split('?')[0], text: text.slice(0, 5000), createdAt, author });
                if (output.length >= limit) break;
            }
            return output;
        }, { limit: maxPosts, authors: includeAuthors });

        try {
            const target = chronologicalUrl(group.url);
            response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
            await page.waitForTimeout(1800);
            if (await handleCookieConsent()) {
                response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
                await page.waitForTimeout(2200);
            }
            await dismissLoginModal();

            const collected = new Map();
            const merge = async () => {
                const structured = parsePosts(await page.content(), { includeAuthors });
                const visible = await collectVisible();
                for (const post of [...structured, ...visible]) {
                    const key = post.postId || post.url;
                    if (!key) continue;
                    const previous = collected.get(key) ?? {};
                    collected.set(key, { ...previous, ...post });
                }
                return collected.size;
            };

            await merge();
            let stagnant = 0;
            const maxRounds = Math.min(30, Math.max(8, maxPosts * 3));
            for (let round = 0; round < maxRounds && !shouldStop() && collected.size < maxPosts; round++) {
                const before = collected.size;
                await dismissLoginModal();
                await page.evaluate(() => {
                    const articles = [...document.querySelectorAll('[role="feed"] [role="article"], div[role="article"], div[data-pagelet^="FeedUnit"]')];
                    const last = articles[articles.length - 1];
                    if (last) last.scrollIntoView({ block: 'end', behavior: 'instant' });
                    window.scrollBy(0, Math.max(window.innerHeight * 1.8, 1400));
                });
                await page.waitForTimeout(stagnant ? 2200 : 1400);
                await merge();
                stagnant = collected.size === before ? stagnant + 1 : 0;
                if (stagnant >= 3) {
                    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                    await page.waitForTimeout(2800);
                    const beforeBottom = collected.size;
                    await merge();
                    if (collected.size === beforeBottom) break;
                    stagnant = 0;
                }
            }

            const posts = [...collected.values()].slice(0, maxPosts).map((post) => ({
                ...post,
                reactions: post.reactions ?? countFromText(post.text, '(?:reactions?|likes?)'),
                comments: post.comments ?? countFromText(post.text, 'comments?'),
                shares: post.shares ?? countFromText(post.text, 'shares?'),
                ...(!includeAuthors ? { author: undefined, authorId: undefined } : {}),
            }));
            return {
                status: response?.status() ?? 200,
                html: await page.content(),
                finalUrl: page.url(),
                posts,
                consentAction,
                browserCookies: await context.cookies('https://www.facebook.com/').catch(() => []),
            };
        } finally {
            await context.close().catch(() => {});
        }
    };

    return { read, close };
}

function mergePosts(primary, secondary) {
    const merged = new Map();
    for (const post of [...primary, ...secondary]) {
        const key = post.postId || post.url;
        if (!key) continue;
        const old = merged.get(key) ?? {};
        merged.set(key, {
            ...old,
            ...post,
            text: old.text && old.text.length >= (post.text?.length ?? 0) ? old.text : post.text,
            createdAt: old.createdAt ?? post.createdAt,
            reactions: old.reactions ?? post.reactions,
            comments: old.comments ?? post.comments,
            shares: old.shares ?? post.shares,
            author: old.author ?? post.author,
            authorId: old.authorId ?? post.authorId,
        });
    }
    return [...merged.values()].sort((a, b) => {
        const ta = Date.parse(a.createdAt ?? '') || 0;
        const tb = Date.parse(b.createdAt ?? '') || 0;
        return tb - ta;
    });
}

export async function run({ input, pushData, fetch = fetchGroup, browserRead = null, saveDiagnostic = async () => null, shouldStop = () => false, now = () => new Date() }) {
    const totals = { groups: 0, ok: 0, loginWall: 0, posts: 0, diagnostics: 0, browserFallbacks: 0 };
    const stamp = () => now().toISOString();
    const capture = async (group, response, label) => {
        try {
            const key = await saveDiagnostic(group, response, label);
            if (key) totals.diagnostics++;
            return key;
        } catch (error) {
            log.warning(`Could not save diagnostic for group ${group.id}: ${error.message}`);
            return null;
        }
    };

    for (const bad of input.invalid) {
        await pushData({ recordType: 'group', input: bad, status: 'invalid_input', statusDetail: 'Not a Facebook group address (https://www.facebook.com/groups/<name or id>)', scrapedAt: stamp() });
    }

    for (const [index, group] of input.groups.entries()) {
        if (shouldStop()) break;
        totals.groups++;
        let desktop;
        try {
            desktop = await fetch(group.url);
        } catch (error) {
            await pushData({ recordType: 'group', groupId: group.id, url: group.url, status: 'error', statusDetail: String(error.message ?? error).split('\n')[0], scrapedAt: stamp() });
            continue;
        }

        const base = { groupId: group.id, url: group.url };
        if (desktop.status >= 400) {
            await pushData({ recordType: 'group', ...base, status: desktop.status === 404 ? 'not_found' : 'http_error', statusDetail: `HTTP ${desktop.status}`, scrapedAt: stamp() });
            continue;
        }

        const desktopMeta = parseGroupMeta(desktop.html);
        const desktopWall = isLoginWall({ finalUrl: desktop.finalUrl, html: desktop.html });
        let posts = desktopWall ? [] : parsePosts(desktop.html, { includeAuthors: input.includeAuthors });
        let selected = desktop;
        let surface = 'desktop_html';

        if (posts.length < input.maxPostsPerGroup && browserRead && !shouldStop()) {
            totals.browserFallbacks++;
            log.info(`group ${group.id}: HTTP exposed ${posts.length}/${input.maxPostsPerGroup} requested post(s); deepening the same public logged-out feed in Chromium.`);
            try {
                const rendered = await browserRead(group, {
                    maxPosts: input.maxPostsPerGroup,
                    includeAuthors: input.includeAuthors,
                    cookies: desktop.cookies ?? [],
                });
                const renderedPosts = rendered.posts?.length ? rendered.posts : parsePosts(rendered.html, { includeAuthors: input.includeAuthors });
                if (renderedPosts.length) {
                    posts = mergePosts(posts, renderedPosts);
                    selected = rendered;
                    surface = 'desktop_html+logged_out_browser';
                } else if (!posts.length) {
                    selected = rendered;
                    surface = 'logged_out_browser';
                }
                log.info(`group ${group.id}: public browser depth pass exposed ${renderedPosts.length} post(s); merged total=${posts.length}; final=${rendered.finalUrl}`);
            } catch (error) {
                log.warning(`group ${group.id}: public browser depth pass failed: ${error.message}`);
            }
        }

        if (input.sinceMs != null) {
            posts = posts.filter((post) => post.createdAt && Number.isFinite(Date.parse(post.createdAt)) && Date.parse(post.createdAt) >= input.sinceMs);
        }
        posts = posts.slice(0, input.maxPostsPerGroup);

        const selectedMeta = parseGroupMeta(selected.html);
        const meta = {
            name: selectedMeta.name && selectedMeta.name !== 'Facebook' ? selectedMeta.name : desktopMeta.name,
            description: selectedMeta.description ?? desktopMeta.description,
            memberCount: selectedMeta.memberCount ?? desktopMeta.memberCount,
            privacy: selectedMeta.privacy ?? desktopMeta.privacy,
        };
        const wall = isLoginWall({ finalUrl: selected.finalUrl, html: selected.html });

        if (wall && !posts.length) {
            totals.loginWall++;
            const diagnosticKey = await capture(group, selected, surface);
            await pushData({
                recordType: 'group',
                ...base,
                ...meta,
                postsVisible: 0,
                sourceSurface: surface,
                status: 'login_wall',
                statusDetail: 'Facebook redirected the logged-out public feed to login. Public group metadata may still be available, but posts were not exposed to this anonymous session.',
                diagnosticKey,
                scrapedAt: stamp(),
            });
        } else {
            const diagnosticKey = posts.length ? null : await capture(group, selected, surface);
            await pushData({
                recordType: 'group',
                ...base,
                ...meta,
                postsVisible: posts.length,
                sourceSurface: surface,
                status: posts.length ? 'ok' : 'no_posts_visible',
                statusDetail: posts.length ? null : `Facebook exposed no parseable public posts after the ${surface} attempt.`,
                diagnosticKey,
                scrapedAt: stamp(),
            });
            for (const post of posts) {
                await pushData({ recordType: 'post', groupId: group.id, groupUrl: group.url, sourceSurface: surface, ...post, status: 'ok', scrapedAt: stamp() });
            }
            totals.posts += posts.length;
            if (posts.length) totals.ok++;
        }

        log.info(`group ${group.id} done`);
        if (index < input.groups.length - 1) await sleep(input.delayBetweenGroupsMs);
    }

    return {
        ...totals,
        note: 'Reads only public logged-out Facebook surfaces. Structured public HTML is parsed first; when it exposes fewer posts than requested, a normal logged-out Chromium visit may scroll the same public feed to load more. No Facebook account cookies, credentials, access tokens, CAPTCHA solving, or private API calls are used.',
    };
}

async function main() {
    await Actor.init();
    let stop = false;
    let browserReader = null;
    Actor.on('aborting', async () => {
        stop = true;
        await browserReader?.close?.().catch(() => {});
        await sleep(500);
        await Actor.exit();
    });

    try {
        const input = readInput(await Actor.getInput());
        const proxyConfiguration = input.proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
        const proxy = await Actor.createProxyConfiguration(proxyConfiguration);
        if (!proxy) throw new Error('Apify proxy configuration was not created.');
        const sessionId = `fb_public_${Math.random().toString(36).slice(2, 12)}`;
        const proxyUrl = await proxy.newUrl(sessionId);
        log.info(`Network route: ${input.proxyConfiguration ? 'input proxy configuration' : 'Apify RESIDENTIAL default'} with one sticky anonymous session; Facebook authentication is not used.`);
        browserReader = await createLoggedOutBrowserReader({ proxyUrl, shouldStop: () => stop });
        const summary = await run({
            input,
            pushData: (record) => Actor.pushData(record),
            fetch: (url) => fetchGroup(url, { proxyUrl }),
            browserRead: browserReader.read,
            saveDiagnostic: async (group, response, label) => {
                const suffix = String(label ?? 'response').replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase();
                const key = `DIAGNOSTIC_GROUP_${String(group.id).replace(/[^A-Za-z0-9_-]/g, '_')}_${suffix}`;
                const cookieNames = Array.isArray(response.browserCookies) ? [...new Set(response.browserCookies.map((cookie) => cookie.name))].join(',') : '';
                const header = `<!-- facebook-group-reader diagnostic\nrequested group: ${group.url}\nsurface: ${label}\nfinal: ${response.finalUrl}\nhttpStatus: ${response.status}\nconsentAction: ${response.consentAction ?? 'n/a'}\nanonymousBrowserCookieNames: ${cookieNames}\nExact logged-out response/render used by the Actor. Cookie values are not stored in this diagnostic header.\n-->\n`;
                await Actor.setValue(key, `${header}${response.html}`, { contentType: 'text/html; charset=utf-8' });
                log.info(`Saved response diagnostic to key-value store key ${key} (${Buffer.byteLength(response.html, 'utf8')} bytes).`);
                return key;
            },
            shouldStop: () => stop,
        });
        await Actor.setValue('OUTPUT', summary);
        log.info(`Done: ${summary.groups} group(s), ${summary.posts} post(s), ${summary.loginWall} login-wall classification(s), ${summary.browserFallbacks} browser fallback(s), ${summary.diagnostics} diagnostic(s).`);
    } catch (error) {
        log.error(String(error.stack ?? error.message ?? error));
        await Actor.fail(String(error.message ?? error));
        return;
    } finally {
        await browserReader?.close?.().catch(() => {});
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
