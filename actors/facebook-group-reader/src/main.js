import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

import { isLoginWall, normalizeGroup, parseGroupMeta, parsePosts } from './parse.js';

const DEFAULTS = { maxPostsPerGroup: 50, includeAuthors: false, delayBetweenGroupsMs: 3000, sinceDate: null };
const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

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

export async function run({ input, pushData, fetch = fetchGroup, shouldStop = () => false, now = () => new Date() }) {
    const totals = { groups: 0, ok: 0, loginWall: 0, posts: 0 };
    const stamp = () => now().toISOString();
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
        let res;
        try {
            res = await fetch(group.url);
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
        if (res.status >= 400) {
            await pushData({
                recordType: 'group',
                ...base,
                status: res.status === 404 ? 'not_found' : 'http_error',
                statusDetail: `HTTP ${res.status}`,
                scrapedAt: stamp(),
            });
        } else if (isLoginWall({ finalUrl: res.finalUrl, html: res.html })) {
            totals.loginWall += 1;
            await pushData({
                recordType: 'group',
                ...base,
                status: 'login_wall',
                statusDetail:
                    'Facebook showed its login page instead of the group. This Actor never logs in or uses cookies, so nothing was read. The group may be private, or Facebook may not show public groups to this kind of visitor.',
                scrapedAt: stamp(),
            });
        } else {
            const meta = parseGroupMeta(res.html);
            let posts = parsePosts(res.html, { includeAuthors: input.includeAuthors });
            if (input.sinceMs != null) posts = posts.filter((p) => Date.parse(p.createdAt) >= input.sinceMs);
            posts = posts.slice(0, input.maxPostsPerGroup);
            await pushData({
                recordType: 'group',
                ...base,
                name: meta.name,
                description: meta.description,
                memberCount: meta.memberCount,
                privacy: meta.privacy,
                postsVisible: posts.length,
                status: posts.length ? 'ok' : 'no_posts_visible',
                statusDetail: posts.length
                    ? null
                    : 'the page loaded without a login but no posts could be read from it (they may need scrolling or a login to show)',
                scrapedAt: stamp(),
            });
            for (const p of posts)
                await pushData({
                    recordType: 'post',
                    groupId: group.id,
                    groupUrl: group.url,
                    ...p,
                    status: 'ok',
                    scrapedAt: stamp(),
                });
            totals.posts += posts.length;
            if (posts.length) totals.ok += 1;
        }
        log.info(`group ${group.id} done`);
        if (i < input.groups.length - 1) await sleep(input.delayBetweenGroupsMs);
    }
    return {
        ...totals,
        note: 'Only what a public group shows to a logged-out visitor is read: no login, cookie or token. A group page that redirects to the Facebook login is reported as login_wall.',
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
        const proxy = input.proxyConfiguration ? await Actor.createProxyConfiguration(input.proxyConfiguration) : null;
        const proxyUrl = proxy ? await proxy.newUrl() : undefined;
        const summary = await run({
            input,
            pushData: (r) => Actor.pushData(r),
            fetch: (u) => fetchGroup(u, { proxyUrl }),
            shouldStop: () => stop,
        });
        await Actor.setValue('OUTPUT', summary);
        log.info(
            `Done: ${summary.groups} group(s), ${summary.posts} post(s), ${summary.loginWall} behind a login wall.`,
        );
    } catch (error) {
        log.error(String(error?.message ?? error));
        await Actor.fail(String(error?.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
