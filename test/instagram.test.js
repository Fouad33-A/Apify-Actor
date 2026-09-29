// Instagram extraction + flow tests. Fixtures are SYNTHETIC (see helpers/fixtures.js).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimitError } from '../src/errors.js';
import {
    domExtractComments,
    domExtractPostMetrics,
    domExtractProfile,
    extractEmbedContext,
    extractProfileJson,
    fetchComments,
    findUserNode,
    lookupProfile,
    mediaNodeToPostRow,
    parseEmbedText,
    parsePostDescription,
} from '../src/platforms/instagram.js';
import { launchBrowser, serve } from './helpers/browser.js';
import { igComment, igEmbedPage, igGrid, igHeader, igPage, igPost } from './helpers/fixtures.js';

const setValue = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('apify', () => ({
    Actor: { setValue },
    log: { info: vi.fn(), warning: vi.fn(), exception: vi.fn() },
}));

let browser;
beforeAll(async () => {
    browser = await launchBrowser();
});
afterAll(async () => {
    await browser?.close();
});
beforeEach(() => setValue.mockClear());

async function evaluate(html, fn, arg) {
    const page = await browser.newPage();
    try {
        await page.setContent(html);
        return await page.evaluate(fn, arg);
    } finally {
        await page.close();
    }
}

describe('domExtractProfile (in-page)', () => {
    it('extracts every header field, preferring the exact count from the title attribute', async () => {
        const dom = await evaluate(igPage(igHeader()), domExtractProfile);
        expect(dom).toMatchObject({
            username: 'nasa',
            fullName: 'NASA',
            bio: 'Exploring the universe\nand our home planet.',
            followerCount: 104_333_810, // exact, from title="104,333,810" - not 104,000,000 from "104M"
            followingCount: 70,
            postCount: 4000,
            verified: true,
            externalLinks: [],
            posts: [],
        });
    });

    it('falls back to the abbreviated text when there is no exact title attribute', async () => {
        const dom = await evaluate(igPage(igHeader({ followers: ['1.2M', null] })), domExtractProfile);
        expect(dom.followerCount).toBe(1_200_000);
    });

    it.each([
        ['12K', 12_000],
        ['3.5B', 3_500_000_000],
        ['1,234', 1234],
        ['0', 0],
    ])('parses follower text %s -> %s', async (shown, expected) => {
        const dom = await evaluate(igPage(igHeader({ followers: [shown, null] })), domExtractProfile);
        expect(dom.followerCount).toBe(expected);
    });

    it('verified is false (not null) when the badge is absent', async () => {
        const dom = await evaluate(igPage(igHeader({ verified: false })), domExtractProfile);
        expect(dom.verified).toBe(false);
    });

    it('fullName is null when the stats follow the username directly', async () => {
        const dom = await evaluate(igPage(igHeader({ fullName: null })), domExtractProfile);
        expect(dom.fullName).toBeNull();
    });

    it('bio is null when there is no bio text', async () => {
        const dom = await evaluate(igPage(igHeader({ bioLines: [] })), domExtractProfile);
        expect(dom.bio).toBeNull();
    });

    it("bio stops at the '... and N more' link line", async () => {
        const dom = await evaluate(
            igPage(igHeader({ bioLines: ['Line one'], moreLine: 'nasa.gov and 2 more' })),
            domExtractProfile,
        );
        expect(dom.bio).toBe('Line one');
    });

    it('bio stops at a button/control word', async () => {
        const dom = await evaluate(
            igPage(igHeader({ bioLines: ['Line one'], extra: '<div>Follow</div>' })),
            domExtractProfile,
        );
        expect(dom.bio).toBe('Line one');
    });

    it('external links: keeps real outbound anchors, drops instagram.com and threads links, de-duplicates', async () => {
        const dom = await evaluate(
            igPage(
                igHeader({
                    bioLines: [],
                    moreLine: 'nasa.gov and 1 more',
                    links: [
                        'https://www.nasa.gov/',
                        'https://www.nasa.gov/',
                        'https://www.instagram.com/other/',
                        'https://www.threads.net/@nasa',
                    ],
                }),
            ),
            domExtractProfile,
        );
        expect(dom.externalLinks).toEqual(['https://www.nasa.gov/']);
    });

    it("external links: falls back to the visible domain of the '... and N more' line when no anchor exists", async () => {
        const dom = await evaluate(
            igPage(igHeader({ bioLines: [], moreLine: 'nasa.gov and 2 more' })),
            domExtractProfile,
        );
        expect(dom.externalLinks).toEqual(['nasa.gov']);
    });

    it('returns null when there is no <header>', async () => {
        expect(await evaluate(igPage('<main>nothing</main>'), domExtractProfile)).toBeNull();
    });

    it('returns null when the header has no stats lines (not a real profile header)', async () => {
        expect(
            await evaluate(igPage('<header><div>Log in</div><div>Sign up</div></header>'), domExtractProfile),
        ).toBeNull();
    });

    it('post grid: de-duplicates hrefs, keeps alt text as caption, null caption when there is no image', async () => {
        const dom = await evaluate(
            igPage(
                igHeader() +
                    igGrid([
                        { href: '/p/AAA/', alt: 'A caption' },
                        { href: '/p/AAA/', alt: 'A caption' },
                        { href: '/p/BBB/' },
                    ]),
            ),
            domExtractProfile,
        );
        expect(dom.posts.map((p) => [p.href, p.caption])).toEqual([
            ['/p/AAA/', 'A caption'],
            ['/p/BBB/', null],
        ]);
    });
});

describe('domExtractPostMetrics (in-page)', () => {
    it('reads the exact publish time, like count and view count', async () => {
        const m = await evaluate(
            igPost({ postIso: '2026-09-20T12:00:00.000Z', likes: '1,234 likes', views: '12.5K views' }),
            domExtractPostMetrics,
        );
        expect(m).toEqual({
            publishDate: '2026-09-20T12:00:00.000Z',
            likeCount: 1234,
            viewCount: 12_500,
            ogDescription: null,
        });
    });

    it('like and view counts are null (not 0) when the post hides them', async () => {
        const m = await evaluate(igPost({}), domExtractPostMetrics);
        expect(m).toEqual({
            publishDate: '2026-09-20T12:00:00.000Z',
            likeCount: null,
            viewCount: null,
            ogDescription: null,
        });
    });

    it('returns the post og:description so caption, likes and comments can be read from it', async () => {
        const m = await evaluate(
            igPost({ ogDescription: '5 likes, 2 comments - nasa on May 1, 2026: "Hi."' }),
            domExtractPostMetrics,
        );
        expect(m.ogDescription).toBe('5 likes, 2 comments - nasa on May 1, 2026: "Hi."');
    });

    it('publishDate is null when there is no <time> element', async () => {
        const m = await evaluate(igPage('<article>no time here</article>'), domExtractPostMetrics);
        expect(m.publishDate).toBeNull();
    });

    it("uses the first like count in document order (the post's, before any comment's)", async () => {
        const m = await evaluate(
            igPost({ likes: '500 likes', comments: [igComment({ user: 'a', body: 'hi', likes: 3 })] }),
            domExtractPostMetrics,
        );
        expect(m.likeCount).toBe(500);
    });
});

describe('domExtractComments (in-page)', () => {
    const comments = [
        igComment({ user: 'alice', body: 'Great post!', likes: 3, iso: '2026-09-21T08:00:00.000Z' }),
        igComment({ user: 'bob', body: 'Line one\nLine two', iso: '2026-09-21T09:00:00.000Z', reply: true }),
        igComment({ user: 'carol', body: 'No controls at all', reply: false }),
    ];

    it("skips the post's own <time> and returns one row per comment block", async () => {
        const rows = await evaluate(igPost({ comments }), domExtractComments, 50);
        expect(rows.map((r) => r.username)).toEqual(['alice', 'bob', 'carol']);
    });

    it('extracts text, like count and exact datetime; strips Reply/like controls from the text', async () => {
        const [alice] = await evaluate(igPost({ comments }), domExtractComments, 50);
        expect(alice).toEqual({
            username: 'alice',
            text: 'Great post!',
            likeCount: 3,
            datetime: '2026-09-21T08:00:00.000Z',
        });
    });

    it('like count is null when the comment shows none', async () => {
        const rows = await evaluate(igPost({ comments }), domExtractComments, 50);
        expect(rows[1].likeCount).toBeNull();
    });

    it('caps the number of comments returned at maxComments', async () => {
        const rows = await evaluate(igPost({ comments }), domExtractComments, 2);
        expect(rows).toHaveLength(2);
    });

    it("returns [] when the page has only the post's own <time>", async () => {
        expect(await evaluate(igPost({ comments: [] }), domExtractComments, 50)).toEqual([]);
    });

    it('skips a block that has fewer than username + time + body lines', async () => {
        const stub = `<li><div><div><div><div><div><time datetime="2026-09-21T08:00:00.000Z">2d</time></div></div></div></div></div></li>`;
        const rows = await evaluate(
            igPost({ comments: [stub, igComment({ user: 'dave', body: 'ok' })] }),
            domExtractComments,
            50,
        );
        expect(rows.map((r) => r.username)).toEqual(['dave']);
    });
});

describe('legacy JSON fallback helpers', () => {
    const user = { username: 'nasa', edge_followed_by: { count: 5 } };
    const html = (obj) => `<script type="application/json">${JSON.stringify(obj)}</script>`;

    it('extractProfileJson finds the blob that mentions edge_followed_by', () => {
        expect(extractProfileJson(html({ graphql: { user } }))).toEqual({ graphql: { user } });
    });

    it('extractProfileJson skips unrelated and malformed script blocks', () => {
        const page = `<script type="application/json">{"other":1}</script><script type="application/json">edge_followed_by {bad</script>`;
        expect(extractProfileJson(page)).toBeNull();
    });

    it('findUserNode looks in graphql.user, data.user and user; null otherwise', () => {
        expect(findUserNode({ graphql: { user } })).toBe(user);
        expect(findUserNode({ data: { user } })).toBe(user);
        expect(findUserNode({ user })).toBe(user);
        expect(findUserNode({ user: { unrelated: true } })).toBeNull();
        expect(findUserNode(null)).toBeNull();
    });
});

// ---- Full flows through a real page; the network is replaced by synthetic responses ----

const PROFILE_URL = /instagram\.com\/nasa\/$/;
const profilePage = (opts = {}) =>
    igPage(
        igHeader(opts) +
            igGrid([
                { href: '/p/AAA/', alt: 'First caption' },
                { href: '/p/BBB/', alt: 'Second caption' },
                { href: '/p/CCC/', alt: 'Third caption' },
            ]),
    );

async function withContext(routes, fn) {
    const context = await browser.newContext();
    try {
        const seen = await serve(context, routes);
        const page = await context.newPage();
        return await fn({ page, seen, context });
    } finally {
        await context.close();
    }
}

describe('lookupProfile (full flow, synthetic pages)', () => {
    const base = { username: 'nasa', sourceInput: 'nasa', maxRecentPosts: 2 };

    it('returns a found profile row and post rows limited by maxRecentPosts', async () => {
        const routes = [
            { match: PROFILE_URL, body: profilePage() },
            {
                match: /\/p\/AAA\/$/,
                body: igPost({
                    postIso: '2026-09-20T12:00:00.000Z',
                    likes: '1,000 likes',
                    ogDescription: '1,000 likes, 56 comments - nasa on September 20, 2026: "The real caption."',
                }),
            },
            { match: /\/p\/BBB\/$/, body: igPost({ postIso: '2026-09-19T12:00:00.000Z' }) },
        ];
        const { profile, posts } = await withContext(routes, ({ page }) => lookupProfile({ page, ...base }));

        expect(profile).toMatchObject({
            recordType: 'profile',
            platform: 'instagram',
            sourceInput: 'nasa',
            status: 'found',
            username: 'nasa',
            displayName: 'NASA',
            followerCount: 104_333_810,
            verified: true,
            totalLikes: null,
            accountCreatedDate: null,
        });
        expect(posts).toHaveLength(2);
        expect(posts[0]).toMatchObject({
            recordType: 'post',
            postUrl: 'https://www.instagram.com/p/AAA/',
            // the grid alt text ("First caption") is an auto-generated image description, not the caption
            caption: 'The real caption.',
            publishDate: '2026-09-20T12:00:00.000Z',
            likeCount: 1000,
            commentCount: 56,
            followerCount: 104_333_810, // author fields are embedded on every post row
        });
        // hidden like count is an honest null, and unexposed metrics are never guessed
        expect(posts[1]).toMatchObject({
            caption: null,
            likeCount: null,
            viewCount: null,
            commentCount: null,
            shareCount: null,
            isSponsored: null,
        });
    }, 60_000);

    it('maxRecentPosts = 0 returns the profile with no posts', async () => {
        const { profile, posts } = await withContext([{ match: PROFILE_URL, body: profilePage() }], ({ page }) =>
            lookupProfile({ page, ...base, maxRecentPosts: 0 }),
        );
        expect(profile.status).toBe('found');
        expect(posts).toEqual([]);
    });

    it('a post page that fails to load yields that post with null metrics; the profile still succeeds', async () => {
        const routes = [
            { match: PROFILE_URL, body: profilePage() },
            { match: /\/p\/AAA\/$/, status: 500, body: '<html><body>Server error</body></html>' },
            { match: /\/p\/BBB\/$/, body: igPost({ likes: '7 likes' }) },
        ];
        const { posts } = await withContext(routes, ({ page }) => lookupProfile({ page, ...base }));
        expect(posts).toHaveLength(2);
        expect(posts[0]).toMatchObject({ caption: null, likeCount: null, publishDate: null });
        expect(posts[1].likeCount).toBe(7);
    }, 60_000);

    it('HTTP 404 -> not_found, no fabricated fields', async () => {
        const { profile, posts } = await withContext(
            [{ match: PROFILE_URL, status: 404, body: igPage('<div>whatever</div>') }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile).toMatchObject({
            status: 'not_found',
            statusDetail: 'HTTP 404',
            followerCount: null,
            bio: null,
        });
        expect(posts).toEqual([]);
    });

    it("'Sorry, this page isn't available' on a 200 -> not_found", async () => {
        const { profile } = await withContext(
            [{ match: PROFILE_URL, body: igPage("<div>Sorry, this page isn't available.</div>") }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile.status).toBe('not_found');
    });

    it('private account banner -> private, nothing else filled in', async () => {
        const { profile, posts } = await withContext(
            [{ match: PROFILE_URL, body: igPage(`${igHeader()}<div>This account is private</div>`) }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile).toMatchObject({ status: 'private', followerCount: null, displayName: null });
        expect(posts).toEqual([]);
    });

    it('a login wall with no usable embed page is reported as blocked (not not_found) and saves diagnostics', async () => {
        const wall = igPage('<form><input name="password"><button>Log in</button></form>');
        const { profile } = await withContext([{ match: PROFILE_URL, body: wall }], ({ page }) =>
            lookupProfile({ page, ...base }),
        );
        expect(profile).toMatchObject({ status: 'blocked', followerCount: null, displayName: null });
        expect(profile.statusDetail).toMatch(/login/i);
        const keys = setValue.mock.calls.map((c) => c[0]);
        expect(keys).toEqual(
            expect.arrayContaining(['DEBUG_HTML_profile_nasa', 'DEBUG_META_profile_nasa', 'DIAG_profile_nasa']),
        );
    }, 60_000);

    it('a redirect to /accounts/login falls back to the public embed page: rounded counts, honest detail, no bio', async () => {
        const routes = [
            {
                match: PROFILE_URL,
                body: `<html><body><script>location.replace('https://www.instagram.com/accounts/login/?next=%2Fnasa%2F&is_from_rle')</script></body></html>`,
            },
            { match: /accounts\/login/, body: igPage('<div>Log into Instagram</div>') },
            {
                match: /instagram\.com\/nasa\/embed\/$/,
                body: igPage(
                    '<div>nasa</div><div>NASA</div><div>104M followers</div><div>•</div><div>4,937 posts</div>',
                ),
            },
        ];
        const { profile, posts } = await withContext(routes, ({ page }) => lookupProfile({ page, ...base }));
        expect(profile).toMatchObject({
            status: 'found',
            username: 'nasa',
            displayName: 'NASA',
            followerCount: 104_000_000,
            postCount: 4937,
            bio: null,
            followingCount: null,
            verified: null,
            externalLinks: [],
        });
        expect(profile.statusDetail).toMatch(/embed page.*rounded/i);
        expect(posts).toEqual([]);
    }, 60_000);

    it('a rate-limit message on the embed page still throws RateLimitError', async () => {
        const routes = [
            {
                match: PROFILE_URL,
                body: `<html><body><script>location.replace('https://www.instagram.com/accounts/login/?next=%2Fnasa%2F')</script></body></html>`,
            },
            { match: /accounts\/login/, body: igPage('<div>Log into Instagram</div>') },
            { match: /embed\/$/, body: igPage('<div>Please wait a few minutes before you try again.</div>') },
        ];
        await expect(withContext(routes, ({ page }) => lookupProfile({ page, ...base }))).rejects.toBeInstanceOf(
            RateLimitError,
        );
    }, 60_000);

    it('DEBUG_META is saved as a JSON string (Actor.setValue rejects raw objects when contentType is set)', async () => {
        await withContext([{ match: PROFILE_URL, body: igPage('<div>unrecognised</div>') }], ({ page }) =>
            lookupProfile({ page, ...base }),
        );
        const meta = setValue.mock.calls.find((c) => c[0] === 'DEBUG_META_profile_nasa');
        expect(typeof meta[1]).toBe('string');
        expect(() => JSON.parse(meta[1])).not.toThrow();
    });

    it('an unrecognised layout is reported as not_found with a layout-change detail', async () => {
        const { profile } = await withContext(
            [{ match: PROFILE_URL, body: igPage('<div>unrecognised</div>') }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile.status).toBe('not_found');
        expect(profile.statusDetail).toMatch(/changed its page structure/i);
    });

    it('a rate-limit page throws RateLimitError instead of returning a row', async () => {
        await expect(
            withContext(
                [{ match: PROFILE_URL, body: igPage('Please wait a few minutes before you try again.') }],
                ({ page }) => lookupProfile({ page, ...base }),
            ),
        ).rejects.toBeInstanceOf(RateLimitError);
    });

    it('a rate-limit page on a post propagates instead of being swallowed as a null-metrics post', async () => {
        const routes = [
            { match: PROFILE_URL, body: profilePage() },
            { match: /\/p\/AAA\/$/, body: igPage('Try Again Later') },
        ];
        await expect(withContext(routes, ({ page }) => lookupProfile({ page, ...base }))).rejects.toBeInstanceOf(
            RateLimitError,
        );
    }, 60_000);

    it('falls back to the legacy JSON blob when the DOM has no header', async () => {
        const json = {
            graphql: {
                user: {
                    username: 'nasa',
                    full_name: 'NASA',
                    biography: 'bio text',
                    external_url: 'https://www.nasa.gov/',
                    is_verified: true,
                    edge_followed_by: { count: 100 },
                    edge_follow: { count: 5 },
                    edge_owner_to_timeline_media: {
                        count: 9,
                        edges: [
                            {
                                node: {
                                    shortcode: 'ZZZ',
                                    taken_at_timestamp: 1_790_000_000,
                                    edge_media_to_caption: { edges: [{ node: { text: 'legacy caption' } }] },
                                    edge_liked_by: { count: 42 },
                                    edge_media_to_comment: { count: 3 },
                                    is_ad: false,
                                },
                            },
                        ],
                    },
                },
            },
        };
        const page = igPage(`<script type="application/json">${JSON.stringify(json)}</script>`);
        const { profile, posts } = await withContext([{ match: PROFILE_URL, body: page }], ({ page: p }) =>
            lookupProfile({ page: p, ...base }),
        );
        expect(profile).toMatchObject({
            status: 'found',
            followerCount: 100,
            followingCount: 5,
            postCount: 9,
            bio: 'bio text',
        });
        expect(posts[0]).toMatchObject({
            postUrl: 'https://www.instagram.com/p/ZZZ/',
            caption: 'legacy caption',
            likeCount: 42,
            commentCount: 3,
            isSponsored: false,
            publishDate: new Date(1_790_000_000 * 1000).toISOString(),
        });
    });
});

describe('fetchComments (full flow, synthetic pages)', () => {
    const POST = 'https://www.instagram.com/p/AAA/';
    const opts = { postUrl: POST, sourceInput: 'nasa', maxComments: 10, topLevelOnly: true };

    it('returns one comment row per DOM comment with exact datetimes', async () => {
        const body = igPost({
            comments: [
                igComment({ user: 'alice', body: 'Great!', likes: 2, iso: '2026-09-21T08:00:00.000Z' }),
                igComment({ user: 'bob', body: 'Nice', iso: '2026-09-21T09:00:00.000Z' }),
            ],
        });
        const rows = await withContext([{ match: /\/p\/AAA\/$/, body }], ({ page }) =>
            fetchComments({ page, ...opts }),
        );
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            recordType: 'comment',
            postUrl: POST,
            commenterUsername: 'alice',
            commentText: 'Great!',
            likeCount: 2,
            commentDate: '2026-09-21T08:00:00.000Z',
            isReply: false,
        });
        expect(rows[1].likeCount).toBeNull();
    }, 60_000);

    it('respects maxComments', async () => {
        const body = igPost({ comments: [1, 2, 3, 4].map((n) => igComment({ user: `u${n}`, body: `c${n}` })) });
        const rows = await withContext([{ match: /\/p\/AAA\/$/, body }], ({ page }) =>
            fetchComments({ page, ...opts, maxComments: 2 }),
        );
        expect(rows.map((r) => r.commenterUsername)).toEqual(['u1', 'u2']);
    });

    it('returns [] (not fabricated rows) for a post with no comments', async () => {
        const rows = await withContext([{ match: /\/p\/AAA\/$/, body: igPost({}) }], ({ page }) =>
            fetchComments({ page, ...opts }),
        );
        expect(rows).toEqual([]);
    });

    it('falls back to legacy JSON comments, including replies only when topLevelOnly is false', async () => {
        const node = {
            owner: { username: 'alice' },
            text: 'parent',
            edge_liked_by: { count: 1 },
            created_at: 1_790_000_000,
            edge_threaded_comments: {
                edges: [{ node: { owner: { username: 'bob' }, text: 'reply', created_at: 1_790_000_100 } }],
            },
        };
        const json = { shortcode_media: { edge_media_to_parent_comment: { edges: [{ node }] } } };
        // extractProfileJson only accepts a blob that mentions edge_followed_by / edge_owner_to_timeline_media.
        const parsable = igPage(
            `<script type="application/json">${JSON.stringify({ ...json, edge_owner_to_timeline_media: {} })}</script>`,
        );
        const top = await withContext([{ match: /\/p\/AAA\/$/, body: parsable }], ({ page }) =>
            fetchComments({ page, ...opts, topLevelOnly: true }),
        );
        expect(top.map((r) => [r.commenterUsername, r.isReply])).toEqual([['alice', false]]);

        const all = await withContext([{ match: /\/p\/AAA\/$/, body: parsable }], ({ page }) =>
            fetchComments({ page, ...opts, topLevelOnly: false }),
        );
        expect(all.map((r) => [r.commenterUsername, r.isReply])).toEqual([
            ['alice', false],
            ['bob', true],
        ]);
    });

    it('a rate-limit page throws RateLimitError', async () => {
        await expect(
            withContext([{ match: /\/p\/AAA\/$/, body: igPage('Please wait a few minutes') }], ({ page }) =>
                fetchComments({ page, ...opts }),
            ),
        ).rejects.toBeInstanceOf(RateLimitError);
    });
});

describe('parseEmbedText', () => {
    it('reads username, name, followers and posts from the embed page text', () => {
        expect(parseEmbedText('nasa\nNASA\n104M followers\n • \n4,937 posts\nView full profile on Instagram')).toEqual({
            username: 'nasa',
            fullName: 'NASA',
            followers: '104M',
            posts: '4,937',
        });
    });

    it('full name is null when the second line is already a stat', () => {
        expect(parseEmbedText('nasa\n1.2K followers\n5 posts').fullName).toBeNull();
    });

    it('returns null when neither count is present (not a profile embed)', () => {
        expect(parseEmbedText('Log into Instagram')).toBeNull();
    });
});

describe('parsePostDescription', () => {
    it('reads likes, comments and the caption from the post og:description', () => {
        expect(
            parsePostDescription(
                '1,234 likes, 56 comments - nasa on September 10, 2026: "The caption. Two sentences."',
            ),
        ).toEqual({
            likeCount: 1234,
            commentCount: 56,
            caption: 'The caption. Two sentences.',
        });
    });

    it('handles abbreviated counts and a trailing period after the quote', () => {
        expect(parsePostDescription('1.2M likes, 3K comments - nasa on May 1, 2026: "Hi."\u0020.').likeCount).toBe(
            1_200_000,
        );
        expect(parsePostDescription('5 likes, 1 comment - nasa on May 1, 2026: "Hi.".').caption).toBe('Hi.');
    });

    it('anything unreadable stays null, never guessed', () => {
        expect(parsePostDescription(null)).toEqual({ likeCount: null, commentCount: null, caption: null });
        expect(parsePostDescription('Something else entirely')).toEqual({
            likeCount: null,
            commentCount: null,
            caption: null,
        });
        expect(parsePostDescription('nasa on May 1, 2026: ""').caption).toBeNull();
    });
});

describe('extractEmbedContext', () => {
    it('reads the profile context from the embed page JSON string', () => {
        const html = igEmbedPage({
            username: 'nasa',
            followers_count: 104_321_770,
            note: 'quote " and \\ backslash and unicode \u00e9',
        });
        expect(extractEmbedContext(html)).toMatchObject({ username: 'nasa', followers_count: 104_321_770 });
    });

    it.each([['no marker here'], ['"contextJSON":"{not json"'], ['"contextJSON":"unterminated']])(
        'returns null for %j',
        (html) => {
            expect(extractEmbedContext(html)).toBeNull();
        },
    );
});

describe('mediaNodeToPostRow', () => {
    const author = { sourceInput: 'nasa', username: 'nasa', displayName: 'NASA', followerCount: 5, verified: true };

    it('maps what the node carries and leaves the rest null', () => {
        const row = mediaNodeToPostRow(
            {
                shortcode: 'AAA',
                taken_at_timestamp: 1_790_000_000,
                edge_media_to_caption: { edges: [{ node: { text: 'cap' } }] },
                edge_liked_by: { count: 9 },
                edge_media_to_comment: { count: 2 },
                video_view_count: 100,
                is_ad: false,
            },
            author,
        );
        expect(row).toMatchObject({
            postUrl: 'https://www.instagram.com/p/AAA/',
            caption: 'cap',
            publishDate: new Date(1_790_000_000 * 1000).toISOString(),
            likeCount: 9,
            commentCount: 2,
            viewCount: 100,
            isSponsored: false,
            shareCount: null,
            followerCount: 5,
        });
    });

    it('a bare node yields nulls, not invented values', () => {
        expect(mediaNodeToPostRow({ shortcode: 'B' }, author)).toMatchObject({
            caption: null,
            publishDate: null,
            likeCount: null,
            commentCount: null,
            viewCount: null,
            isSponsored: null,
        });
    });
});

describe('embed fallback with the real embed JSON shape (synthetic values)', () => {
    const PROFILE = /instagram\.com\/nasa\/$/;
    const redirect = {
        match: PROFILE,
        body: `<html><body><script>location.replace('https://www.instagram.com/accounts/login/?next=%2Fnasa%2F&is_from_rle')</script></body></html>`,
    };
    const loginPage = { match: /accounts\/login/, body: igPage('<div>Log into Instagram</div>') };
    const embed = (context) => ({ match: /\/nasa\/embed\/$/, body: igEmbedPage(context) });
    const base = { username: 'nasa', sourceInput: 'nasa', maxRecentPosts: 2 };
    const context = {
        username: 'nasa',
        full_name: 'NASA',
        is_verified: true,
        is_private: false,
        followers_count: 104_321_770,
        posts_count: 4937,
        graphql_media: [
            { shortcode_media: { shortcode: 'AAA', is_video: false } },
            { shortcode_media: { shortcode: 'BBB', is_video: true, video_view_count: 7 } },
            { shortcode_media: { shortcode: 'CCC' } },
        ],
    };

    it('returns EXACT counts, verified and the latest posts (limited by maxRecentPosts); no bio', async () => {
        const { profile, posts } = await withContext([redirect, loginPage, embed(context)], ({ page }) =>
            lookupProfile({ page, ...base }),
        );
        expect(profile).toMatchObject({
            status: 'found',
            username: 'nasa',
            displayName: 'NASA',
            followerCount: 104_321_770,
            postCount: 4937,
            verified: true,
            bio: null,
            followingCount: null,
        });
        expect(profile.statusDetail).toMatch(/embed page.*no bio/i);
        expect(posts.map((p) => p.postUrl)).toEqual([
            'https://www.instagram.com/p/AAA/',
            'https://www.instagram.com/p/BBB/',
        ]);
        expect(posts[1].viewCount).toBe(7);
        expect(posts[0]).toMatchObject({ followerCount: 104_321_770, verified: true, caption: null, likeCount: null });
    }, 60_000);

    it('a private account returns only header facts with a private status and no posts', async () => {
        const { profile, posts } = await withContext(
            [redirect, loginPage, embed({ ...context, is_private: true })],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile.status).toBe('private');
        expect(posts).toEqual([]);
    }, 60_000);
});
