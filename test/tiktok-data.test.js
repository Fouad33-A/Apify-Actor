import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RateLimitError } from '../src/errors.js';
import * as tiktok from '../src/platforms/tiktok.js';
import { launchBrowser, serve } from './helpers/browser.js';

vi.mock('apify', () => ({
    Actor: { setValue: vi.fn(async () => {}) },
    log: { info: vi.fn(), warning: vi.fn(), exception: vi.fn() },
}));

// SYNTHETIC JSON in the shapes TikTok's own web pages load for a logged-out visitor. The live shapes are
// confirmed against real runs with `mode: "probe"` + captureUrls; these tests prove the parsing logic.
const T0 = 1_780_000_000; // seconds
const item = (n, over = {}) => ({
    id: `76000000000000000${n}`,
    desc: `caption ${n} #tag "quoted" & <b>raw</b>`,
    createTime: T0 - n * 86_400,
    author: { id: '1', uniqueId: 'nasa', nickname: 'NASA', signature: 'bio', verified: true },
    stats: { diggCount: 1000 * n, commentCount: 10 * n, shareCount: 5 * n, playCount: 100_000 * n },
    statsV2: {
        diggCount: `${1000 * n + 1}`,
        commentCount: `${10 * n + 1}`,
        shareCount: `${5 * n + 1}`,
        playCount: `${100_000 * n + 1}`,
    },
    ...over,
});

describe('parseItem (pure)', () => {
    it('reads caption unescaped, exact counts, date, url', () => {
        const r = tiktok.parseItem(item(1));
        expect(r).toMatchObject({
            id: '760000000000000001',
            username: 'nasa',
            caption: 'caption 1 #tag "quoted" & <b>raw</b>',
            likeCount: 1001,
            commentCount: 11,
            shareCount: 6,
            viewCount: 100_001,
            postUrl: 'https://www.tiktok.com/@nasa/video/760000000000000001',
            publishDate: new Date((T0 - 86_400) * 1000).toISOString(),
        });
    });

    it('falls back to rounded stats, and to null for anything missing (never 0-guessed)', () => {
        const r = tiktok.parseItem({ id: '5', author: { uniqueId: 'x' }, stats: { diggCount: 7 } });
        expect(r).toMatchObject({
            likeCount: 7,
            commentCount: null,
            shareCount: null,
            viewCount: null,
            caption: null,
            publishDate: null,
        });
    });

    it('a real zero stays 0', () => {
        expect(tiktok.parseItem({ id: '5', author: { uniqueId: 'x' }, statsV2: { diggCount: '0' } }).likeCount).toBe(0);
    });

    it('photo posts get a /photo/ URL', () => {
        expect(tiktok.parseItem(item(1, { imagePost: { images: [] } })).postUrl).toMatch(/\/photo\/760/);
    });

    it('author given as a plain string, or absent, falls back to the profile username', () => {
        expect(tiktok.parseItem({ id: '5', author: 'abc' }).username).toBe('abc');
        expect(tiktok.parseItem({ id: '5' }, 'fallback').username).toBe('fallback');
        expect(tiktok.parseItem({ id: '5' }).postUrl).toBeNull();
    });

    it('sponsored flag is only set from explicit fields', () => {
        expect(tiktok.parseItem(item(1, { isAd: true })).isSponsored).toBe(true);
        expect(tiktok.parseItem(item(1, { isAd: false })).isSponsored).toBe(false);
        expect(tiktok.parseItem(item(1)).isSponsored).toBeNull();
    });

    it.each([[null], [undefined], [{}], ['x']])('rejects %j', (v) => {
        expect(tiktok.parseItem(v)).toBeNull();
    });

    it('search hits carry author follower counts', () => {
        const r = tiktok.parseItem(item(1, { authorStatsV2: { followerCount: '1234567', followingCount: '3' } }));
        expect(r).toMatchObject({ followerCount: 1_234_567, followingCount: 3 });
    });
});

describe('parseItemList / parseSearchResponse / parseVideoDetail / parseCommentList', () => {
    it('item list keeps order and the hasMore flag; junk entries are dropped', () => {
        const r = tiktok.parseItemList({ itemList: [item(1), null, { nope: 1 }, item(2)], hasMore: true });
        expect(r.items.map((i) => i.id.slice(-1))).toEqual(['1', '2']);
        expect(r.hasMore).toBe(true);
        expect(tiktok.parseItemList({}).items).toEqual([]);
    });

    it('search response in both shapes', () => {
        expect(tiktok.parseSearchResponse({ item_list: [item(1)], has_more: 1 })).toMatchObject({ hasMore: true });
        const r = tiktok.parseSearchResponse({
            data: [{ type: 1, item: item(1) }, { type: 4 }, { type: 1, item: item(2) }],
        });
        expect(r.items).toHaveLength(2);
        expect(r.hasMore).toBe(false);
        expect(tiktok.parseSearchResponse(null).items).toEqual([]);
    });

    it('video detail: ok / not_found / private / unrecognised', () => {
        const wrap = (detail) => ({ __DEFAULT_SCOPE__: { 'webapp.video-detail': detail } });
        expect(tiktok.parseVideoDetail(wrap({ itemInfo: { itemStruct: item(1) } })).state).toBe('ok');
        expect(tiktok.parseVideoDetail(wrap({ statusCode: 10204 })).state).toBe('not_found');
        expect(tiktok.parseVideoDetail(wrap({ statusCode: 10222 })).state).toBe('private');
        expect(tiktok.parseVideoDetail(wrap({ statusCode: 1 }))).toEqual({ state: 'unrecognised', statusCode: 1 });
        expect(tiktok.parseVideoDetail(null).state).toBe('unrecognised');
    });

    it('comment list: handle, display name, likes, exact date, replies flagged', () => {
        const r = tiktok.parseCommentList({
            comments: [
                {
                    cid: 'c1',
                    text: 'love it <3 "wow" & more',
                    digg_count: 42,
                    create_time: T0,
                    reply_id: '0',
                    user: { unique_id: 'fan_1', nickname: 'Fan One' },
                    reply_comment: [
                        {
                            cid: 'c2',
                            text: 'thanks',
                            digg_count: 0,
                            create_time: T0 + 60,
                            reply_id: 'c1',
                            user: { unique_id: 'nasa' },
                        },
                    ],
                },
                { cid: 'c3', text: 'no likes field', user: {} },
                null,
            ],
            has_more: 1,
            total: 130,
        });
        expect(r.hasMore).toBe(true);
        expect(r.total).toBe(130);
        expect(r.comments).toEqual([
            {
                id: 'c1',
                commenterUsername: 'fan_1',
                commenterDisplayName: 'Fan One',
                commentText: 'love it <3 "wow" & more',
                likeCount: 42,
                commentDate: new Date(T0 * 1000).toISOString(),
                isReply: false,
            },
            {
                id: 'c2',
                commenterUsername: 'nasa',
                commenterDisplayName: null,
                commentText: 'thanks',
                likeCount: 0,
                commentDate: new Date((T0 + 60) * 1000).toISOString(),
                isReply: true,
            },
            {
                id: 'c3',
                commenterUsername: null,
                commenterDisplayName: null,
                commentText: 'no likes field',
                likeCount: null,
                commentDate: null,
                isReply: false,
            },
        ]);
    });
});

describe('filterAndSortHits', () => {
    const items = [1, 2, 3].map((n) => tiktok.parseItem(item(n, { createTime: T0 - n * 86_400 * 10 })));
    it("relevance keeps TikTok's order", () => {
        expect(tiktok.filterAndSortHits(items).map((i) => i.id.slice(-1))).toEqual(['1', '2', '3']);
    });
    it('recent sorts by date, liked by likes', () => {
        const shuffled = [items[1], items[2], items[0]];
        expect(tiktok.filterAndSortHits(shuffled, { sortOrder: 'recent' }).map((i) => i.id.slice(-1))).toEqual([
            '1',
            '2',
            '3',
        ]);
        expect(tiktok.filterAndSortHits(items, { sortOrder: 'liked' }).map((i) => i.id.slice(-1))).toEqual([
            '3',
            '2',
            '1',
        ]);
    });
    it('date range is inclusive of the whole end day and drops undatable hits', () => {
        const day = (s) => new Date(s * 1000).toISOString().slice(0, 10);
        const target = items[1];
        const r = tiktok.filterAndSortHits([...items, { ...items[0], id: 'nodate', createTime: null }], {
            dateFrom: day(target.createTime),
            dateTo: day(target.createTime),
        });
        expect(r.map((i) => i.id)).toEqual([target.id]);
    });
});

describe('TikTok flows (real Chromium, synthetic pages)', () => {
    let browser;
    beforeAll(async () => {
        browser = await launchBrowser();
        Object.assign(tiktok.timing, {
            listWaitMs: 2500,
            commentWaitMs: 2000,
            commentRetryWaitMs: 1000,
            nextPageWaitMs: 1500,
        });
    });
    afterAll(async () => {
        await browser?.close();
    });

    const json = (body, over = {}) => ({ contentType: 'application/json', body: JSON.stringify(body), ...over });
    const detailRoot = (postCount = 3) => ({
        __DEFAULT_SCOPE__: {
            'webapp.user-detail': {
                userInfo: {
                    user: {
                        uniqueId: 'nasa',
                        nickname: 'NASA',
                        signature: 'Contact: press@nasa.example',
                        verified: true,
                        bioLink: { link: 'https://nasa.gov' },
                    },
                    stats: { followerCount: 2_000_000, videoCount: postCount },
                    statsV2: {
                        followerCount: '1872463',
                        followingCount: '23',
                        heartCount: '9803342',
                        videoCount: `${postCount}`,
                    },
                },
                statusCode: 0,
            },
        },
    });
    // The profile page fetches page 1 on load and page 2 when scrolled, like TikTok's grid does.
    const profilePage = (
        root,
        { fetchScript = true } = {},
    ) => `<!doctype html><html><body style="height:6000px">NASA nasa
        <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(root)}</script>
        ${
            fetchScript
                ? `<script>
        fetch('/api/post/item_list/?cursor=0');
        let done = false;
        window.addEventListener('scroll', () => { if (!done) { done = true; fetch('/api/post/item_list/?cursor=1'); } });
        </script>`
                : ''
        }</body></html>`;

    async function withPage(routes, fn) {
        const context = await browser.newContext();
        try {
            await serve(context, routes);
            return await fn(await context.newPage());
        } finally {
            await context.close();
        }
    }

    it('profile + recent posts: pages through the list, newest first, capped, author facts on every post', async () => {
        const routes = [
            { match: /cursor=0/, ...json({ itemList: [item(3), item(1)], hasMore: true, cursor: '1' }) },
            { match: /cursor=1/, ...json({ itemList: [item(2), item(4)], hasMore: false }) },
            { match: /tiktok\.com\/@nasa$/, body: profilePage(detailRoot(4)) },
        ];
        const { profile, posts } = await withPage(routes, (page) =>
            tiktok.lookupProfile({ page, username: 'nasa', sourceInput: 'nasa', maxRecentPosts: 3 }),
        );
        expect(profile).toMatchObject({
            status: 'found',
            followerCount: 1_872_463,
            contactEmails: ['press@nasa.example'],
        });
        expect(posts.map((p) => p.postUrl.slice(-1))).toEqual(['1', '2', '3']); // newest first, capped at 3
        expect(posts[0]).toMatchObject({
            recordType: 'post',
            platform: 'tiktok',
            username: 'nasa',
            followerCount: 1_872_463,
            bio: 'Contact: press@nasa.example',
            externalLinks: ['https://nasa.gov'],
            likeCount: 1001,
            commentCount: 11,
            shareCount: 6,
            viewCount: 100_001,
            status: 'found',
        });
        expect(posts[0].caption).toBe('caption 1 #tag "quoted" & <b>raw</b>');
    }, 60_000);

    it('stops scrolling once shouldContinue says so', async () => {
        const routes = [
            { match: /cursor=0/, ...json({ itemList: [item(1)], hasMore: true, cursor: '1' }) },
            { match: /cursor=1/, ...json({ itemList: [item(2)], hasMore: false }) },
            { match: /tiktok\.com\/@nasa$/, body: profilePage(detailRoot(2)) },
        ];
        const { posts } = await withPage(routes, (page) =>
            tiktok.lookupProfile({
                page,
                username: 'nasa',
                sourceInput: 'nasa',
                maxRecentPosts: 5,
                shouldContinue: () => false,
            }),
        );
        expect(posts).toHaveLength(1);
    }, 60_000);

    it('maxRecentPosts 0 never requests the video list', async () => {
        const routes = [
            { match: /cursor=/, ...json({ itemList: [item(1)] }) },
            { match: /tiktok\.com\/@nasa$/, body: profilePage(detailRoot(4)) },
        ];
        const { posts } = await withPage(routes, (page) =>
            tiktok.lookupProfile({ page, username: 'nasa', sourceInput: 'nasa', maxRecentPosts: 0 }),
        );
        expect(posts).toEqual([]);
    }, 60_000);

    it('a video list that never loads yields ONE blocked post row, not a silent empty result', async () => {
        const routes = [{ match: /tiktok\.com\/@nasa$/, body: profilePage(detailRoot(4), { fetchScript: false }) }];
        const { profile, posts } = await withPage(routes, async (page) => {
            return tiktok.lookupProfile({ page, username: 'nasa', sourceInput: 'nasa', maxRecentPosts: 2 });
        });
        expect(profile.status).toBe('found');
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({ recordType: 'post', status: 'blocked', likeCount: null, caption: null });
        expect(posts[0].statusDetail).toMatch(/did not load the video list/);
    }, 60_000);

    it('a profile with 0 videos does not wait for a list', async () => {
        const routes = [{ match: /tiktok\.com\/@nasa$/, body: profilePage(detailRoot(0), { fetchScript: false }) }];
        const t = Date.now();
        const { posts } = await withPage(routes, (page) =>
            tiktok.lookupProfile({ page, username: 'nasa', sourceInput: 'nasa', maxRecentPosts: 2 }),
        );
        expect(posts).toEqual([]);
        expect(Date.now() - t).toBeLessThan(10_000);
    }, 60_000);

    it('an empty list although the profile shows videos is reported as blocked, with the status code', async () => {
        const routes = [
            { match: /cursor=0/, ...json({ itemList: [], hasMore: false, statusCode: 10101 }) },
            { match: /tiktok\.com\/@nasa$/, body: profilePage(detailRoot(4)) },
        ];
        const { posts } = await withPage(routes, (page) =>
            tiktok.lookupProfile({ page, username: 'nasa', sourceInput: 'nasa', maxRecentPosts: 2 }),
        );
        expect(posts[0].status).toBe('blocked');
        expect(posts[0].statusDetail).toMatch(/empty video list.*10101/);
    }, 60_000);

    const videoPage = (root, script = '') =>
        `<!doctype html><html><body style="height:6000px">video
        <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(root)}</script>
        <script>${script}</script></body></html>`;
    const videoRoot = (commentCount = 4) => ({
        __DEFAULT_SCOPE__: {
            'webapp.video-detail': {
                itemInfo: {
                    itemStruct: item(1, { stats: { commentCount }, statsV2: { commentCount: `${commentCount}` } }),
                },
                statusCode: 0,
            },
        },
    });
    const comment = (n, over = {}) => ({
        cid: `c${n}`,
        text: `comment ${n}`,
        digg_count: n,
        create_time: T0 + n,
        reply_id: '0',
        user: { unique_id: `fan${n}`, nickname: `Fan ${n}` },
        ...over,
    });
    const VIDEO_RE = /tiktok\.com\/@nasa\/video\/760000000000000001$/;
    const VIDEO_URL = 'https://www.tiktok.com/@nasa/video/760000000000000001';

    it('comments: real text, likes, handle and date, paged by scrolling and capped', async () => {
        const script = `fetch('/api/comment/list/?cursor=0'); let d=false; window.addEventListener('scroll',()=>{ if(!d){d=true; fetch('/api/comment/list/?cursor=20');} });`;
        const routes = [
            {
                match: /comment\/list\/\?cursor=0/,
                ...json({ comments: [comment(1), comment(2)], has_more: 1, cursor: 20, total: 4 }),
            },
            {
                match: /comment\/list\/\?cursor=20/,
                ...json({ comments: [comment(3), comment(4)], has_more: 0, total: 4 }),
            },
            { match: VIDEO_RE, body: videoPage(videoRoot(4), script) },
        ];
        const rows = await withPage(routes, (page) =>
            tiktok.fetchComments({ page, postUrl: VIDEO_URL, sourceInput: 'nasa', maxComments: 3 }),
        );
        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatchObject({
            recordType: 'comment',
            platform: 'tiktok',
            postUrl: VIDEO_URL,
            commenterUsername: 'fan1',
            commenterDisplayName: 'Fan 1',
            commentText: 'comment 1',
            likeCount: 1,
            commentDate: new Date((T0 + 1) * 1000).toISOString(),
            isReply: false,
            status: 'found',
        });
    }, 60_000);

    it('top-level only drops replies; topLevelOnly=false keeps them flagged', async () => {
        const list = {
            comments: [comment(1, { reply_comment: [comment(2, { reply_id: 'c1' })] })],
            has_more: 0,
            total: 2,
        };
        const routes = [
            { match: /comment\/list/, ...json(list) },
            { match: VIDEO_RE, body: videoPage(videoRoot(2), `fetch('/api/comment/list/?cursor=0');`) },
        ];
        const top = await withPage(routes, (page) =>
            tiktok.fetchComments({ page, postUrl: VIDEO_URL, sourceInput: 'x', topLevelOnly: true }),
        );
        const all = await withPage(routes, (page) =>
            tiktok.fetchComments({ page, postUrl: VIDEO_URL, sourceInput: 'x', topLevelOnly: false }),
        );
        expect(top.map((r) => r.isReply)).toEqual([false]);
        expect(all.map((r) => r.isReply)).toEqual([false, true]);
    }, 60_000);

    it('a video with zero comments returns no rows and does not wait', async () => {
        const routes = [{ match: VIDEO_RE, body: videoPage(videoRoot(0)) }];
        const t = Date.now();
        const rows = await withPage(routes, (page) =>
            tiktok.fetchComments({ page, postUrl: VIDEO_URL, sourceInput: 'x' }),
        );
        expect(rows).toEqual([]);
        expect(Date.now() - t).toBeLessThan(10_000);
    }, 60_000);

    it('video not found / private are their own statuses', async () => {
        const wrap = (statusCode) => ({ __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode } } });
        const nf = await withPage([{ match: VIDEO_RE, body: videoPage(wrap(10204)) }], (page) =>
            tiktok.fetchComments({ page, postUrl: VIDEO_URL, sourceInput: 'x' }),
        );
        expect(nf[0]).toMatchObject({ status: 'not_found', commentText: null });
        const pv = await withPage([{ match: VIDEO_RE, body: videoPage(wrap(10222)) }], (page) =>
            tiktok.fetchComments({ page, postUrl: VIDEO_URL, sourceInput: 'x' }),
        );
        expect(pv[0].status).toBe('private');
    }, 60_000);

    it('a comment list that never loads is a blocked row, never a made-up empty result', async () => {
        const routes = [{ match: VIDEO_RE, body: videoPage(videoRoot(9)) }];
        const rows = await withPage(routes, (page) =>
            tiktok.fetchComments({ page, postUrl: VIDEO_URL, sourceInput: 'x' }),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'blocked', commentText: null, commenterUsername: null });
    }, 60_000);

    it('a visible challenge on the video page throws RateLimitError', async () => {
        const body = '<html><body>Verify to continue</body></html>';
        await expect(
            withPage([{ match: VIDEO_RE, body }], (page) =>
                tiktok.fetchComments({ page, postUrl: VIDEO_URL, sourceInput: 'x' }),
            ),
        ).rejects.toBeInstanceOf(RateLimitError);
    }, 60_000);

    const searchPage = (script) =>
        `<!doctype html><html><body style="height:6000px">search<script>${script}</script></body></html>`;
    const SEARCH_RE = /tiktok\.com\/search\/video\?q=etf(%20|\+)investing$/;

    it('search: hits become posts (author facts embedded) plus one profile per distinct author', async () => {
        const hit = (n, user, followers) =>
            item(n, {
                author: {
                    uniqueId: user,
                    nickname: user.toUpperCase(),
                    signature: `${user} bio a@b.co`,
                    verified: false,
                },
                authorStatsV2: { followerCount: `${followers}`, followingCount: '1' },
            });
        const routes = [
            {
                match: /\/api\/search\/general\/full/,
                ...json({
                    data: [
                        { type: 1, item: hit(1, 'alice', 500) },
                        { type: 1, item: hit(2, 'bob', 900) },
                        { type: 1, item: hit(3, 'alice', 500) },
                    ],
                    has_more: 0,
                }),
            },
            { match: SEARCH_RE, body: searchPage(`fetch('/api/search/general/full/?keyword=etf');`) },
        ];
        const { posts, profiles } = await withPage(routes, (page) =>
            tiktok.searchPosts({
                page,
                query: 'etf investing',
                sortOrder: 'liked',
                maxResults: 2,
                sourceInput: 'etf investing',
            }),
        );
        expect(posts.map((p) => p.username)).toEqual(['alice', 'bob']); // liked sort: alice 3001, bob 2001 (alice's 1001 falls outside maxResults 2)
        expect(posts[0]).toMatchObject({
            platform: 'tiktok',
            followerCount: 500,
            bio: 'alice bio a@b.co',
            sourceInput: 'etf investing',
        });
        expect(profiles.map((p) => p.username)).toEqual(['alice', 'bob']);
        expect(profiles[0]).toMatchObject({
            recordType: 'profile',
            followerCount: 500,
            contactEmails: ['a@b.co'],
            status: 'found',
        });
        expect(profiles[0].statusDetail).toMatch(/Taken from the search result/);
    }, 60_000);

    it('search with no data for a logged-out visitor throws (becomes an error row), never returns a fake empty result', async () => {
        const routes = [{ match: SEARCH_RE, body: searchPage('') }];
        await expect(
            withPage(routes, (page) => tiktok.searchPosts({ page, query: 'etf investing', sourceInput: 'q' })),
        ).rejects.toThrow(/no result data/);
    }, 90_000);
});
