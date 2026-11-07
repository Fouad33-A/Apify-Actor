import { Actor, log } from 'apify';

import { normalizeChannel } from './parse.js';
import { buildChannelRow, buildPostRow, summarise } from './rows.js';
import { readChannel } from './scrape.js';
import { channelMetrics } from './metrics.js';

const DEFAULTS = {
    maxPostsPerChannel: 100,
    windowDays: 30,
    freshHours: 24,
    includePosts: false,
    followMentionedChannels: false,
    minMentions: 2,
    maxChannels: 50,
    delayBetweenRequestsMs: 600,
    concurrency: 2,
    maxItems: null,
    runLabel: null,
    sinceDate: null,
};

export function readInput(raw) {
    const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)) };
    const channels = Array.isArray(input.channels) ? input.channels : [];
    if (!channels.length)
        throw new Error('Input "channels" must list at least one Telegram channel (name, @name or t.me link).');
    for (const key of ['maxPostsPerChannel', 'windowDays', 'maxChannels', 'concurrency']) {
        if (!Number.isInteger(input[key]) || input[key] < 1)
            throw new Error(`Input "${key}" must be a whole number of 1 or more.`);
    }
    input.maxPostsPerChannel = Math.min(input.maxPostsPerChannel, 1000);
    input.concurrency = Math.min(input.concurrency, 4);
    if (input.maxItems != null && (!Number.isInteger(input.maxItems) || input.maxItems < 1)) {
        throw new Error('"maxItems" must be a positive whole number.');
    }
    if (input.sinceDate != null && (!/^\d{4}-\d{2}-\d{2}$/.test(input.sinceDate)
        || Number.isNaN(Date.parse(input.sinceDate))
        || new Date(input.sinceDate).toISOString().slice(0, 10) !== input.sinceDate)) {
        throw new Error('"sinceDate" must be a valid YYYY-MM-DD date.');
    }
    return { ...input, channels, sinceMs: input.sinceDate ? Date.parse(input.sinceDate) : null };
}

export async function run({
    input,
    pushData,
    fetch,
    now = Date.now(),
    proxyUrl = undefined,
    shouldStop = () => false,
}) {
    const started = new Date().toISOString();
    const queue = [];
    const queued = new Set();
    const rows = [];
    const invalid = [];
    let emitted = 0;
    let dateExcluded = 0;
    let noData = 0;
    let suppressedRows = 0;
    const emit = async (row) => {
        if (input.maxItems != null && emitted >= input.maxItems) { suppressedRows++; return false; }
        const enriched = { ...row, sourceUrl: row.sourceUrl ?? row.url ?? (row.username ? `https://t.me/${row.username}` : null), runLabel: input.runLabel ?? null, scrapedAt: row.scrapedAt ?? new Date(now).toISOString(), status: row.status ?? 'ok' };
        await pushData(enriched);
        emitted++;
        return true;
    };
    const atCap = () => input.maxItems != null && emitted >= input.maxItems;

    for (const raw of input.channels) {
        const parsed = normalizeChannel(raw);
        if (parsed.error) {
            invalid.push({ input: raw, reason: parsed.error });
            continue;
        }
        const key = parsed.username.toLowerCase();
        if (queued.has(key)) continue;
        queued.add(key);
        queue.push({ username: parsed.username, discoveredFrom: null });
    }

    for (const item of invalid) {
        const row = {
            recordType: 'channel',
            input: item.input,
            username: null,
            status: 'invalid_input',
            statusDetail:
                item.reason === 'invite_link'
                    ? 'Private invite links (t.me/+... or joinchat) cannot be read; only public channel names'
                    : 'Not a valid Telegram channel name',
            scrapedAt: new Date().toISOString(),
        };
        rows.push(row);
        if (!await emit(row)) break;
    }

    let processed = 0;
    let stoppedBecause = 'completed';
    const mentionedPool = new Map();

    const next = () => {
        if (queue.length === 0) return null;
        if (atCap()) {
            stoppedBecause = 'maxItems';
            return null;
        }
        if (shouldStop()) {
            stoppedBecause = 'aborted';
            return null;
        }
        if (processed >= input.maxChannels) {
            stoppedBecause = 'maxChannels';
            return null;
        }
        const item = queue.shift();
        if (item) processed += 1;
        return item ?? null;
    };

    const worker = async () => {
        for (let item = next(); item; item = next()) {
            let result;
            try {
                result = await readChannel(item.username, {
                    fetch,
                    maxPosts: input.maxPostsPerChannel,
                    windowDays: input.windowDays,
                    freshHours: input.freshHours,
                    delayMs: input.delayBetweenRequestsMs,
                    minMembers: input.minMembers ?? null,
                    maxMembers: input.maxMembers ?? null,
                    now,
                    fetchOptions: { proxyUrl },
                });
            } catch (error) {
                result = {
                    username: item.username,
                    status: 'error',
                    statusDetail: String(error?.message ?? error),
                    posts: [],
                };
            }
            if (result.status === 'ok' && input.sinceMs != null) {
                const before = result.posts.length;
                result.posts = result.posts.filter((post) => post.date && Date.parse(post.date) >= input.sinceMs);
                dateExcluded += before - result.posts.length;
                if (result.posts.length) {
                    result.metrics = channelMetrics(result.posts, {
                        members: result.members, windowDays: input.windowDays, freshHours: input.freshHours,
                        exhausted: false, now, self: item.username.toLowerCase(),
                    });
                } else {
                    result.metrics = null;
                    result.status = 'no_matching_posts';
                    result.statusDetail = `No publicly sampled posts matched sinceDate ${input.sinceDate}; ${before} older post(s) excluded.`;
                }
            }
            const row = buildChannelRow(result, { discoveredFrom: item.discoveredFrom, now });
            rows.push(row);
            await emit(row);
            if (input.includePosts && result.status === 'ok') {
                for (const post of result.posts) {
                    if (!await emit(buildPostRow(post, result))) break;
                }
            }
            if (result.status !== 'ok' && result.status !== 'filtered' || result.status === 'ok' && result.posts.length === 0) {
                if (await emit({
                    recordType: 'no_data', username: item.username, status: 'no_data',
                    reason: result.status === 'ok' ? 'no_posts_exposed' : result.status,
                    sourceUrl: `https://t.me/${item.username}`,
                    scrapedAt: new Date(now).toISOString(),
                })) noData++;
            }
            log.info(
                `${item.username}: ${result.status}${result.members != null ? `, ${result.members} members` : ''}`,
            );

            if (input.followMentionedChannels && item.discoveredFrom === null && result.metrics) {
                for (const m of result.metrics.mentionedAccounts) {
                    if (m.postsMentioning < input.minMentions) continue;
                    const key = m.username.toLowerCase();
                    if (queued.has(key)) continue;
                    queued.add(key);
                    mentionedPool.set(key, item.username);
                    queue.push({ username: m.username, discoveredFrom: item.username });
                }
            }
        }
    };

    await Promise.all(Array.from({ length: input.maxItems == null ? input.concurrency : 1 }, worker));
    if (atCap() && (queue.length || suppressedRows)) stoppedBecause = 'maxItems';
    return {
        started,
        rows,
        summary: { ...summarise(rows, { started, stoppedBecause, queuedLeft: queue.length, invalid: invalid.length }), status: stoppedBecause !== 'completed' || rows.some((r) => !['ok', 'filtered', 'no_matching_posts'].includes(r.status)) ? 'partial' : 'completed', itemsEmitted: emitted, suppressedRows, noData, dateExcluded, runLabel: input.runLabel ?? null, sinceDate: input.sinceDate ?? null },
    };
}

async function main() {
    await Actor.init();
    let stop = false;
    Actor.on('aborting', async () => {
        stop = true;
        await new Promise((resolve) => {
            setTimeout(resolve, 1000);
        });
        await Actor.exit();
    });
    try {
        const input = readInput(await Actor.getInput());
        const proxyConfiguration = input.proxyConfiguration
            ? await Actor.createProxyConfiguration(input.proxyConfiguration)
            : undefined;
        const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
        const { summary } = await run({
            input,
            pushData: (row) => Actor.pushData(row),
            proxyUrl,
            shouldStop: () => stop,
        });
        await Actor.setValue('OUTPUT', summary);
        await Actor.setValue('SUMMARY', { ...summary, exactInput: await Actor.getInput(), scrapedAt: new Date().toISOString() });
        log.info(`Done: ${summary.channelsOk} channels read, ${summary.channelsFailed} not readable.`);
    } catch (error) {
        log.error(String(error?.message ?? error));
        await Actor.fail(String(error?.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    await main();
}
