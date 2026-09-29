// Facebook extraction + flow tests. Fixtures are SYNTHETIC content in the REAL structure captured from a
// live Page outline (see helpers/fixtures.js); they do not prove the real site still looks like this.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RateLimitError } from '../src/errors.js';
import {
    domExtractComments,
    domExtractPosts,
    domExtractProfile,
    fetchComments,
    lookupProfile,
    searchPosts,
    unwrapFacebookLink,
} from '../src/platforms/facebook.js';
import { launchBrowser, serve } from './helpers/browser.js';
import { fbComment, fbPage, fbPost } from './helpers/fixtures.js';

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
        const rows = await evaluate(html, domExtractComments, 10);
        expect(rows).toEqual([
            {
                author: 'Marc Chervin',
                text: 'Fortunately NASA has already shown this.',
                isReply: false,
                relativeTime: '20h',
                likeCount: 3,
            },
            {
                author: 'Jay Ford',
                text: 'Marc Chervin When did they catch a meteor?',
                isReply: true,
                relativeTime: '9h',
                likeCount: null,
            },
        ]);
    });

    it('caps the number returned', async () => {
        expect(await evaluate(html, domExtractComments, 1)).toHaveLength(1);
    });

    it('returns [] when the page shows no comments', async () => {
        expect(await evaluate(fbPage({ posts: [fbPost()] }), domExtractComments, 10)).toEqual([]);
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

    it('returns comment rows with honest limits noted (relative time only, display-name commenters)', async () => {
        const rows = await withContext([{ match: /facebook\.com\/reel\/1\/$/, body: html }], ({ page }) =>
            fetchComments({ page, ...opts }),
        );
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            recordType: 'comment',
            platform: 'facebook',
            postUrl: POST,
            commenterUsername: 'Marc Chervin',
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
        expect(rows.map((r) => r.commenterUsername)).toEqual(['Marc Chervin']);
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
        await expect(searchPosts()).rejects.toThrow(/not yet implemented/i);
    });
});
