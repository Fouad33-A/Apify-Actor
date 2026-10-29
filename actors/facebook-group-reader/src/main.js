import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { isLoginWall, normalizeGroup, parseGroupMeta, parsePosts } from './parse.js';

const DEFAULTS = {
    maxPostsPerGroup: 50,
    includeAuthors: false,
    delayBetweenGroupsMs: 3000,
    sinceDate: null,
    maxSessionAttempts: 3,
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
        maxSessionAttempts: Math.min(Math.max(1, Number(input.maxSessionAttempts) || 3), 6),
    };
}

export async function fetchGroup(url, { proxyUrl } = {}) {
    const response = await gotScraping({
        url: chronologicalUrl(url),
        proxyUrl,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
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
    return [...merged.values()].sort((a, b) => {
        const ta = Date.parse(a.createdAt ?? '') || 0;
        const tb = Date.parse(b.createdAt ?? '') || 0;
        return tb - ta;
    });
}

export async function run({
    input,
    pushData,
    fetchAttempt,
    saveDiagnostic = async () => null,
    shouldStop = () => false,
    now = () => new Date(),
}) {
    const totals = { groups: 0, ok: 0, loginWall: 0, posts: 0, diagnostics: 0, httpAttempts: 0, sessionRotations: 0 };
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

    for (const [groupIndex, group] of input.groups.entries()) {
        if (shouldStop()) break;
        totals.groups++;
        const base = { groupId: group.id, url: group.url };
        let posts = [];
        let bestResponse = null;
        let bestMeta = {};
        let sawLoginWall = false;
        let lastError = null;

        for (let attempt = 1; attempt <= input.maxSessionAttempts && !shouldStop() && posts.length < input.maxPostsPerGroup; attempt++) {
            totals.httpAttempts++;
            if (attempt > 1) totals.sessionRotations++;
            log.info(`group ${group.id}: anonymous HTTP session attempt ${attempt}/${input.maxSessionAttempts}; collected=${posts.length}/${input.maxPostsPerGroup}.`);

            let response;
            try {
                response = await fetchAttempt(group.url, attempt);
            } catch (error) {
                lastError = error;
                log.warning(`group ${group.id}: attempt ${attempt} request failed: ${error.message}`);
                continue;
            }
            bestResponse = response;

            if (response.status >= 400) {
                lastError = new Error(`HTTP ${response.status}`);
                log.info(`group ${group.id}: attempt ${attempt} returned HTTP ${response.status}; ${attempt < input.maxSessionAttempts ? 'rotating session.' : 'no attempts left.'}`);
                if (response.status === 404) break;
                continue;
            }

            const meta = parseGroupMeta(response.html);
            if (meta.name || meta.description || meta.memberCount != null || meta.privacy) bestMeta = { ...bestMeta, ...meta };
            const wall = isLoginWall({ finalUrl: response.finalUrl, html: response.html });
            if (wall) {
                sawLoginWall = true;
                log.info(`group ${group.id}: attempt ${attempt} was redirected/served a login wall; discarding that anonymous session${attempt < input.maxSessionAttempts ? ' and rotating.' : '.'}`);
                continue;
            }

            const found = parsePosts(response.html, { includeAuthors: input.includeAuthors });
            const before = posts.length;
            posts = mergePosts(posts, found);
            log.info(`group ${group.id}: attempt ${attempt} exposed ${found.length} structured post(s); ${posts.length - before} new; merged total=${posts.length}.`);
            if (posts.length >= input.maxPostsPerGroup) break;
        }

        if (input.sinceMs != null) {
            posts = posts.filter((post) => post.createdAt && Number.isFinite(Date.parse(post.createdAt)) && Date.parse(post.createdAt) >= input.sinceMs);
        }
        posts = posts.slice(0, input.maxPostsPerGroup);

        if (posts.length) {
            await pushData({
                recordType: 'group',
                ...base,
                ...bestMeta,
                postsVisible: posts.length,
                sourceSurface: 'rotating_public_html',
                status: 'ok',
                statusDetail: posts.length < input.maxPostsPerGroup ? `Public anonymous HTML exposed ${posts.length}/${input.maxPostsPerGroup} requested unique posts after ${input.maxSessionAttempts} bounded session attempt(s).` : null,
                scrapedAt: stamp(),
            });
            for (const post of posts) {
                await pushData({ recordType: 'post', groupId: group.id, groupUrl: group.url, sourceSurface: 'rotating_public_html', ...post, status: 'ok', scrapedAt: stamp() });
            }
            totals.posts += posts.length;
            totals.ok++;
        } else {
            const diagnosticKey = bestResponse ? await capture(group, bestResponse, 'public_html_attempts_exhausted') : null;
            if (sawLoginWall) totals.loginWall++;
            const status = sawLoginWall ? 'login_wall' : (bestResponse?.status === 404 ? 'not_found' : lastError ? 'http_error' : 'no_posts_visible');
            await pushData({
                recordType: 'group',
                ...base,
                ...bestMeta,
                postsVisible: 0,
                sourceSurface: 'rotating_public_html',
                status,
                statusDetail: sawLoginWall
                    ? 'Facebook exposed no public feed posts across the bounded anonymous residential sessions; at least one attempt was redirected to login.'
                    : lastError?.message ?? 'Facebook exposed no parseable public posts across the bounded anonymous HTTP sessions.',
                diagnosticKey,
                scrapedAt: stamp(),
            });
        }

        log.info(`group ${group.id} done`);
        if (groupIndex < input.groups.length - 1) await sleep(input.delayBetweenGroupsMs);
    }

    return {
        ...totals,
        note: 'Reads only public logged-out Facebook HTML. Each bounded retry uses a fresh anonymous proxy session; sessions that receive login/block responses are discarded. No Facebook account cookies, credentials, access tokens, CAPTCHA solving, browser automation, or private API calls are used.',
    };
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
        log.info(`Network route: ${input.proxyConfiguration ? 'input proxy configuration' : 'Apify RESIDENTIAL default'} with up to ${input.maxSessionAttempts} fresh anonymous HTTP session(s) per group; Facebook authentication is not used.`);

        const fetchAttempt = async (url, attempt) => {
            const sessionId = `fb_public_${Date.now()}_${attempt}_${Math.random().toString(36).slice(2, 9)}`;
            const proxyUrl = await proxy.newUrl(sessionId);
            return fetchGroup(url, { proxyUrl });
        };

        const summary = await run({
            input,
            pushData: (record) => Actor.pushData(record),
            fetchAttempt,
            saveDiagnostic: async (group, response, label) => {
                const suffix = String(label ?? 'response').replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase();
                const key = `DIAGNOSTIC_GROUP_${String(group.id).replace(/[^A-Za-z0-9_-]/g, '_')}_${suffix}`;
                const header = `<!-- facebook-group-reader diagnostic\nrequested group: ${group.url}\nsurface: ${label}\nfinal: ${response.finalUrl}\nhttpStatus: ${response.status}\nExact logged-out response used by the Actor. No account credentials or account cookies are used.\n-->\n`;
                await Actor.setValue(key, `${header}${response.html}`, { contentType: 'text/html; charset=utf-8' });
                log.info(`Saved response diagnostic to key-value store key ${key} (${Buffer.byteLength(response.html, 'utf8')} bytes).`);
                return key;
            },
            shouldStop: () => stop,
        });
        await Actor.setValue('OUTPUT', summary);
        log.info(`Done: ${summary.groups} group(s), ${summary.posts} post(s), ${summary.loginWall} login-wall classification(s), ${summary.httpAttempts} HTTP attempt(s), ${summary.sessionRotations} session rotation(s), ${summary.diagnostics} diagnostic(s).`);
    } catch (error) {
        log.error(String(error.stack ?? error.message ?? error));
        await Actor.fail(String(error.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
