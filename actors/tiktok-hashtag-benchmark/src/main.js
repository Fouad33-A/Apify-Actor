import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

import { findVideoUrls } from './search.js';
import { summariseVideos } from './stats.js';
import { parseVideoPage } from './video.js';

const DEFAULTS = {
    maxVideosPerHashtag: 50,
    recentDays: 90,
    regions: [],
    maxSearchPages: 2,
    includeVideos: true,
    delayBetweenVideosMs: 600,
    concurrency: 3,
    minVideosForBenchmark: 10,
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
    for (const k of ['maxVideosPerHashtag', 'recentDays', 'maxSearchPages'])
        if (!Number.isInteger(input[k]) || input[k] < 1)
            throw new Error(`Input "${k}" must be a whole number of 1 or more.`);
    input.maxVideosPerHashtag = Math.min(input.maxVideosPerHashtag, 200);
    input.concurrency = Math.min(Math.max(1, input.concurrency), 5);
    const regions = (input.regions ?? []).map((r) => String(r).trim().toUpperCase()).filter(Boolean);
    return { ...input, hashtags, regions };
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
    if (video.createdAt && now - Date.parse(video.createdAt) > recentDays * 86_400_000) return 'tooOld';
    if (regions.length && !regions.includes(String(video.region ?? '').toUpperCase())) return 'otherRegion';
    return null;
}

export async function run({
    input,
    pushData,
    search = findVideoUrls,
    fetchVideo = fetchVideoPage,
    shouldStop = () => false,
    now = () => Date.now(),
}) {
    const totals = { hashtags: 0, videosKept: 0 };
    for (const tag of input.hashtags) {
        if (shouldStop()) break;
        totals.hashtags += 1;
        const found = await search({
            tag,
            want: input.maxVideosPerHashtag * 2,
            maxPages: input.maxSearchPages,
            shouldStop,
            log: (m) => log.info(m),
        });
        const dropped = { notTagged: 0, tooOld: 0, otherRegion: 0, unavailable: 0 };
        const kept = [];
        const queue = [...found.urls];
        const worker = async () => {
            for (
                let url = queue.shift();
                url && kept.length < input.maxVideosPerHashtag && !shouldStop();
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
                    else kept.push({ ...parsed.video, url });
                }
                if (input.delayBetweenVideosMs) await sleep(input.delayBetweenVideosMs);
            }
        };
        await Promise.all(Array.from({ length: input.concurrency }, () => worker()));
        const scrapedAt = new Date(now()).toISOString();
        if (input.includeVideos)
            for (const v of kept) await pushData({ recordType: 'video', hashtag: tag, status: 'ok', ...v, scrapedAt });
        totals.videosKept += kept.length;
        const stats = summariseVideos(kept);
        const status = !kept.length ? 'no_videos' : kept.length < input.minVideosForBenchmark ? 'thin_sample' : 'ok';
        await pushData({
            recordType: 'benchmark',
            hashtag: tag,
            status,
            statusDetail:
                status === 'ok'
                    ? null
                    : found.rateLimited && !found.urls.length
                      ? 'the search engine limited the requests; try again later'
                      : status === 'no_videos'
                        ? 'no public video matching the filters was found through search'
                        : `only ${kept.length} video(s) matched; treat the numbers as a rough guide`,
            regionsWanted: input.regions,
            recentDays: input.recentDays,
            videoAddressesFound: found.urls.length,
            dropped,
            ...(stats ?? {}),
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
        log.info(`Done: ${summary.hashtags} hashtag(s), ${summary.videosKept} video(s) used.`);
    } catch (error) {
        log.error(String(error?.message ?? error));
        await Actor.fail(String(error?.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
