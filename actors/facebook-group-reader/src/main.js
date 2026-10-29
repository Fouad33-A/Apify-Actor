import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { isLoginWall, normalizeGroup, parseGroupMeta, parsePosts } from './parse.js';

const DEFAULTS = {
    maxPostsPerGroup: 50,
    includeAuthors: false,
    delayBetweenGroupsMs: 3000,
    sinceDate: null,
    maxSessionAttempts: 1,
};

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
        maxSessionAttempts: Math.min(Math.max(1, Number(input.maxSessionAttempts) || 1), 3),
    };
}

function requestOptions(proxyUrl, extra = {}) {
    return {
        proxyUrl,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: { 'accept-language': 'en-US,en;q=0.9', ...extra.headers },
        ...extra,
    };
}

export async function fetchGroup(url, { proxyUrl } = {}) {
    const response = await gotScraping({ url: chronologicalUrl(url), ...requestOptions(proxyUrl) });
    return { status: response.statusCode, html: response.body, finalUrl: response.url };
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
    return [...merged.values()].sort((a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0));
}

function decodeHtmlUrl(value) {
    return String(value).replace(/\\u0025/g, '%').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
}

function extractPublicFeedBootstrap(html) {
    const source = String(html ?? '');
    const groupId = /"groupID"\s*:\s*"(\d+)"/.exec(source)?.[1]
        ?? /"id"\s*:\s*"(\d+)"[^]{0,500}"group_address"/.exec(source)?.[1]
        ?? null;
    const lsd = /"LSD"\s*,\s*\[\]\s*,\s*\{"token":"([^"]+)"/.exec(source)?.[1] ?? null;
    const spinR = /"__spin_r"\s*:\s*(\d+)/.exec(source)?.[1] ?? null;
    const spinB = /"__spin_b"\s*:\s*"([^"]+)"/.exec(source)?.[1] ?? null;
    const spinT = /"__spin_t"\s*:\s*(\d+)/.exec(source)?.[1] ?? null;

    let cursor = null;
    let hasNextPage = false;
    const labelAt = source.indexOf('GroupsCometFeedRegularStories_paginationGroup');
    if (labelAt >= 0) {
        const region = source.slice(labelAt, labelAt + 120_000);
        cursor = /"end_cursor"\s*:\s*"([^"]+)"/.exec(region)?.[1] ?? null;
        hasNextPage = /"has_next_page"\s*:\s*true/.test(region);
    }

    const scriptUrls = [];
    const seen = new Set();
    const re = /https:\\?\/\\?\/static[^"'\\\s<>]+?\.js(?:[^"'\\\s<>]*)?/g;
    for (const match of source.matchAll(re)) {
        const url = decodeHtmlUrl(match[0]);
        if (!/^https:\/\/static[^/]*\.fbcdn\.net\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        scriptUrls.push(url);
        if (scriptUrls.length >= 30) break;
    }
    return { groupId, lsd, spinR, spinB, spinT, cursor, hasNextPage, scriptUrls };
}

function paginationCandidates(js, url) {
    const source = String(js ?? '');
    const needles = ['GroupsCometFeedRegularStories', 'paginationGroup', 'group_feed'];
    const hits = [];
    for (const needle of needles) {
        let at = source.indexOf(needle);
        while (at >= 0 && hits.length < 12) {
            const from = Math.max(0, at - 2500);
            const to = Math.min(source.length, at + 4500);
            const region = source.slice(from, to);
            const ids = [...new Set([
                ...[...region.matchAll(/(?:id|doc_id|queryID|queryId)\s*[:=]\s*["'](\d{8,})["']/g)].map((m) => m[1]),
                ...[...region.matchAll(/["'](\d{14,})["']/g)].map((m) => m[1]),
            ])];
            const names = [...new Set([...region.matchAll(/["']([A-Za-z0-9_]*GroupsCometFeed[A-Za-z0-9_]*(?:Query|PaginationQuery))["']/g)].map((m) => m[1]))];
            hits.push({ needle, offset: at, ids: ids.slice(0, 12), names: names.slice(0, 12), context: region.slice(0, 7000) });
            at = source.indexOf(needle, at + needle.length);
        }
    }
    return hits.length ? { url, hits } : null;
}

async function discoverPaginationArtifacts(html, { proxyUrl, shouldStop = () => false } = {}) {
    const bootstrap = extractPublicFeedBootstrap(html);
    const assets = [];
    for (const url of bootstrap.scriptUrls) {
        if (shouldStop()) break;
        try {
            const response = await gotScraping({ url, ...requestOptions(proxyUrl, { timeout: { request: 20_000 } }) });
            if (response.statusCode !== 200) continue;
            const candidate = paginationCandidates(response.body, url);
            if (candidate) assets.push(candidate);
        } catch {}
    }
    return {
        discoveredAt: new Date().toISOString(),
        bootstrap: { ...bootstrap, lsd: bootstrap.lsd ? '[present]' : null },
        assets,
    };
}

export async function run({ input, pushData, fetchAttempt, discoverPagination = null, saveDiscovery = async () => null, saveDiagnostic = async () => null, shouldStop = () => false, now = () => new Date() }) {
    const totals = { groups: 0, ok: 0, loginWall: 0, posts: 0, diagnostics: 0, httpAttempts: 0, sessionRotations: 0, paginationDiscoveries: 0 };
    const stamp = () => now().toISOString();

    for (const bad of input.invalid) {
        await pushData({ recordType: 'group', input: bad, status: 'invalid_input', statusDetail: 'Not a Facebook group address (https://www.facebook.com/groups/<name or id>)', scrapedAt: stamp() });
    }

    for (const [groupIndex, group] of input.groups.entries()) {
        if (shouldStop()) break;
        totals.groups++;
        const base = { groupId: group.id, url: group.url };
        let posts = [];
        let bestResponse = null;
        let bestMeta = {};
        let sawLoginWall = false;
        let lastError = null;
        let discoveryKey = null;

        for (let attempt = 1; attempt <= input.maxSessionAttempts && !shouldStop() && posts.length < input.maxPostsPerGroup; attempt++) {
            totals.httpAttempts++;
            if (attempt > 1) totals.sessionRotations++;
            log.info(`group ${group.id}: anonymous HTTP attempt ${attempt}/${input.maxSessionAttempts}; collected=${posts.length}/${input.maxPostsPerGroup}.`);
            let response;
            try { response = await fetchAttempt(group.url, attempt); }
            catch (error) { lastError = error; log.warning(`group ${group.id}: request failed: ${error.message}`); continue; }
            bestResponse = response;
            if (response.status >= 400) { lastError = new Error(`HTTP ${response.status}`); if (response.status === 404) break; continue; }

            const meta = parseGroupMeta(response.html);
            if (meta.name || meta.description || meta.memberCount != null || meta.privacy) bestMeta = { ...bestMeta, ...meta };
            if (isLoginWall({ finalUrl: response.finalUrl, html: response.html })) { sawLoginWall = true; continue; }

            const found = parsePosts(response.html, { includeAuthors: input.includeAuthors });
            const before = posts.length;
            posts = mergePosts(posts, found);
            log.info(`group ${group.id}: public HTML exposed ${found.length} structured post(s); ${posts.length - before} new; merged total=${posts.length}.`);

            if (posts.length < input.maxPostsPerGroup && discoverPagination && !discoveryKey) {
                const bootstrap = extractPublicFeedBootstrap(response.html);
                if (bootstrap.hasNextPage && bootstrap.cursor) {
                    log.info(`group ${group.id}: regular feed reports has_next_page=true; inspecting ${bootstrap.scriptUrls.length} public frontend JS asset(s) for the current pagination artifact.`);
                    try {
                        const discovery = await discoverPagination(response.html, attempt);
                        discoveryKey = await saveDiscovery(group, discovery);
                        totals.paginationDiscoveries++;
                        log.info(`group ${group.id}: pagination discovery found ${discovery.assets.length} relevant JS asset(s); saved ${discoveryKey}.`);
                    } catch (error) {
                        log.warning(`group ${group.id}: pagination artifact discovery failed: ${error.message}`);
                    }
                }
            }
        }

        if (input.sinceMs != null) posts = posts.filter((post) => post.createdAt && Date.parse(post.createdAt) >= input.sinceMs);
        posts = posts.slice(0, input.maxPostsPerGroup);

        if (posts.length) {
            await pushData({ recordType: 'group', ...base, ...bestMeta, postsVisible: posts.length, sourceSurface: 'public_html', status: 'ok', statusDetail: posts.length < input.maxPostsPerGroup ? `Initial anonymous public feed exposed ${posts.length}/${input.maxPostsPerGroup}; pagination discovery key: ${discoveryKey ?? 'none'}.` : null, paginationDiscoveryKey: discoveryKey, scrapedAt: stamp() });
            for (const post of posts) await pushData({ recordType: 'post', groupId: group.id, groupUrl: group.url, sourceSurface: 'public_html', ...post, status: 'ok', scrapedAt: stamp() });
            totals.posts += posts.length;
            totals.ok++;
        } else {
            let diagnosticKey = null;
            if (bestResponse) {
                try { diagnosticKey = await saveDiagnostic(group, bestResponse, 'public_html_exhausted'); if (diagnosticKey) totals.diagnostics++; } catch {}
            }
            if (sawLoginWall) totals.loginWall++;
            await pushData({ recordType: 'group', ...base, ...bestMeta, postsVisible: 0, sourceSurface: 'public_html', status: sawLoginWall ? 'login_wall' : (bestResponse?.status === 404 ? 'not_found' : lastError ? 'http_error' : 'no_posts_visible'), statusDetail: sawLoginWall ? 'Facebook redirected the anonymous public feed to login.' : lastError?.message ?? 'No parseable public posts were exposed.', diagnosticKey, scrapedAt: stamp() });
        }

        log.info(`group ${group.id} done`);
        if (groupIndex < input.groups.length - 1) await sleep(input.delayBetweenGroupsMs);
    }
    return { ...totals, note: 'Reads Facebook public logged-out HTML. When that public feed explicitly reports another page, the Actor inspects only the public JS assets referenced by that same page to identify the current frontend pagination artifact. It does not use account credentials, account cookies, CAPTCHA solving, or hard-coded private query IDs.' };
}

async function main() {
    await Actor.init();
    let stop = false;
    Actor.on('aborting', async () => { stop = true; await sleep(300); await Actor.exit(); });
    try {
        const input = readInput(await Actor.getInput());
        const proxyConfiguration = input.proxyConfiguration ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] };
        const proxy = await Actor.createProxyConfiguration(proxyConfiguration);
        if (!proxy) throw new Error('Apify proxy configuration was not created.');
        log.info(`Network route: ${input.proxyConfiguration ? 'input proxy configuration' : 'Apify RESIDENTIAL default'}; public logged-out HTML first; Facebook authentication is not used.`);

        const sessionForAttempt = new Map();
        const proxyForAttempt = async (attempt) => {
            if (!sessionForAttempt.has(attempt)) {
                const sessionId = `fb_public_${Date.now()}_${attempt}_${Math.random().toString(36).slice(2, 9)}`;
                sessionForAttempt.set(attempt, await proxy.newUrl(sessionId));
            }
            return sessionForAttempt.get(attempt);
        };

        const summary = await run({
            input,
            pushData: (record) => Actor.pushData(record),
            fetchAttempt: async (url, attempt) => fetchGroup(url, { proxyUrl: await proxyForAttempt(attempt) }),
            discoverPagination: async (html, attempt) => discoverPaginationArtifacts(html, { proxyUrl: await proxyForAttempt(attempt), shouldStop: () => stop }),
            saveDiscovery: async (group, discovery) => {
                const key = `PAGINATION_DISCOVERY_${String(group.id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
                await Actor.setValue(key, discovery, { contentType: 'application/json; charset=utf-8' });
                return key;
            },
            saveDiagnostic: async (group, response, label) => {
                const suffix = String(label).replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase();
                const key = `DIAGNOSTIC_GROUP_${String(group.id).replace(/[^A-Za-z0-9_-]/g, '_')}_${suffix}`;
                await Actor.setValue(key, response.html, { contentType: 'text/html; charset=utf-8' });
                return key;
            },
            shouldStop: () => stop,
        });
        await Actor.setValue('OUTPUT', summary);
        log.info(`Done: ${summary.groups} group(s), ${summary.posts} post(s), ${summary.httpAttempts} HTTP attempt(s), ${summary.paginationDiscoveries} pagination discovery record(s), ${summary.diagnostics} diagnostic(s).`);
    } catch (error) {
        log.error(String(error.stack ?? error.message ?? error));
        await Actor.fail(String(error.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
