import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

import { fetchArcticComments } from './arctic.js';
import { classifyResponse, parseAtom, searchFeed, subredditFeed, threadFeed } from './feed.js';
import { discoverRedditThreads } from './search.js';
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const dateToRaw = date('dateTo');
    const dateTo = dateToRaw == null ? null : dateToRaw + 86_400_000 - 1;
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
    discover = discoverRedditThreads,
    readArchive = fetchArcticComments,
    shouldStop = () => false,
    now = () => new Date(),
    backoffMs = 30_000,
}) {
    const totals = { subreddits: 0, threads: 0, comments: 0, blocked: 0, searchFallbacks: 0, archiveCommentThreads: 0 };
    const stamp = () => now().toISOString();

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

    async function archiveComments(thread) {
        try {
            const archived = await readArchive(thread.url || thread.id, { limit: input.maxCommentsPerThread });
            const comments = (archived.comments ?? []).map((c) => ({
                ...c,
                ...tagText(c.text, { themes: input.themes, competitors: input.competitors }),
            }));
            if (comments.length) totals.archiveCommentThreads += 1;
            return {
                status: archived.status,
                comments,
                source: 'arctic_shift_archive',
                detail: archived.detail ?? null,
            };
        } catch (error) {
            return {
                status: 'archive_error',
                comments: [],
                source: 'arctic_shift_archive',
                detail: String(error?.message ?? error),
            };
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
        let sourceMode = 'reddit_rss';

        for (const source of sources) {
            let after;
            for (
                let page = 0;
                page < MAX_PAGES && threads.size < input.maxThreadsPerSubreddit && !shouldStop();
                page += 1
            ) {
                const res = await ask(source.url(after));
                if (res.status !== 'ok') {
                    problems.push({
                        source: 'reddit_rss',
                        keyword: source.keyword,
                        page,
                        status: res.status,
                        detail: res.detail,
                    });
                    if (['blocked', 'rate_limited', 'not_found'].includes(res.status)) halted = res;
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
                        threads.set(p.id, {
                            ...p,
                            matchedKeywords: source.keyword ? [source.keyword] : [],
                            discoverySource: 'reddit_rss',
                        });
                }
                after = posts.at(-1).id;
                if (reachedStart || posts.length < 5) break;
            }
            if (halted?.status === 'blocked' || halted?.status === 'not_found') break;
        }

        if (!threads.size && halted?.status === 'blocked' && !shouldStop()) {
            sourceMode = 'public_search';
            totals.searchFallbacks += 1;
            const fallback = await discover({
                subreddit: sub,
                keywords: input.keywords,
                maxThreads: input.maxThreadsPerSubreddit,
                maxPages: Math.min(3, Math.max(1, Math.ceil(input.maxThreadsPerSubreddit / 20))),
                shouldStop,
                log: (m) => log.info(m),
            });
            problems.push(...fallback.attempts.map((a) => ({ source: 'public_search', ...a })));
            for (const p of fallback.threads) {
                if ((input.dateFromMs != null || input.dateToMs != null) && !p.updated) continue;
                threads.set(p.id, { ...p, discoverySource: 'public_search' });
            }
            if (threads.size) halted = null;
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
            let commentsSource = null;

            if (
                input.includeComments &&
                withComments < input.maxThreadsWithComments &&
                input.maxCommentsPerThread > 0
            ) {
                withComments += 1;

                if (thread.discoverySource === 'reddit_rss') {
                    const res = await ask(threadFeed(thread.url));
                    commentsStatus = res.status;
                    commentsSource = 'reddit_rss';
                    if (res.status === 'ok') {
                        comments = parseAtom(res.body)
                            .filter((e) => e.kind === 'comment')
                            .slice(0, input.maxCommentsPerThread)
                            .map((c) => ({
                                author: c.author,
                                createdAt: c.updated,
                                text: c.text.slice(0, 1500),
                                url: c.url,
                                score: null,
                                source: 'reddit_rss',
                                rankBasis: 'reddit_top_feed',
                                ...tagText(c.text, { themes: input.themes, competitors: input.competitors }),
                            }));
                    }

                    if (!comments.length && ['ok', 'blocked', 'rate_limited'].includes(res.status)) {
                        const archived = await archiveComments(thread);
                        if (archived.comments.length) {
                            comments = archived.comments;
                            commentsStatus = 'ok';
                            commentsSource = archived.source;
                        } else {
                            commentsStatus = `${res.status}_archive_${archived.status}`;
                            commentsSource = archived.source;
                            problems.push({
                                source: 'arctic_shift_archive',
                                threadId: thread.id,
                                status: archived.status,
                                detail: archived.detail,
                            });
                        }
                    }
                } else {
                    const archived = await archiveComments(thread);
                    comments = archived.comments;
                    commentsStatus = archived.status;
                    commentsSource = archived.source;
                    if (!comments.length)
                        problems.push({
                            source: 'arctic_shift_archive',
                            threadId: thread.id,
                            status: archived.status,
                            detail: archived.detail,
                        });
                }
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
                discoverySource: thread.discoverySource,
                matchedKeywords: thread.matchedKeywords,
                themes: own.themes,
                competitorsMentioned: own.competitorsMentioned,
                threadThemes: [...all],
                commentsStatus,
                commentsSource,
                comments,
                status: 'ok',
                scrapedAt: stamp(),
            });
            totals.threads += 1;
        }

        totals.comments += commentsRead;
        if (halted?.status === 'blocked' && !threads.size) totals.blocked += 1;
        const status = threads.size
            ? 'ok'
            : halted?.status === 'blocked'
              ? 'blocked'
              : halted?.status === 'not_found'
                ? 'not_found'
                : halted?.status === 'rate_limited'
                  ? 'rate_limited'
                  : problems.length
                    ? 'error'
                    : 'no_threads';
        await pushData({
            recordType: 'subreddit',
            subreddit: sub,
            status,
            statusDetail:
                status === 'ok' || status === 'no_threads' ? null : (halted?.detail ?? problems[0]?.detail ?? null),
            sourceMode,
            threadsRead: threads.size,
            threadsWithComments: withComments,
            commentsRead,
            themeCounts,
            competitorCounts,
            problems,
            scrapedAt: stamp(),
        });
        log.info(`r/${sub}: ${status}, ${threads.size} thread(s), ${commentsRead} comment(s), source ${sourceMode}`);
    }

    return {
        ...totals,
        note: 'Reddit RSS is tried first for thread discovery and comments. If Reddit blocks thread discovery, Brave Search discovers indexed Reddit threads. If comment RSS is blocked, rate-limited, empty, or the thread came from public search, the actor queries the independent Arctic Shift public archive by Reddit submission ID. Archived comments retain their archived Reddit score and are ranked by that score before the requested limit. Archive coverage can lag or be incomplete. No Reddit login, client impersonation, paid API, or access-control bypass is used.',
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
            `Done: ${summary.threads} thread(s), ${summary.comments} comment(s), ${summary.blocked} subreddit(s) blocked, ${summary.searchFallbacks} thread-search fallback(s), ${summary.archiveCommentThreads} thread(s) with archived comments.`,
        );
    } catch (error) {
        log.error(String(error?.message ?? error));
        await Actor.fail(String(error?.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
