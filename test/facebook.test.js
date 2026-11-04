// Facebook extraction + flow tests. Fixtures are SYNTHETIC content in the REAL structure captured from a
// live Page outline (see helpers/fixtures.js); they do not prove the real site still looks like this.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RateLimitError } from '../src/errors.js';
import {
    domExtractComments,
    domExtractPluginPosts,
    domExtractPosts,
    domExtractProfile,
    fetchComments,
    lookupProfile,
    parseFacebookOgTitle,
    parseFacebookPostPageText,
    parseFacebookProfileHref,
    parsePluginHeader,
    quickProfile,
    searchPosts,
    unwrapFacebookLink,
} from '../src/platforms/facebook.js';
import { launchBrowser, serve } from './helpers/browser.js';
import { fbComment, fbEventCard, fbPage, fbPost } from './helpers/fixtures.js';

vi.mock('apify', () => ({
    Actor: { setValue: vi.fn(async () => {}) },
    log: { info: vi.fn(), warning: vi.fn(), exception: vi.fn() },
}));

let browser;
beforeAll(async () => {
    browser = await launchBrowser();
});
afterAll(async () => {
    await browser?.close();
});

// Runs the extractor exactly as production does: serialised into the page by page.evaluate.
async function evaluate(html, fn, arg) {
    const page = await browser.newPage();
    try {
        await page.setContent(html);
        return await page.evaluate(fn, arg);
    } finally {
        await page.close();
    }
}

describe('unwrapFacebookLink', () => {
    it('unwraps l.facebook.com redirect links and leaves other URLs alone', () => {
        expect(unwrapFacebookLink('https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.nasa.gov%2F&h=x')).toBe(
            'https://www.nasa.gov/',
        );
        expect(unwrapFacebookLink('https://example.org/a')).toBe('https://example.org/a');
        expect(unwrapFacebookLink('not a url')).toBe('not a url');
    });
});

describe('domExtractProfile (in-page)', () => {
    it('extracts name, counts, bio, category, verified badge, email text and raw redirect links', async () => {
        const dom = await evaluate(fbPage({ links: ['https://www.nasa.gov/'] }), domExtractProfile);
        expect(dom).toMatchObject({
            pageName: 'NASA - National Aeronautics and Space Administration',
            followerCount: 28_000_000,
            followingCount: 52,
            bio: 'Explore the universe and discover our home planet.',
            category: 'Government organization',
            verified: true,
        });
        expect(dom.externalLinks).toHaveLength(1);
        expect(dom.externalLinks[0]).toContain('l.facebook.com/l.php');
        expect(dom.introText).toContain('public-inquiries@hq.nasa.gov');
    });

    it('uses the exact follower count from og:description instead of the rounded visible one', async () => {
        const dom = await evaluate(
            fbPage({ ogDescription: 'NASA. 28,729,285 followers · 122,448 talking about this.' }),
            domExtractProfile,
        );
        expect(dom.followerCount).toBe(28_729_285);
    });

    it('falls back to the rounded visible count when og:description has no follower figure', async () => {
        const dom = await evaluate(fbPage({ ogDescription: 'A page about space.' }), domExtractProfile);
        expect(dom.followerCount).toBe(28_000_000);
    });

    it('verified is false (not null) without the badge, and a verified author inside a post does not count', async () => {
        const post = fbPost().replace(
            '<span>NASA</span>',
            '<span>NASA</span><svg><title>Verified account</title></svg>',
        );
        const dom = await evaluate(fbPage({ verified: false, posts: [post] }), domExtractProfile);
        expect(dom.verified).toBe(false);
    });

    it('bio and category are null when the Intro block has neither', async () => {
        const dom = await evaluate(
            fbPage({ bio: '', category: '', email: '', links: ['https://x.org/'] }),
            domExtractProfile,
        );
        expect(dom.bio).toBeNull();
        expect(dom.category).toBeNull();
    });

    it('returns null for a personal profile (friends, not followers) instead of guessing', async () => {
        expect(await evaluate(fbPage({ personalProfile: true }), domExtractProfile)).toBeNull();
    });

    it('returns null when there is no [role=main] region or no <h1>', async () => {
        expect(await evaluate('<html><body><div>hello</div></body></html>', domExtractProfile)).toBeNull();
        expect(
            await evaluate('<html><body><div role="main"><div>no heading</div></div></body></html>', domExtractProfile),
        ).toBeNull();
    });
});

describe('domExtractPosts (in-page)', () => {
    it('reads the latest post: normalised URL, truncated caption, relative time and total reactions', async () => {
        const [p] = await evaluate(
            fbPage({ posts: [fbPost({ comments: [fbComment({ author: 'A B', text: 'hi' })] })] }),
            domExtractPosts,
            5,
        );
        expect(p).toEqual({
            postUrl: 'https://www.facebook.com/reel/28263630716612782/',
            caption: 'What happens when we detect an asteroid that could pose a threat to Earth?',
            captionTruncated: true,
            relativeTime: '1d',
            reactions: 1700,
            mentionedHrefs: ['https://www.facebook.com/NASA'], // the Page's own header link
        });
    });

    it('comments nested in a post are not returned as posts', async () => {
        const posts = await evaluate(
            fbPage({
                posts: [
                    fbPost({
                        comments: [fbComment({ author: 'A B', text: 'hi' }), fbComment({ author: 'C D', text: 'yo' })],
                    }),
                ],
            }),
            domExtractPosts,
            5,
        );
        expect(posts).toHaveLength(1);
    });

    it('a post without caption text returns caption null, not the "All reactions:" label', async () => {
        const [p] = await evaluate(fbPage({ posts: [fbPost({ caption: null })] }), domExtractPosts, 5);
        expect(p.caption).toBeNull();
        expect(p.reactions).toBe(1700);
    });

    it('an untruncated caption is flagged as such', async () => {
        const [p] = await evaluate(
            fbPage({ posts: [fbPost({ caption: 'Short and complete post text.', truncated: false })] }),
            domExtractPosts,
            5,
        );
        expect(p).toMatchObject({ caption: 'Short and complete post text.', captionTruncated: false });
    });

    it('keeps identifying query parameters for story.php style links and drops tracking ones', async () => {
        const [p] = await evaluate(
            fbPage({
                posts: [fbPost({ url: 'https://www.facebook.com/story.php?story_fbid=123&id=456&__cft__[0]=trk' })],
            }),
            domExtractPosts,
            5,
        );
        expect(p.postUrl).toBe('https://www.facebook.com/story.php?story_fbid=123&id=456');
    });

    it('respects maxPosts, including 0', async () => {
        const html = fbPage({ posts: [fbPost(), fbPost({ url: 'https://www.facebook.com/reel/2/' })] });
        expect(await evaluate(html, domExtractPosts, 1)).toHaveLength(1);
        expect(await evaluate(html, domExtractPosts, 0)).toEqual([]);
    });
});

describe('domExtractComments (in-page)', () => {
    const html = fbPage({
        posts: [
            fbPost({
                comments: [
                    fbComment({
                        author: 'Marc Chervin',
                        text: 'Fortunately NASA has already shown this.',
                        ago: '20h',
                        likes: '3',
                    }),
                    fbComment({
                        author: 'Jay Ford',
                        text: 'Marc Chervin When did they catch a meteor?',
                        ago: '9h',
                        reply: true,
                        to: 'Marc Chervin',
                    }),
                ],
            }),
        ],
    });

    it('reads comments and replies with author, text, relative time, likes and reply flag', async () => {
        const rows = await evaluate(html, domExtractComments, { maxComments: 10 });
        expect(rows).toEqual([
            {
                author: 'Marc Chervin',
                authorHref: 'https://www.facebook.com/marc.chervin?comment_id=1',
                text: 'Fortunately NASA has already shown this.',
                isReply: false,
                relativeTime: '20h',
                likeCount: 3,
            },
            {
                author: 'Jay Ford',
                authorHref: 'https://www.facebook.com/jay.ford?comment_id=1',
                text: 'Marc Chervin When did they catch a meteor?',
                isReply: true,
                relativeTime: '9h',
                likeCount: null,
            },
        ]);
    });

    it('caps the number returned', async () => {
        expect(await evaluate(html, domExtractComments, { maxComments: 1 })).toHaveLength(1);
    });

    it('returns [] when the page shows no comments', async () => {
        expect(await evaluate(fbPage({ posts: [fbPost()] }), domExtractComments, { maxComments: 10 })).toEqual([]);
    });
});

const PAGE_URL = /facebook\.com\/NASA$/;

async function withContext(routes, fn) {
    const context = await browser.newContext();
    try {
        await serve(context, routes);
        return await fn({ page: await context.newPage() });
    } finally {
        await context.close();
    }
}

describe('lookupProfile (full flow, synthetic pages)', () => {
    const base = { username: 'NASA', sourceInput: 'NASA', maxRecentPosts: 5 };

    it('returns a found profile (exact followers, bio, category, emails, unwrapped links) and the visible post', async () => {
        const body = fbPage({
            ogDescription: 'NASA. 28,729,285 followers · 1 talking about this.',
            links: ['https://www.nasa.gov/nasa-app', 'https://www.nasa.gov/'],
            posts: [fbPost()],
        });
        const { profile, posts } = await withContext([{ match: PAGE_URL, body }], ({ page }) =>
            lookupProfile({ page, ...base }),
        );
        expect(profile).toMatchObject({
            recordType: 'profile',
            platform: 'facebook',
            status: 'found',
            statusDetail: 'Category: Government organization',
            displayName: 'NASA - National Aeronautics and Space Administration',
            bio: 'Explore the universe and discover our home planet.',
            followerCount: 28_729_285,
            followingCount: 52,
            verified: true,
            externalLinks: ['https://www.nasa.gov/nasa-app', 'https://www.nasa.gov/'],
            contactEmails: ['public-inquiries@hq.nasa.gov'],
            postCount: null,
            totalLikes: null,
        });
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({
            recordType: 'post',
            postUrl: 'https://www.facebook.com/reel/28263630716612782/',
            caption: 'What happens when we detect an asteroid that could pose a threat to Earth?',
            likeCount: 1700,
            publishDate: null,
            commentCount: null,
            shareCount: null,
            followerCount: 28_729_285,
        });
        expect(posts[0].statusDetail).toMatch(/relative time.*no exact date/i);
        expect(posts[0].statusDetail).toMatch(/truncated/);
    }, 60_000);

    it('maxRecentPosts = 0 returns the profile only', async () => {
        const { posts } = await withContext([{ match: PAGE_URL, body: fbPage({ posts: [fbPost()] }) }], ({ page }) =>
            lookupProfile({ page, ...base, maxRecentPosts: 0 }),
        );
        expect(posts).toEqual([]);
    });

    it('HTTP 404 -> not_found', async () => {
        const { profile } = await withContext(
            [{ match: PAGE_URL, status: 404, body: '<html>nope</html>' }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile).toMatchObject({ status: 'not_found', statusDetail: 'HTTP 404', followerCount: null });
    });

    it('visible "This content isn\'t available" -> not_found', async () => {
        const { profile } = await withContext(
            [{ match: PAGE_URL, body: "<html><body>This content isn't available right now</body></html>" }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile.status).toBe('not_found');
    });

    it('that phrase inside a script bundle does NOT make a healthy Page not_found (regression)', async () => {
        const body = fbPage().replace('</body>', `<script>var s = "This content isn't available";</script></body>`);
        const { profile } = await withContext([{ match: PAGE_URL, body }], ({ page }) =>
            lookupProfile({ page, ...base }),
        );
        expect(profile.status).toBe('found');
    });

    it('a login wall is reported as blocked, not not_found', async () => {
        const { profile } = await withContext(
            [{ match: PAGE_URL, body: '<html><body><form><input name="pass">Log in</form></body></html>' }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile.status).toBe('blocked');
        expect(profile.statusDetail).toMatch(/login wall/i);
    });

    it('a personal profile / unrecognised layout is not_found with an explanatory detail, not guessed data', async () => {
        const { profile } = await withContext(
            [{ match: PAGE_URL, body: fbPage({ personalProfile: true }) }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile).toMatchObject({ status: 'not_found', followerCount: null, displayName: null });
        expect(profile.statusDetail).toMatch(/personal profile|layout/i);
    });

    it('a visible rate-limit page throws RateLimitError', async () => {
        await expect(
            withContext(
                [{ match: PAGE_URL, body: "<html><body>You've been temporarily blocked</body></html>" }],
                ({ page }) => lookupProfile({ page, ...base }),
            ),
        ).rejects.toBeInstanceOf(RateLimitError);
    });
});

describe('fetchComments (full flow, synthetic pages)', () => {
    const POST = 'https://www.facebook.com/reel/1/';
    const html = fbPage({
        posts: [
            fbPost({
                comments: [
                    fbComment({ author: 'Marc Chervin', text: 'Top level', ago: '20h', likes: '3' }),
                    fbComment({ author: 'Jay Ford', text: 'A reply', ago: '9h', reply: true, to: 'Marc Chervin' }),
                ],
            }),
        ],
    });
    const opts = { postUrl: POST, sourceInput: 'nasa', maxComments: 10, topLevelOnly: false };

    it('returns comment rows with honest limits noted (relative time only) and the commenter handle', async () => {
        const rows = await withContext([{ match: /facebook\.com\/reel\/1\/$/, body: html }], ({ page }) =>
            fetchComments({ page, ...opts }),
        );
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            recordType: 'comment',
            platform: 'facebook',
            postUrl: POST,
            commenterUsername: 'marc.chervin',
            commenterDisplayName: 'Marc Chervin',
            commenterProfileUrl: 'https://www.facebook.com/marc.chervin',
            commentText: 'Top level',
            likeCount: 3,
            commentDate: null,
            isReply: false,
        });
        expect(rows[0].statusDetail).toMatch(/relative time.*no exact date/i);
        expect(rows[1].isReply).toBe(true);
    }, 60_000);

    it('topLevelOnly drops replies', async () => {
        const rows = await withContext([{ match: /facebook\.com\/reel\/1\/$/, body: html }], ({ page }) =>
            fetchComments({ page, ...opts, topLevelOnly: true }),
        );
        expect(rows.map((r) => r.commenterDisplayName)).toEqual(['Marc Chervin']);
    });

    it('respects maxComments and returns [] when no comments are visible', async () => {
        const one = await withContext([{ match: /facebook\.com\/reel\/1\/$/, body: html }], ({ page }) =>
            fetchComments({ page, ...opts, maxComments: 1 }),
        );
        expect(one).toHaveLength(1);
        const none = await withContext(
            [{ match: /facebook\.com\/reel\/1\/$/, body: fbPage({ posts: [fbPost()] }) }],
            ({ page }) => fetchComments({ page, ...opts }),
        );
        expect(none).toEqual([]);
    });

    it('a rate-limit page throws RateLimitError', async () => {
        await expect(
            withContext(
                [{ match: /facebook\.com\/reel\/1\/$/, body: '<html><body>Please try again later</body></html>' }],
                ({ page }) => fetchComments({ page, ...opts }),
            ),
        ).rejects.toBeInstanceOf(RateLimitError);
    });
});

describe('unimplemented modes', () => {
    it('searchPosts throws rather than returning empty results', async () => {
        await expect(searchPosts()).rejects.toThrow(/needs a logged-in session/i);
    });
});

describe('parseFacebookOgTitle', () => {
    it('reads views, reactions and the full caption from a reel og:title', () => {
        expect(
            parseFacebookOgTitle(
                '193K views · 1.7K reactions | What happens when we detect an asteroid?\n\nFull text | https://go.nasa.gov/x | NASA - National Aeronautics and Space Administration',
            ),
        ).toEqual({
            viewCount: 193_000,
            reactions: 1700,
            caption: 'What happens when we detect an asteroid?\n\nFull text | https://go.nasa.gov/x',
        });
    });

    it('views are optional', () => {
        expect(parseFacebookOgTitle('12 reactions | Hello | A Page')).toEqual({
            viewCount: null,
            reactions: 12,
            caption: 'Hello',
        });
    });

    it.each([[null], [''], ['A Page - some caption'], ['NASA']])('%j -> all null (never guessed)', (t) => {
        expect(parseFacebookOgTitle(t)).toEqual({ viewCount: null, reactions: null, caption: null });
    });
});

describe('real-layout regressions (synthetic content, real shape)', () => {
    it('finds the bio even when a wrapper <div> sits between the bio <span> and the list', async () => {
        const dom = await evaluate(fbPage(), domExtractProfile);
        expect(dom.bio).toBe('Explore the universe and discover our home planet.');
        expect(dom.category).toBe('Government organization');
    });

    it('an event / "plans to go live" card is not returned as a post', async () => {
        const posts = await evaluate(fbPage({ posts: [fbEventCard(), fbPost()] }), domExtractPosts, 5);
        expect(posts).toHaveLength(1);
        expect(posts[0].postUrl).toBe('https://www.facebook.com/reel/28263630716612782/');
    });

    it('a page whose only article is an event card yields no posts', async () => {
        expect(await evaluate(fbPage({ posts: [fbEventCard()] }), domExtractPosts, 5)).toEqual([]);
    });

    it('comments can be scoped to one post via its path', async () => {
        const html = fbPage({
            posts: [
                fbPost({
                    url: 'https://www.facebook.com/reel/111/',
                    comments: [fbComment({ author: 'Only One', text: 'first post comment' })],
                }),
                fbPost({
                    url: 'https://www.facebook.com/reel/222/',
                    comments: [fbComment({ author: 'Other Two', text: 'second post comment' })],
                }),
            ],
        });
        const rows = await evaluate(html, domExtractComments, { maxComments: 10, postPathHint: '/reel/222' });
        expect(rows.map((r) => r.author)).toEqual(['Other Two']);
    });
});

describe('post-page enrichment and comment fallback (full flow)', () => {
    const base = { username: 'NASA', sourceInput: 'NASA', maxRecentPosts: 3 };
    const reel = /facebook\.com\/reel\/28263630716612782\/?$/;

    it('uses the post page og:title for the full caption, views and reactions', async () => {
        const ogTitle = '193K views · 1.7K reactions | The full untruncated caption. | NASA';
        const routes = [
            { match: /facebook\.com\/NASA$/, body: fbPage({ posts: [fbPost()] }) },
            {
                match: reel,
                body: `<html><head><meta property="og:title" content="${ogTitle}"></head><body>x</body></html>`,
            },
        ];
        const { posts } = await withContext(routes, ({ page }) => lookupProfile({ page, ...base }));
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({
            caption: 'The full untruncated caption.',
            viewCount: 193_000,
            likeCount: 1700,
        });
        expect(posts[0].statusDetail).not.toMatch(/truncated/);
    }, 60_000);

    it('falls back to the Page profile for comments when the post page shows none', async () => {
        const routes = [
            { match: reel, body: '<html><body>no comments here</body></html>' },
            {
                match: /facebook\.com\/NASA$/,
                body: fbPage({
                    posts: [
                        fbPost({
                            comments: [
                                fbComment({
                                    author: 'Marc Chervin',
                                    text: 'Seen on the profile',
                                    ago: '20h',
                                    likes: '3',
                                }),
                            ],
                        }),
                    ],
                }),
            },
        ];
        const rows = await withContext(routes, ({ page }) =>
            fetchComments({
                page,
                postUrl: 'https://www.facebook.com/reel/28263630716612782/',
                sourceInput: 'NASA',
                maxComments: 5,
                topLevelOnly: true,
            }),
        );
        expect(rows.map((r) => [r.commenterDisplayName, r.commentText])).toEqual([
            ['Marc Chervin', 'Seen on the profile'],
        ]);
    }, 60_000);

    it('does not try the Page profile when the source is a URL (Mode C with post URLs)', async () => {
        const seen = [];
        const context = await browser.newContext();
        await context.route('**/*', (route) => {
            seen.push(route.request().url());
            return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>none</body></html>' });
        });
        const page = await context.newPage();
        const rows = await fetchComments({
            page,
            postUrl: 'https://www.facebook.com/reel/1/',
            sourceInput: 'https://www.facebook.com/reel/1/',
            maxComments: 5,
            topLevelOnly: true,
        });
        await context.close();
        expect(rows).toEqual([]);
        expect(seen.some((u) => /facebook\.com\/NASA/.test(u))).toBe(false);
    }, 60_000);
});

// Text shaped like a real logged-out post page (captured 2026-09-29); wording is paraphrased.
const POST_PAGE_TEXT = `Log In
Forgot Account?
Some Page's Post
Some Page
 
8 hours ago
8h
 
·
The full caption, first paragraph. It is long and complete.
Second line of the caption: https://example.org/x
All reactions:
1.1K
22 comments
60 shares
Like
Comment
Most relevant
Kenneth Lindsey
Nice one
7h`;

describe('parseFacebookPostPageText', () => {
    it('reads the full caption, reactions and the labelled comment/share counts', () => {
        expect(parseFacebookPostPageText(POST_PAGE_TEXT)).toEqual({
            caption:
                'The full caption, first paragraph. It is long and complete.\nSecond line of the caption: https://example.org/x',
            reactions: 1100,
            commentCount: 22,
            shareCount: 60,
        });
    });

    it('a post with no caption has a null caption (nothing between the dot and "All reactions:")', () => {
        const text = 'Some Page\n \n4 hours ago\n4h\n \n·\n \nAll reactions:\n291K\n10.1K\n2.8K\nLike\nComment';
        expect(parseFacebookPostPageText(text)).toEqual({
            caption: null,
            reactions: 291_000,
            commentCount: null,
            shareCount: null,
        });
    });

    it('unlabelled numbers are NOT taken as comment/share counts', () => {
        const r = parseFacebookPostPageText('x\n·\ncap\nAll reactions:\n1.8K\n92\n159\nLike');
        expect(r.commentCount).toBeNull();
        expect(r.shareCount).toBeNull();
    });

    it.each([[null], [''], ['no reactions label here']])('%j -> all null', (t) => {
        expect(parseFacebookPostPageText(t)).toEqual({
            caption: null,
            reactions: null,
            commentCount: null,
            shareCount: null,
        });
    });
});

describe('comment badges and post-page enrichment', () => {
    it('a leading "Author" badge is not taken as the commenter name', async () => {
        const html = fbPage({
            posts: [
                fbPost({
                    comments: [
                        fbComment({
                            author: "NASA's Kennedy Space Center",
                            text: 'Learn more: https://go.nasa.gov/x',
                            badge: 'Author',
                        }),
                    ],
                }),
            ],
        });
        const [c] = await evaluate(html, domExtractComments, { maxComments: 5 });
        expect(c.author).toBe("NASA's Kennedy Space Center");
        expect(c.text).toBe('Learn more: https://go.nasa.gov/x');
    });

    it('a regular (non-reel) post uses the post page for the full caption and labelled counts', async () => {
        const postUrl = 'https://www.facebook.com/natgeo/posts/pfbid0ABC';
        const routes = [
            {
                match: /facebook\.com\/NASA$/,
                body: fbPage({
                    posts: [fbPost({ url: postUrl, caption: 'Truncated card text here', truncated: true })],
                }),
            },
            {
                match: /posts\/pfbid0ABC$/,
                body: `<html><head><meta property="og:title" content="National Geographic"></head><body><pre>${POST_PAGE_TEXT}</pre></body></html>`,
            },
        ];
        const { posts } = await withContext(routes, ({ page }) =>
            lookupProfile({ page, username: 'NASA', sourceInput: 'NASA', maxRecentPosts: 3 }),
        );
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({
            caption:
                'The full caption, first paragraph. It is long and complete.\nSecond line of the caption: https://example.org/x',
            likeCount: 1100,
            commentCount: 22,
            shareCount: 60,
        });
        expect(posts[0].statusDetail).toMatch(/comment\/share counts are from the post page/);
        expect(posts[0].statusDetail).not.toMatch(/caption is truncated/);
    }, 60_000);
});

describe('robustness (regression: build 0.0.20 threw on every Page)', () => {
    it('a non-HTML element (svg) before the intro list does not throw; the bio is simply null', async () => {
        const html = fbPage({ bio: '' }).replace('<div><ul>', '<svg width="1" height="1"></svg><div><ul>');
        const dom = await evaluate(html, domExtractProfile);
        expect(dom).toMatchObject({
            pageName: 'NASA - National Aeronautics and Space Administration',
            bio: null,
            category: 'Government organization',
        });
    });

    it('a <style> element before the list does not throw either', async () => {
        const html = fbPage({ bio: '' }).replace('<div><ul>', '<style>.x{}</style><div><ul>');
        expect((await evaluate(html, domExtractProfile)).bio).toBeNull();
    });
});

describe('parseFacebookProfileHref', () => {
    it.each([
        [
            'https://www.facebook.com/marc.chervin?comment_id=1&__cft__[0]=x',
            'marc.chervin',
            'https://www.facebook.com/marc.chervin',
        ],
        ['https://web.facebook.com/jay.ford/?comment_id=2', 'jay.ford', 'https://www.facebook.com/jay.ford'],
        ['/some.one?comment_id=3', 'some.one', 'https://www.facebook.com/some.one'],
        [
            'https://www.facebook.com/profile.php?id=1000123&comment_id=4',
            null,
            'https://www.facebook.com/profile.php?id=1000123',
        ],
        ['https://www.facebook.com/people/Jane-Doe/1000999/', null, null],
        ['https://www.facebook.com/reel/123/?comment_id=1', null, null],
        ['https://example.com/x', null, null],
        [null, null, null],
        ['::not a url::', null, null],
    ])('%s', (href, username, profileUrl) => {
        expect(parseFacebookProfileHref(href)).toEqual({ username, profileUrl });
    });
});

describe('accounts tagged in a Facebook post (used by expand mode)', () => {
    const tagged = [
        'https://www.facebook.com/NASA?__cft__[0]=x', // the Page itself
        'https://www.facebook.com/some.creator?__cft__[0]=x&__tn__=-]K-R',
        'https://www.facebook.com/Another.Page/?ref=nf',
        'https://www.facebook.com/profile.php?id=1000123', // numeric id only: no handle
        'https://www.facebook.com/hashtag/space',
        'https://www.facebook.com/some.creator', // duplicate
    ];

    it('domExtractPosts returns the cleaned hrefs linked from the post (own post link excluded)', async () => {
        const html = fbPage({ posts: [fbPost({ tagged })] });
        const posts = await evaluate(html, domExtractPosts, 5);
        expect(posts[0].mentionedHrefs).toEqual(
            expect.arrayContaining([
                'https://www.facebook.com/some.creator',
                'https://www.facebook.com/Another.Page/',
                'https://www.facebook.com/profile.php',
            ]),
        );
        expect(posts[0].mentionedHrefs).not.toContain(posts[0].postUrl);
    });

    it('lookupProfile turns them into mentionedAccounts: lower-case handles, without the Page itself, hashtags, ids or duplicates', async () => {
        const body = fbPage({ posts: [fbPost({ tagged })] });
        const { posts } = await withContext([{ match: PAGE_URL, body }], ({ page }) =>
            lookupProfile({ page, username: 'NASA', sourceInput: 'NASA', maxRecentPosts: 5 }),
        );
        expect(posts[0].mentionedAccounts).toEqual(['some.creator', 'another.page']);
    }, 60_000);

    it('a post that tags nobody has an empty list', async () => {
        const body = fbPage({ posts: [fbPost()] });
        const { posts } = await withContext([{ match: PAGE_URL, body }], ({ page }) =>
            lookupProfile({ page, username: 'NASA', sourceInput: 'NASA', maxRecentPosts: 5 }),
        );
        expect(posts[0].mentionedAccounts).toEqual([]);
    }, 60_000);
});

// ---- the Page plugin (public embed of the timeline): structure captured live 2026-10-01 from a large Page ----
const pluginPost = ({ utime, href, text, like, comment, share, seeMore = false }) => `
  <div><div><div><a target="_blank" class="_39g5" href="${href}?ref=embed_page"><abbr data-utime="${utime}" data-tooltip-content="x" class="timestamp"><span class="timestampContent">3 hours ago</span></abbr></a></div></div>
    <div data-testid="post_message" class="_5pbx userContent"><div class="text_exposed_root">${text
        .split('\n')
        .map((l) => `<p>${l}</p>`)
        .join('')}${seeMore ? '<span>...</span><span>See more</span>' : ''}</div></div>
    <table class="uiGrid"><tbody><tr>
      <td><span role="button" class="embeddedLikeButton"><div title="Like"><i></i><i></i>${like ?? ''}</div></span></td>
      <td><a href="${href}?ref=embed_page"><div title="Comment"><i></i><i></i>${comment ?? ''}</div></a></td>
      <td><a href="/sharer/sharer.php?u=x"><div title="Share"><i></i><i></i>${share ?? ''}</div></a></td>
    </tr></tbody></table></div>`;
const pluginPage = (posts) =>
    `<html><body><div><div><a title="Dave Ramsey" href="https://www.facebook.com/3059?ref=embed_page">Dave Ramsey</a><div>9,011,580 followers</div></div>
     <div><div role="feed">${posts.join('')}</div></div></div></body></html>`;

describe('domExtractPluginPosts (Page plugin)', () => {
    const posts = [
        pluginPost({
            utime: 1790797828,
            href: 'https://www.facebook.com/daveramsey/posts/pfbid0AAA',
            text: 'How much house can you really afford?\nFree tools to run the numbers.',
            like: '151',
            comment: '21',
            share: '16',
            seeMore: true,
        }),
        pluginPost({
            utime: 1790779676,
            href: 'https://www.facebook.com/reel/1592634102348550/',
            text: 'Lisa called in to the show. #ad',
            like: '4.9K',
            comment: '912',
            share: '129',
        }),
        pluginPost({
            utime: 1790500000,
            href: 'https://www.facebook.com/daveramsey/posts/pfbid0CCC',
            text: 'No counts shown',
        }),
    ];

    it('reads exact time, text, reactions, comments and shares of each post', async () => {
        const out = await evaluate(pluginPage(posts), domExtractPluginPosts, 10);
        expect(out).toHaveLength(3);
        expect(out[0]).toEqual({
            postUrl: 'https://www.facebook.com/daveramsey/posts/pfbid0AAA',
            publishDate: '2026-09-30T19:50:28.000Z',
            caption: 'How much house can you really afford? Free tools to run the numbers.',
            captionTruncated: true,
            reactions: 151,
            commentCount: 21,
            shareCount: 16,
        });
        expect(out[1]).toMatchObject({
            postUrl: 'https://www.facebook.com/reel/1592634102348550/',
            reactions: 4900,
            commentCount: 912,
            shareCount: 129,
        });
    });

    it('a count that is not shown is null (never 0), and maxPosts limits the list', async () => {
        const out = await evaluate(pluginPage(posts), domExtractPluginPosts, 10);
        expect(out[2]).toMatchObject({ reactions: null, commentCount: null, shareCount: null });
        expect(await evaluate(pluginPage(posts), domExtractPluginPosts, 2)).toHaveLength(2);
    });

    it('no feed (plugin not shown for this Page) -> no posts', async () => {
        expect(
            await evaluate(
                '<html><body><div>This content is not available</div></body></html>',
                domExtractPluginPosts,
                5,
            ),
        ).toEqual([]);
    });
});

describe('lookupProfile: posts from the Page plugin', () => {
    const PLUGIN_URL = /facebook\.com\/plugins\/page\.php/;
    const base = { username: 'NASA', sourceInput: 'NASA', maxRecentPosts: 5 };
    const pageBody = fbPage({ ogDescription: 'NASA. 28,729,285 followers', posts: [fbPost()] });
    const plugin = pluginPage([
        pluginPost({
            utime: 1790797828,
            href: 'https://www.facebook.com/nasa/posts/pfbid0X',
            text: 'Launch day #sponsored',
            like: '2K',
            comment: '300',
            share: '50',
        }),
        pluginPost({
            utime: 1790700000,
            href: 'https://www.facebook.com/nasa/posts/pfbid0Y',
            text: 'Second post',
            like: '1.5K',
            comment: '120',
            share: '20',
        }),
    ]);

    it('returns one post row per plugin post, with exact dates and labelled counts (no per-post page loads)', async () => {
        const context = await browser.newContext();
        let posts;
        let seen;
        try {
            seen = await serve(context, [
                { match: PLUGIN_URL, body: plugin },
                { match: PAGE_URL, body: pageBody },
            ]);
            ({ posts } = await lookupProfile({ page: await context.newPage(), ...base }));
        } finally {
            await context.close();
        }
        expect(posts).toHaveLength(2);
        expect(posts[0]).toMatchObject({
            recordType: 'post',
            platform: 'facebook',
            postUrl: 'https://www.facebook.com/nasa/posts/pfbid0X',
            publishDate: '2026-09-30T19:50:28.000Z',
            caption: 'Launch day #sponsored',
            likeCount: 2000,
            commentCount: 300,
            shareCount: 50,
        });
        expect(posts[0].statusDetail).toContain('Page plugin');
        expect(seen.filter((u) => /\/posts\/pfbid|\/reel\//.test(u))).toEqual([]);
    });

    it('falls back to the Page itself when the plugin shows no timeline', async () => {
        const { posts } = await withContext(
            [
                { match: PLUGIN_URL, body: '<html><body>Content not available</body></html>' },
                { match: PAGE_URL, body: pageBody },
            ],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(posts).toHaveLength(1);
        expect(posts[0].publishDate).toBeNull();
    }, 30_000);
});

describe('quickProfile (cheap look through the Page plugin)', () => {
    it('parsePluginHeader reads the Page name and exact follower count', () => {
        expect(parsePluginHeader('Dave Ramsey\n9,011,580 followers\nFollow Page')).toEqual({
            pageName: 'Dave Ramsey',
            followerCount: 9_011_580,
        });
        expect(parsePluginHeader('Small Page\n4.2K followers')).toEqual({
            pageName: 'Small Page',
            followerCount: 4200,
        });
        expect(parsePluginHeader('This content is not available')).toBeNull();
        // a button label before the count is not the Page name
        expect(parsePluginHeader('Follow Page\n281K followers')).toEqual({ pageName: null, followerCount: 281_000 });
    });

    it('returns a found row with the follower count, or null when the plugin does not show the Page', async () => {
        const PLUGIN = /facebook\.com\/plugins\/page\.php/;
        const ok = await withContext(
            [
                {
                    match: PLUGIN,
                    body: '<html><body><div><a>Dave Ramsey</a><div>9,011,580 followers</div></div></body></html>',
                },
            ],
            ({ page }) => quickProfile({ page, username: 'DaveRamsey', sourceInput: 'q' }),
        );
        expect(ok).toMatchObject({
            platform: 'facebook',
            status: 'found',
            username: 'Dave Ramsey',
            followerCount: 9_011_580,
        });
        const none = await withContext(
            [{ match: PLUGIN, body: '<html><body>Page not available</body></html>' }],
            ({ page }) => quickProfile({ page, username: 'nope', sourceInput: 'q' }),
        );
        expect(none).toBeNull();
        // an unreachable plugin is not an error either
        expect(await withContext([], ({ page }) => quickProfile({ page, username: 'x', sourceInput: 'q' }))).toBeNull();
    });
});
