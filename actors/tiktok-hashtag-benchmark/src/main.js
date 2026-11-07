import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

import { fetchEmbed, parseEmbedPage, taggedRecent } from './embed.js';
import { findVideoUrls, freshnessFor } from './search.js';
import { summariseVideos } from './stats.js';
import { parseVideoPage, postedAtFromId } from './video.js';

const DEFAULTS = {
    maxVideosPerHashtag: 50,
    recentDays: 365,
    regions: [],
    maxSearchPages: 2,
    includeVideos: true,
    delayBetweenVideosMs: 600,
    concurrency: 3,
    minVideosForBenchmark: 10,
    maxCreatorsToRead: 30,
    delayBetweenCreatorsMs: 1500,
    videoUrls: [],
    creatorHandles: [],
    searchDiscovery: true,
    maxVideoPageReads: 100,
};
const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export function readInput(raw) {
    const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)) };
    const hashtags = [
        ...new Set(
            (input.hashtags ?? []).map((h) => String(h).trim().replace(/^#+/, '').toLowerCase()).filter(Boolean),
        ),
    ];
    if (!hashtags.length) throw new Error('Give at least one hashtag in "hashtags" (with or without #).');
    if (input.runLabel != null && typeof input.runLabel !== 'string') throw new Error('runLabel must be a string.');
    if (input.maxItems != null && (!Number.isInteger(input.maxItems) || input.maxItems < 1)) throw new Error('maxItems must be a positive whole number.');
    for (const k of ['maxVideosPerHashtag', 'recentDays', 'maxSearchPages'])
        if (!Number.isInteger(input[k]) || input[k] < 1)
            throw new Error(`Input "${k}" must be a whole number of 1 or more.`);
    input.maxVideosPerHashtag = Math.min(input.maxVideosPerHashtag, 200);
    input.concurrency = Math.min(Math.max(1, input.concurrency), 5);
    const regions = (input.regions ?? []).map((r) => String(r).trim().toUpperCase()).filter(Boolean);
    const videoUrls = [...new Set((input.videoUrls ?? []).map((rawUrl) => {
        const m = String(rawUrl).match(/^https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9._]{2,24})\/video\/(\d{8,25})(?:[/?#]|$)/i);
        if (!m) throw new Error('Every "videoUrls" entry must be a public TikTok /@handle/video/ID link.');
        return `https://www.tiktok.com/@${m[1].toLowerCase()}/video/${m[2]}`;
    }))];
    const creatorHandles = [...new Set((input.creatorHandles ?? []).map((h) =>
        String(h).trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
    if (creatorHandles.some((h) => !/^[a-z0-9._]{2,24}$/.test(h))) throw new Error('Invalid creatorHandles entry.');
    if (!Number.isInteger(input.maxVideoPageReads) || input.maxVideoPageReads < 1 || input.maxVideoPageReads > 500)
        throw new Error('maxVideoPageReads must be a whole number from 1 to 500.');
    if (typeof input.searchDiscovery !== 'boolean') throw new Error('searchDiscovery must be true or false.');
    if (!input.searchDiscovery && !videoUrls.length && !creatorHandles.length)
        throw new Error('When searchDiscovery is false, supply videoUrls or creatorHandles.');
    return { ...input, hashtags, regions, videoUrls, creatorHandles };
}

export async function fetchVideoPage(url) {
    const res = await gotScraping({
        url,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    return { status: res.statusCode, html: res.body };
}

export function keepVideo(video, { tag, recentDays, regions, now }) {
    const hasTag = video.hashtags.includes(tag) || new RegExp(`#${tag}(?![\\w])`, 'i').test(video.description);
    if (!hasTag) return 'notTagged';
    const published = video.createdAt ? Date.parse(video.createdAt) : NaN;
    if (!Number.isFinite(published)) return 'unknownDate';
    if (published > now + 86_400_000 || now - published > recentDays * 86_400_000) return 'tooOld';
    if (regions.length && !regions.includes(String(video.region ?? '').toUpperCase())) return 'otherRegion';
    return null;
}

export async function run({
    input,
    pushData,
    search = findVideoUrls,
    fetchVideo = fetchVideoPage,
    readEmbed = fetchEmbed,
    shouldStop = () => false,
    now = () => Date.now(),
}) {
    const totals = { hashtags: 0, videosKept: 0, maxItems: input.maxItems ?? null, stopReason: null, hashtagsSkippedByLimit: 0 };
    for (const tag of input.hashtags) {
        if (shouldStop()) break;
        if (input.maxItems != null && totals.videosKept >= input.maxItems) {
            totals.stopReason = 'max_items_reached';
            totals.hashtagsSkippedByLimit = input.hashtags.length - totals.hashtags;
            break;
        }
        const remainingGlobal = input.maxItems == null ? Infinity : input.maxItems - totals.videosKept;
        totals.hashtags += 1;
        const found = input.searchDiscovery ? await search({
            tag,
            // Search snippets can contain unrelated video URLs. Discover a wider candidate pool
            // before applying authoritative hashtag checks against each video's own metadata.
            want: Math.min(200, Math.max(30, input.maxVideosPerHashtag * 4)),
            maxPages: input.maxSearchPages,
            freshness: freshnessFor(input.recentDays),
            shouldStop,
            log: (m) => log.info(m),
        }) : { urls: [], handles: [], attempts: [], sourceResults: [], discoveryStatus: 'provided_only' };
        // recent videos with the hashtag from the creators the search found (TikTok's public creator embed)
        const embed = { creatorsRead: 0, rateLimited: 0, videosFound: 0 };
        const byId = new Map();
        for (const u of [...input.videoUrls, ...found.urls]) {
            const id = u.split('/video/')[1];
            if (!byId.has(id)) byId.set(id, u);
        }
        for (const handle of [...new Set([...input.creatorHandles, ...(found.handles ?? [])])].slice(0, input.maxCreatorsToRead)) {
            if (shouldStop()) break;
            let res;
            try {
                res = await readEmbed(handle);
                if (res.status === 429) {
                    embed.rateLimited += 1;
                    await sleep(15_000);
                    res = await readEmbed(handle);
                }
            } catch {
                continue;
            }
            if (res.status === 429) embed.rateLimited += 1;
            if (res.status !== 200) continue;
            embed.creatorsRead += 1;
            for (const v of taggedRecent(parseEmbedPage(res.html), { tag, recentDays: input.recentDays, now: now() })) {
                if (!byId.has(v.id)) embed.videosFound += 1;
                byId.set(v.id, `https://www.tiktok.com/@${(v.author ?? handle).toLowerCase()}/video/${v.id}`);
            }
            if (input.delayBetweenCreatorsMs) await sleep(input.delayBetweenCreatorsMs);
        }
        found.urls = [...byId.values()];
        const dropped = { notTagged: 0, tooOld: 0, otherRegion: 0, unavailable: 0, unknownDate: 0 };
        const kept = [];
        // the video id carries the post time, so old videos are skipped without reading their pages
        const eligible = found.urls.filter((u) => {
            const posted = postedAtFromId(u.split('/video/')[1]);
            if (posted != null && now() - posted > input.recentDays * 86_400_000) {
                dropped.tooOld += 1;
                return false;
            }
            return true;
        });
        const queue = eligible.slice(0, input.maxVideoPageReads);
        const candidateLimitReached = eligible.length > queue.length;
        const worker = async () => {
            for (
                let url = queue.shift();
                url && kept.length < Math.min(input.maxVideosPerHashtag, remainingGlobal) && !shouldStop();
                url = queue.shift()
            ) {
                let parsed;
                try {
                    const res = await fetchVideo(url);
                    parsed =
                        res.status === 200
                            ? parseVideoPage(res.html)
                            : { status: 'unavailable', detail: `HTTP ${res.status}` };
                } catch (error) {
                    parsed = { status: 'unavailable', detail: String(error?.message ?? error) };
                }
                if (parsed.status !== 'ok') dropped.unavailable += 1;
                else {
                    const why = keepVideo(parsed.video, {
                        tag,
                        recentDays: input.recentDays,
                        regions: input.regions,
                        now: now(),
                    });
                    if (why) dropped[why] += 1;
                    else if (kept.length < Math.min(input.maxVideosPerHashtag, remainingGlobal)) kept.push({ ...parsed.video, url });
                }
                if (input.delayBetweenVideosMs) await sleep(input.delayBetweenVideosMs);
            }
        };
        await Promise.all(Array.from({ length: input.concurrency }, () => worker()));
        const scrapedAt = new Date(now()).toISOString();
        if (input.includeVideos)
            for (const v of kept) await pushData({ recordType: 'video', hashtag: tag, status: 'ok', ...v, scrapedAt, runLabel: input.runLabel ?? null, sourceUrl: v.url ?? null });
        totals.videosKept += kept.length;
        if (input.maxItems != null && totals.videosKept >= input.maxItems) totals.stopReason = 'max_items_reached';
        const stats = summariseVideos(kept);
        const status =
            !kept.length && found.discoveryStatus === 'rate_limited'
                ? 'discovery_rate_limited'
                : !kept.length && found.discoveryStatus === 'failed'
                  ? 'discovery_failed'
                  : !kept.length && found.urls.length > 0
                    ? 'no_matching_videos'
                    : !kept.length
                      ? 'no_videos'
                      : kept.length < input.minVideosForBenchmark
                      ? 'thin_sample'
                      : 'ok';
        await pushData({
            recordType: 'benchmark',
            hashtag: tag,
            runLabel: input.runLabel ?? null,
            sourceUrl: null,
            status,
            statusDetail:
                status === 'ok'
                    ? null
                    : status === 'discovery_rate_limited'
                      ? 'all public discovery sources were blocked or rate-limited; no benchmark was produced'
                      : status === 'discovery_failed'
                        ? 'all public discovery sources failed; no benchmark was produced'
                        : status === 'no_matching_videos'
                          ? `${found.urls.length} candidate video address(es) found; none matched the requested filters (tooOld=${dropped.tooOld}, otherRegion=${dropped.otherRegion}, notTagged=${dropped.notTagged}, unavailable=${dropped.unavailable})`
                          : status === 'no_videos'
                            ? 'public discovery succeeded but returned no candidate video addresses'
                            : `only ${kept.length} video(s) matched; treat the numbers as a rough guide`,
            regionsWanted: input.regions,
            recentDays: input.recentDays,
            videoAddressesFound: found.urls.length,
            videoPageReadLimit: input.maxVideoPageReads,
            candidateLimitReached,
            suppliedVideoUrls: input.videoUrls.length,
            suppliedCreatorHandles: input.creatorHandles.length,
            creatorsRead: embed.creatorsRead,
            videosFromCreators: embed.videosFound,
            creatorEmbedRateLimited: embed.rateLimited,
            dropped,
            ...(stats ?? {}),
            discoveryStatus: found.discoveryStatus ?? 'ok',
            discoverySources: found.sourceResults ?? [],
            searchAttempts: found.attempts,
            scrapedAt,
        });
        log.info(`#${tag}: ${found.urls.length} address(es), ${kept.length} video(s) used, status ${status}`);
    }
    return {
        ...totals,
        note: 'The sample is the public videos that search engines return for the hashtag, not TikTok\'s own "top" list, which is not available logged out. Views are the counts shown on each video page when it was read.',
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
        const summary = await run({ input, pushData: (r) => Actor.pushData(r), shouldStop: () => stop });
        await Actor.setValue('OUTPUT', summary);
        await Actor.setValue('SUMMARY', {
            recordType: 'run_summary',
            status: stop || summary.hashtagsSkippedByLimit > 0 ? 'partial' : (summary.videosKept > 0 ? 'ok' : 'no_data'),
            scrapedAt: new Date().toISOString(),
            runLabel: input.runLabel ?? null,
            sourceUrl: null,
            inputUsed: input,
            ...summary,
            itemsReturned: summary.videosKept,
            requestsMade: null,
            itemsBlocked: null,
            costUsd: null,
            costNote: 'Exact Apify billing and request counts are not available authoritatively inside this Actor.',
        });
        log.info(`Done: ${summary.hashtags} hashtag(s), ${summary.videosKept} video(s) used.`);
    } catch (error) {
        log.error(String(error?.message ?? error));
        await Actor.fail(String(error?.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
