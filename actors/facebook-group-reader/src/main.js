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

export async function run({
    input,
    pushData,
    fetch = fetchGroup,
    saveDiagnostic = async () => null,
    shouldStop = () => false,
    now = () => new Date(),
}) {
    const totals = { groups: 0, ok: 0, loginWall: 0, posts: 0, diagnostics: 0 };
    const stamp = () => now().toISOString();

    const captureDiagnostic = async (group, res) => {
        try {
            const key = await saveDiagnostic(group, res);
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
            const diagnosticKey = await captureDiagnostic(group, res);
            await pushData({
                recordType: 'group',
                ...base,
                status: 'login_wall',
                statusDetail:
                    'Facebook returned a response classified as a login wall. The exact already-fetched response was saved for validation because a login prompt can coexist with publicly visible group content in a browser. The Actor did not make another Facebook request or authenticate.',
                diagnosticKey,
                scrapedAt: stamp(),
            });
        } else {
            const meta = parseGroupMeta(res.html);
            let posts = parsePosts(res.html, { includeAuthors: input.includeAuthors });
            if (input.sinceMs != null) posts = posts.filter((p) => Date.parse(p.createdAt) >= input.sinceMs);
            posts = posts.slice(0, input.maxPostsPerGroup);
            const diagnosticKey = posts.length ? null : await captureDiagnostic(group, res);
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
                    : 'The public group page loaded without a login-wall classification, but the current parser found no posts. A diagnostic copy of that already-fetched response was saved for parser validation; no extra Facebook request was made.',
                diagnosticKey,
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
        note: 'Only what Facebook returns to a logged-out visitor is read. The Actor uses Apify proxy infrastructure but never logs in or supplies Facebook cookies/tokens. Responses classified as login walls are also saved as diagnostics because a dismissible login prompt can coexist with public group content.',
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
            saveDiagnostic: async (group, res) => {
                const key = `DIAGNOSTIC_GROUP_${String(group.id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
                const header = `<!-- facebook-group-reader diagnostic\nrequested: ${group.url}\nfinal: ${res.finalUrl}\nhttpStatus: ${res.status}\nThis is the exact already-fetched logged-out public response used by the parser/classifier.\n-->\n`;
                await Actor.setValue(key, `${header}${res.html}`, { contentType: 'text/html; charset=utf-8' });
                log.info(`Saved response diagnostic to key-value store key ${key} (${Buffer.byteLength(res.html, 'utf8')} bytes); no extra Facebook request.`);
                return key;
            },
            shouldStop: () => stop,
        });
        await Actor.setValue('OUTPUT', summary);
        log.info(
            `Done: ${summary.groups} group(s), ${summary.posts} post(s), ${summary.loginWall} login-wall classification(s), ${summary.diagnostics} response diagnostic(s).`,
        );
    } catch (error) {
        log.error(String(error?.message ?? error));
        await Actor.fail(String(error?.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
