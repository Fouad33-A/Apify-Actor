import { describe, expect, it } from 'vitest';

import { keepVideo, readInput, run } from '../src/main.js';
import { findVideoUrls } from '../src/search.js';
import { percentile, summariseVideos } from '../src/stats.js';
import { parseVideoPage, videoUrlsIn } from '../src/video.js';

const NOW = Date.parse('2026-10-29T00:00:00Z');
const page = (item, statusCode = 0) =>
    `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode, itemInfo: item ? { itemStruct: item } : undefined } } })}</script></html>`;
const item = (over = {}) => ({
    id: '7600000000000000001',
    desc: 'Algebra tips #igcse #maths',
    createTime: String(Math.floor(Date.parse('2026-10-01T00:00:00Z') / 1000)),
    stats: { playCount: 5121, diggCount: 192, commentCount: 6, shareCount: 6, collectCount: '27' },
    author: { uniqueId: 'tutor1' },
    locationCreated: 'AE',
    textLanguage: 'en',
    textExtra: [{ hashtagName: 'IGCSE' }, { hashtagName: '' }],
    video: { duration: 31 },
    ...over,
});

describe('video page', () => {
    it('reads the numbers, date, country and lower-cased hashtags', () => {
        const res = parseVideoPage(page(item()));
        expect(res.status).toBe('ok');
        expect(res.video).toMatchObject({
            videoId: '7600000000000000001',
            author: 'tutor1',
            views: 5121,
            likes: 192,
            saves: 27,
            region: 'AE',
            language: 'en',
            hashtags: ['igcse'],
            createdAt: '2026-10-01T00:00:00.000Z',
        });
    });
    it('says what is wrong with a page without video data', () => {
        expect(parseVideoPage('<html></html>').status).toBe('no_data');
        expect(parseVideoPage(page(null, 10204)).detail).toMatch(/10204/);
    });
    it('finds video addresses in a result page, also percent-encoded', () => {
        const html =
            'x https://www.tiktok.com/@Alpha/video/7600000000000000001 y https%3A%2F%2Fwww.tiktok.com%2F%40beta%2Fvideo%2F7600000000000000002?q=1 z https://www.tiktok.com/@alpha';
        expect(videoUrlsIn(html)).toEqual([
            'https://www.tiktok.com/@alpha/video/7600000000000000001',
            'https://www.tiktok.com/@beta/video/7600000000000000002',
        ]);
    });
});

describe('statistics and filters', () => {
    it('computes percentiles and a summary', () => {
        expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
        const videos = [100, 200, 300, 400, 1000].map((views, i) => ({
            views,
            likes: views / 10,
            comments: 1,
            shares: 0,
            region: i < 3 ? 'AE' : 'SA',
            createdAt: `2026-10-0${i + 1}T00:00:00.000Z`,
        }));
        const s = summariseVideos(videos);
        expect(s).toMatchObject({
            videosUsed: 5,
            medianViews: 300,
            p25Views: 200,
            p75Views: 400,
            regions: { AE: 3, SA: 2 },
            viewTargets: { conservative: 200, typical: 300, ambitious: 400 },
        });
        expect(summariseVideos([])).toBeNull();
    });
    it('keeps tagged, recent, in-region videos', () => {
        const v = parseVideoPage(page(item())).video;
        const opts = { tag: 'igcse', recentDays: 90, regions: ['AE'], now: NOW };
        expect(keepVideo(v, opts)).toBeNull();
        expect(keepVideo(v, { ...opts, tag: 'sat' })).toBe('notTagged');
        expect(keepVideo(v, { ...opts, recentDays: 5 })).toBe('tooOld');
        expect(keepVideo(v, { ...opts, regions: ['SA'] })).toBe('otherRegion');
        expect(keepVideo({ ...v, hashtags: [], description: 'tips #igcse' }, opts)).toBeNull();
    });
});

describe('search and run', () => {
    it('pages the search, backs off on 429 and stops when nothing new comes', async () => {
        const calls = [];
        let first = true;
        const fetch = async (url) => {
            calls.push(url);
            if (first) {
                first = false;
                return { status: 429, body: '' };
            }
            return {
                status: 200,
                body: 'https://www.tiktok.com/@aa/video/7600000000000000001 https://www.tiktok.com/@bb/video/7600000000000000002',
            };
        };
        const res = await findVideoUrls({ tag: 'igcse', want: 10, maxPages: 3, fetch, paceMs: 0, backoffMs: 0 });
        expect(res.urls).toHaveLength(2);
        expect(res.rateLimited).toBe(true);
        expect(res.attempts.some((a) => a.status === 'ok')).toBe(true);
    });

    it('returns video rows and a benchmark row, with a thin-sample warning', async () => {
        const rows = [];
        const urls = Array.from({ length: 4 }, (_, i) => `https://www.tiktok.com/@u${i}/video/760000000000000000${i}`);
        const input = readInput({ hashtags: ['#IGCSE'], regions: ['ae'], delayBetweenVideosMs: 0, concurrency: 1 });
        await run({
            input,
            pushData: async (r) => void rows.push(r),
            search: async () => ({ urls, attempts: [], rateLimited: false }),
            fetchVideo: async (url) => ({
                status: 200,
                html: page(
                    item({
                        id: url.split('/').pop(),
                        stats: {
                            playCount: 1000 * (urls.indexOf(url) + 1),
                            diggCount: 10,
                            commentCount: 1,
                            shareCount: 1,
                        },
                    }),
                ),
            }),
            now: () => NOW,
        });
        expect(rows.filter((r) => r.recordType === 'video')).toHaveLength(4);
        const b = rows.find((r) => r.recordType === 'benchmark');
        expect(b).toMatchObject({ hashtag: 'igcse', status: 'thin_sample', videosUsed: 4, medianViews: 2500 });
        expect(rows.every((r) => r.scrapedAt && r.status)).toBe(true);
    });

    it('reports no_videos with the reason when search found nothing', async () => {
        const rows = [];
        await run({
            input: readInput({ hashtags: ['x1'] }),
            pushData: async (r) => void rows.push(r),
            search: async () => ({ urls: [], attempts: [], rateLimited: true }),
            fetchVideo: async () => ({ status: 404, html: '' }),
        });
        expect(rows[0]).toMatchObject({ recordType: 'benchmark', status: 'no_videos' });
        expect(rows[0].statusDetail).toMatch(/limited/);
    });
});
