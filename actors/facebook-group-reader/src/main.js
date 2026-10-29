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
    const res = await gotScraping({
        url,
        proxyUrl,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    return { status: res.statusCode, html: res.body, finalUrl: res.url };
}

function mobileGroupUrl(group) {
    return `https://m.facebook.com/groups/${encodeURIComponent(group.id)}/`;
}

export async function run({
    input,
    pushData,
    fetch = fetchGroup,
    saveDiagnostic = async () => null,
    shouldStop = () => false,
    now = () => new Date(),
}) {
    const totals = { groups: 0, ok: 0, loginWall: 0, posts: 0, diagnostics: 0, mobileFallbacks: 0 };
    const stamp = () => now().toISOString();

    const captureDiagnostic = async (group, res, label = 'desktop') => {
        try {
            const key = await saveDiagnostic(group, res, label);
            if (key) totals.diagnostics += 1;
            return key;
        } catch (error) {
            log.warning(`Could not save diagnostic for group ${group.id}: ${String(error?.message ?? error)}`);
            return null;
        }
    };

    for (const bad of input.invalid) {
        await pushData({
            recordType: 'group',
            input: bad,
            status: 'invalid_input',
            statusDetail: 'Not a Facebook group address (https://www.facebook.com/groups/<name or id>)',
            scrapedAt: stamp(),
        });
    }

    for (const [i, group] of input.groups.entries()) {
        if (shouldStop()) break;
        totals.groups += 1;

        let desktop;
        try {
            desktop = await fetch(group.url);
        } catch (error) {
            await pushData({
                recordType: 'group',
                groupId: group.id,
                url: group.url,
                status: 'error',
                statusDetail: String(error?.message ?? error).split('\n')[0],
                scrapedAt: stamp(),
            });
            continue;
        }

        const base = { groupId: group.id, url: group.url };
        if (desktop.status >= 400) {
            await pushData({
                recordType: 'group',
                ...base,
                status: desktop.status === 404 ? 'not_found' : 'http_error',
                statusDetail: `HTTP ${desktop.status}`,
                scrapedAt: stamp(),
            });
            continue;
        }

        const desktopMeta = parseGroupMeta(desktop.html);
        let selected = desktop;
        let selectedSurface = 'desktop';
        let posts = isLoginWall({ finalUrl: desktop.finalUrl, html: desktop.html })
            ? []
            : parsePosts(desktop.html, { includeAuthors: input.includeAuthors });

        // A logged-out desktop group response can contain real public metadata but only
        // a Comet shell. In that case, try Facebook's own advertised mobile surface once.
        // This remains a normal logged-out public request: no cookies, tokens, login,
        // GraphQL replay, hidden endpoint, or access-control bypass is used.
        if (!posts.length && !shouldStop()) {
            totals.mobileFallbacks += 1;
            const mobileUrl = mobileGroupUrl(group);
            log.info(`group ${group.id}: desktop returned no parseable posts; trying logged-out mobile public surface ${mobileUrl}`);
            try {
                const mobile = await fetch(mobileUrl);
                if (mobile.status < 400 && !isLoginWall({ finalUrl: mobile.finalUrl, html: mobile.html })) {
                    const mobilePosts = parsePosts(mobile.html, { includeAuthors: input.includeAuthors });
                    if (mobilePosts.length) {
                        selected = mobile;
                        selectedSurface = 'mobile';
                        posts = mobilePosts;
                    } else {
                        selected = mobile;
                        selectedSurface = 'mobile';
                    }
                } else {
                    selected = mobile;
                    selectedSurface = 'mobile';
                }
            } catch (error) {
                log.warning(`group ${group.id}: mobile public surface failed: ${String(error?.message ?? error)}`);
            }
        }

        if (input.sinceMs != null) posts = posts.filter((p) => Date.parse(p.createdAt) >= input.sinceMs);
        posts = posts.slice(0, input.maxPostsPerGroup);

        const selectedLoginWall = isLoginWall({ finalUrl: selected.finalUrl, html: selected.html });
        const meta = parseGroupMeta(selected.html);
        const mergedMeta = {
            name: meta.name && meta.name !== 'Facebook' ? meta.name : desktopMeta.name,
            description: meta.description ?? desktopMeta.description,
            memberCount: meta.memberCount ?? desktopMeta.memberCount,
            privacy: meta.privacy ?? desktopMeta.privacy,
        };

        if (selectedLoginWall && !posts.length && !mergedMeta.name && !mergedMeta.description) {
            totals.loginWall += 1;
            const diagnosticKey = await captureDiagnostic(group, selected, selectedSurface);
            await pushData({
                recordType: 'group',
                ...base,
                status: 'login_wall',
                statusDetail: 'Facebook returned no usable public group content to the logged-out request. The exact response was saved for validation; the Actor did not authenticate or bypass the wall.',
                diagnosticKey,
                scrapedAt: stamp(),
            });
        } else {
            const diagnosticKey = posts.length ? null : await captureDiagnostic(group, selected, selectedSurface);
            await pushData({
                recordType: 'group',
                ...base,
                name: mergedMeta.name,
                description: mergedMeta.description,
                memberCount: mergedMeta.memberCount,
                privacy: mergedMeta.privacy,
                postsVisible: posts.length,
                sourceSurface: selectedSurface,
                status: posts.length ? 'ok' : 'no_posts_visible',
                statusDetail: posts.length
                    ? null
                    : `Facebook returned public group metadata but no parseable feed records on the logged-out ${selectedSurface} surface. The exact already-fetched response was saved for validation; no authentication or access-control bypass was used.`,
                diagnosticKey,
                scrapedAt: stamp(),
            });

            for (const p of posts) {
                await pushData({
                    recordType: 'post',
                    groupId: group.id,
                    groupUrl: group.url,
                    sourceSurface: selectedSurface,
                    ...p,
                    status: 'ok',
                    scrapedAt: stamp(),
                });
            }
            totals.posts += posts.length;
            if (posts.length) totals.ok += 1;
        }

        log.info(`group ${group.id} done`);
        if (i < input.groups.length - 1) await sleep(input.delayBetweenGroupsMs);
    }

    return {
        ...totals,
        note: 'Only content Facebook returns to logged-out public web surfaces is read. The Actor uses Apify proxy infrastructure but never logs in, supplies Facebook cookies/tokens, replays private GraphQL requests, or bypasses access controls. If the desktop group response contains metadata but no feed, one request to Facebook’s public mobile group URL is tried.',
    };
}

async function main() {
    await Actor.init();
    let stop = false;
    Actor.on('aborting', async () => {
        stop = true;
        await sleep(1000);
        await Actor.exit();
    });

    try {
        const input = readInput(await Actor.getInput());
        const proxyConfiguration = input.proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
        let proxy;
        try {
            proxy = await Actor.createProxyConfiguration(proxyConfiguration);
        } catch (error) {
            throw new Error(`Could not initialize the configured Apify proxy: ${String(error?.message ?? error)}`);
        }
        if (!proxy) throw new Error('Apify proxy configuration was not created. Public Facebook group access requires the configured proxy route.');

        const proxyUrl = await proxy.newUrl();
        log.info(`Network route: ${input.proxyConfiguration ? 'input proxy configuration' : 'Apify RESIDENTIAL default'}; Facebook login/cookies are not used.`);

        const summary = await run({
            input,
            pushData: (r) => Actor.pushData(r),
            fetch: (u) => fetchGroup(u, { proxyUrl }),
            saveDiagnostic: async (group, res, label) => {
                const suffix = String(label ?? 'response').replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase();
                const key = `DIAGNOSTIC_GROUP_${String(group.id).replace(/[^A-Za-z0-9_-]/g, '_')}_${suffix}`;
                const header = `<!-- facebook-group-reader diagnostic\nrequested group: ${group.url}\nsurface: ${label}\nfinal: ${res.finalUrl}\nhttpStatus: ${res.status}\nThis is the exact already-fetched logged-out public response used by the parser/classifier.\n-->\n`;
                await Actor.setValue(key, `${header}${res.html}`, { contentType: 'text/html; charset=utf-8' });
                log.info(`Saved response diagnostic to key-value store key ${key} (${Buffer.byteLength(res.html, 'utf8')} bytes); no extra diagnostic request.`);
                return key;
            },
            shouldStop: () => stop,
        });

        await Actor.setValue('OUTPUT', summary);
        log.info(`Done: ${summary.groups} group(s), ${summary.posts} post(s), ${summary.loginWall} login-wall classification(s), ${summary.mobileFallbacks} mobile fallback(s), ${summary.diagnostics} response diagnostic(s).`);
    } catch (error) {
        log.error(String(error?.message ?? error));
        await Actor.fail(String(error?.message ?? error));
        return;
    }

    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
