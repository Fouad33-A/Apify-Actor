import { Actor, log } from 'apify';

import { normalizeChannel } from './parse.js';
import { buildChannelRow, buildPostRow, summarise } from './rows.js';
import { readChannel } from './scrape.js';

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
    return { ...input, channels };
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
        await pushData(row);
    }

    let processed = 0;
    let stoppedBecause = 'completed';
    const mentionedPool = new Map();

    const next = () => {
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
            const row = buildChannelRow(result, { discoveredFrom: item.discoveredFrom, now });
            rows.push(row);
            await pushData(row);
            if (input.includePosts && result.status === 'ok') {
                for (const post of result.posts) await pushData(buildPostRow(post, result));
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

    await Promise.all(Array.from({ length: input.concurrency }, worker));
    return {
        started,
        rows,
        summary: summarise(rows, { started, stoppedBecause, queuedLeft: queue.length, invalid: invalid.length }),
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
