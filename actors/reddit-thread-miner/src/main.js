import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

import { classifyResponse, parseAtom, searchFeed, subredditFeed, threadFeed } from './feed.js';
import { DEFAULT_COMPETITORS, mergeThemes, tagText } from './themes.js';

const DEFAULTS = {
    keywords: [],
    maxThreadsPerSubreddit: 100,
    includeComments: true,
    maxThreadsWithComments: 30,
    maxCommentsPerThread: 20,
    competitors: DEFAULT_COMPETITORS,
    delayBetweenRequestsMs: 3000,
};
const MAX_PAGES = 10;
const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export function readInput(raw) {
    const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)) };
    const subreddits = [
        ...new Set(
            (input.subreddits ?? [])
                .map((s) =>
                    String(s)
                        .trim()
                        .replace(/^(https?:\/\/(www\.)?reddit\.com)?\/?r\//i, '')
                        .replace(/\/.*$/, ''),
                )
                .filter(Boolean),
        ),
    ];
    if (!subreddits.length)
        throw new Error('Give at least one subreddit in "subreddits" (for example igcse or r/SAT).');
    for (const k of ['maxThreadsPerSubreddit', 'maxThreadsWithComments', 'maxCommentsPerThread'])
        if (!Number.isInteger(input[k]) || input[k] < 0)
            throw new Error(`Input "${k}" must be a whole number of 0 or more.`);
    const date = (name) => {
        if (!input[name]) return null;
        const t = Date.parse(input[name]);
        if (Number.isNaN(t)) throw new Error(`"${name}" must be a date such as 2026-01-31.`);
        return t;
    };
    const dateFrom = date('dateFrom');
    const dateTo = date('dateTo') == null ? null : date('dateTo') + 86_400_000 - 1; // the whole last day
    if (dateFrom != null && dateTo != null && dateFrom > dateTo) throw new Error('"dateFrom" is after "dateTo".');
    return {
        ...input,
        subreddits,
        keywords: (input.keywords ?? []).map((k) => String(k).trim()).filter(Boolean),
        competitors: (input.competitors ?? []).map((c) => String(c).trim()).filter(Boolean),
        themes: mergeThemes(input.customThemes),
        dateFromMs: dateFrom,
        dateToMs: dateTo,
        maxThreadsPerSubreddit: Math.min(input.maxThreadsPerSubreddit, 1000),
        maxCommentsPerThread: Math.min(input.maxCommentsPerThread, 100),
    };
}

export async function fetchFeed(url, { proxyUrl } = {}) {
    const res = await gotScraping({
        url,
        proxyUrl,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: {
            'user-agent': 'Mozilla/5.0 (compatible; reddit-thread-miner/0.1; public RSS reader)',
            accept: 'application/atom+xml, application/rss+xml, */*',
        },
    });
    return { status: res.statusCode, body: res.body };
}

export async function run({
    input,
    pushData,
    fetch = fetchFeed,
    shouldStop = () => false,
    now = () => new Date(),
    backoffMs = 30_000,
}) {
    const totals = { subreddits: 0, threads: 0, comments: 0, blocked: 0 };
    const stamp = () => now().toISOString();

    // one request; a "too many requests" answer is waited out twice
    async function ask(url) {
        for (let attempt = 0; ; attempt += 1) {
            await sleep(input.delayBetweenRequestsMs);
            const res = await fetch(url);
            const verdict = classifyResponse(res.status, res.body);
            if (verdict.status === 'rate_limited' && attempt < 2) {
                await sleep(backoffMs);
                continue;
            }
            return { ...verdict, body: res.body };
        }
    }

    for (const sub of input.subreddits) {
        if (shouldStop()) break;
        totals.subreddits += 1;
        const threads = new Map();
        const problems = [];
        const sources = input.keywords.length
            ? input.keywords.map((k) => ({ keyword: k, url: (after) => searchFeed(sub, k, { after }) }))
            : [{ keyword: null, url: (after) => subredditFeed(sub, { after }) }];
        let halted = null;
        for (const source of sources) {
            let after;
            for (
                let page = 0;
                page < MAX_PAGES && threads.size < input.maxThreadsPerSubreddit && !shouldStop();
                page += 1
            ) {
                const res = await ask(source.url(after));
                if (res.status !== 'ok') {
                    problems.push({ keyword: source.keyword, page, status: res.status, detail: res.detail });
                    if (res.status === 'blocked' || res.status === 'rate_limited' || res.status === 'not_found')
                        halted = res;
                    break;
                }
                const posts = parseAtom(res.body).filter((e) => e.kind === 'post');
                if (!posts.length) break;
                let reachedStart = false;
                for (const p of posts) {
                    const t = Date.parse(p.updated);
                    if (input.dateToMs != null && t > input.dateToMs) continue;
                    if (input.dateFromMs != null && t < input.dateFromMs) {
                        reachedStart = true;
                        continue;
                    }
                    const known = threads.get(p.id);
                    if (known)
                        known.matchedKeywords = [
                            ...new Set([...known.matchedKeywords, ...(source.keyword ? [source.keyword] : [])]),
                        ];
                    else if (threads.size < input.maxThreadsPerSubreddit)
                        threads.set(p.id, { ...p, matchedKeywords: source.keyword ? [source.keyword] : [] });
                }
                after = posts.at(-1).id;
                if (reachedStart || posts.length < 5) break;
            }
            if (halted?.status === 'blocked' || halted?.status === 'not_found') break;
        }

        const themeCounts = {};
        const competitorCounts = {};
        let commentsRead = 0;
        let withComments = 0;
        for (const thread of threads.values()) {
            if (shouldStop()) break;
            const own = tagText(`${thread.title}\n${thread.text}`, {
                themes: input.themes,
                competitors: input.competitors,
            });
            let comments = [];
            let commentsStatus = input.includeComments ? 'skipped_limit' : 'not_requested';
            if (
                input.includeComments &&
                withComments < input.maxThreadsWithComments &&
                input.maxCommentsPerThread > 0
            ) {
                withComments += 1;
                const res = await ask(threadFeed(thread.url));
                commentsStatus = res.status;
                if (res.status === 'ok')
                    comments = parseAtom(res.body)
                        .filter((e) => e.kind === 'comment')
                        .slice(0, input.maxCommentsPerThread)
                        .map((c) => ({
                            author: c.author,
                            createdAt: c.updated,
                            text: c.text.slice(0, 1500),
                            url: c.url,
                            ...tagText(c.text, { themes: input.themes, competitors: input.competitors }),
                        }));
                else if (res.status === 'blocked') halted ??= res;
            }
            commentsRead += comments.length;
            const all = new Set([...own.themes, ...comments.flatMap((c) => c.themes)]);
            for (const t of all) themeCounts[t] = (themeCounts[t] ?? 0) + 1;
            for (const c of new Set([...own.competitorsMentioned, ...comments.flatMap((c) => c.competitorsMentioned)]))
                competitorCounts[c] = (competitorCounts[c] ?? 0) + 1;
            await pushData({
                recordType: 'thread',
                subreddit: sub,
                threadId: thread.id.replace(/^t3_/, ''),
                title: thread.title,
                body: thread.text.slice(0, 5000),
                author: thread.author,
                createdAt: thread.updated,
                url: thread.url,
                score: null,
                matchedKeywords: thread.matchedKeywords,
                themes: own.themes,
                competitorsMentioned: own.competitorsMentioned,
                threadThemes: [...all],
                commentsStatus,
                comments,
                status: 'ok',
                scrapedAt: stamp(),
            });
            totals.threads += 1;
        }
        totals.comments += commentsRead;
        if (halted?.status === 'blocked') totals.blocked += 1;
        const status =
            halted?.status === 'blocked'
                ? 'blocked'
                : halted?.status === 'not_found'
                  ? 'not_found'
                  : halted?.status === 'rate_limited'
                    ? 'rate_limited'
                    : threads.size
                      ? 'ok'
                      : problems.length
                        ? 'error'
                        : 'no_threads';
        await pushData({
            recordType: 'subreddit',
            subreddit: sub,
            status,
            statusDetail:
                status === 'ok' || status === 'no_threads' ? null : (halted?.detail ?? problems[0]?.detail ?? null),
            threadsRead: threads.size,
            threadsWithComments: withComments,
            commentsRead,
            themeCounts,
            competitorCounts,
            problems,
            scrapedAt: stamp(),
        });
        log.info(`r/${sub}: ${status}, ${threads.size} thread(s), ${commentsRead} comment(s)`);
    }
    return {
        ...totals,
        note: 'Threads come from the public RSS feeds Reddit publishes for each subreddit (newest first, up to 100 per page) and each thread. RSS carries no score or comment count, so "score" is null. Reddit may refuse feeds to some servers: a subreddit row then says blocked or rate_limited, and nothing is bypassed.',
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
            fetch: (u) => fetchFeed(u, { proxyUrl }),
            shouldStop: () => stop,
        });
        await Actor.setValue('OUTPUT', summary);
        log.info(
            `Done: ${summary.threads} thread(s), ${summary.comments} comment(s), ${summary.blocked} subreddit(s) blocked.`,
        );
    } catch (error) {
        log.error(String(error?.message ?? error));
        await Actor.fail(String(error?.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
