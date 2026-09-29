// Facebook extraction + flow tests. Fixtures are SYNTHETIC (see helpers/fixtures.js).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RateLimitError } from '../src/errors.js';
import {
    domExtractPosts,
    domExtractProfile,
    fetchComments,
    lookupProfile,
    searchPosts,
} from '../src/platforms/facebook.js';
import { launchBrowser, serve } from './helpers/browser.js';
import { fbPage } from './helpers/fixtures.js';

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
async function evaluate(html, fn) {
    const page = await browser.newPage();
    try {
        await page.setContent(html);
        return await page.evaluate(fn);
    } finally {
        await page.close();
    }
}

describe('domExtractProfile (in-page)', () => {
    it('extracts name, counts, bio, category and verified badge from the intro card', async () => {
        const dom = await evaluate(fbPage(), domExtractProfile);
        expect(dom).toEqual({
            pageName: 'NASA',
            followerCount: 28_000_000,
            followingCount: 52,
            bio: 'Explore the universe and discover our home planet.',
            category: 'Government organization',
            verified: true,
            externalLinks: [],
        });
    });

    it('following is null when the stats line only has followers', async () => {
        const dom = await evaluate(fbPage({ stats: '1.5K followers' }), domExtractProfile);
        expect(dom.followerCount).toBe(1500);
        expect(dom.followingCount).toBeNull();
    });

    it('verified is false (not null) when the badge is absent', async () => {
        const dom = await evaluate(fbPage({ verified: false }), domExtractProfile);
        expect(dom.verified).toBe(false);
    });

    it('bio is null and category is null when the card has neither', async () => {
        const dom = await evaluate(fbPage({ bioLines: [], category: null }), domExtractProfile);
        expect(dom.bio).toBeNull();
        expect(dom.category).toBeNull();
    });

    it('skips action-button words when finding the category and the bio', async () => {
        const dom = await evaluate(
            fbPage({ buttons: ['Sign up', 'Follow', 'Message', 'Search this Page'], bioLines: ['Real bio'] }),
            domExtractProfile,
        );
        expect(dom.category).toBe('Government organization');
        expect(dom.bio).toBe('Real bio');
    });

    it('unwraps l.facebook.com/l.php redirect links to their real targets and de-duplicates', async () => {
        const dom = await evaluate(
            fbPage({ links: ['https://www.nasa.gov/', 'https://www.nasa.gov/', 'https://example.org/a?b=1&c=2'] }),
            domExtractProfile,
        );
        expect(dom.externalLinks).toEqual(['https://www.nasa.gov/', 'https://example.org/a?b=1&c=2']);
    });

    it("returns null for a personal profile ('N friends' instead of followers) rather than guessing", async () => {
        expect(await evaluate(fbPage({ stats: '1,234 friends' }), domExtractProfile)).toBeNull();
    });

    it('returns null when there is no stats line', async () => {
        expect(await evaluate(fbPage({ stats: null }), domExtractProfile)).toBeNull();
    });

    it('returns null when there is no [role=main] region', async () => {
        expect(await evaluate('<html><body><div>hello</div></body></html>', domExtractProfile)).toBeNull();
    });
});

describe('domExtractPosts', () => {
    it('is deliberately empty - post extraction is not built and must never invent posts', async () => {
        expect(await evaluate(fbPage(), domExtractPosts)).toEqual([]);
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
    const base = { username: 'NASA', sourceInput: 'NASA', maxRecentPosts: 10 };

    it('returns a found profile with category in statusDetail and NO posts (never fabricated)', async () => {
        const { profile, posts } = await withContext(
            [{ match: PAGE_URL, body: fbPage({ links: ['https://www.nasa.gov/'] }) }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile).toMatchObject({
            recordType: 'profile',
            platform: 'facebook',
            status: 'found',
            statusDetail: 'Category: Government organization',
            username: 'NASA',
            displayName: 'NASA',
            followerCount: 28_000_000,
            followingCount: 52,
            verified: true,
            externalLinks: ['https://www.nasa.gov/'],
            postCount: null,
            totalLikes: null,
            accountCreatedDate: null,
        });
        expect(posts).toEqual([]);
    }, 60_000);

    it('HTTP 404 -> not_found', async () => {
        const { profile } = await withContext(
            [{ match: PAGE_URL, status: 404, body: '<html>nope</html>' }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile).toMatchObject({ status: 'not_found', statusDetail: 'HTTP 404', followerCount: null });
    });

    it("'This content isn't available' on a 200 -> not_found", async () => {
        const { profile } = await withContext(
            [{ match: PAGE_URL, body: "<html><body>This content isn't available right now</body></html>" }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile.status).toBe('not_found');
    });

    it('a login wall is reported as not_found with a login-wall detail', async () => {
        const { profile } = await withContext(
            [{ match: PAGE_URL, body: '<html><body><form><input name="pass">Log in</form></body></html>' }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile.status).toBe('not_found');
        expect(profile.statusDetail).toMatch(/login wall/i);
    });

    it('a personal profile / unrecognised layout is not_found with an explanatory detail, not guessed data', async () => {
        const { profile } = await withContext(
            [{ match: PAGE_URL, body: fbPage({ stats: '1,234 friends' }) }],
            ({ page }) => lookupProfile({ page, ...base }),
        );
        expect(profile).toMatchObject({ status: 'not_found', followerCount: null, displayName: null });
        expect(profile.statusDetail).toMatch(/personal profile|layout/i);
    });

    it('a rate-limit page throws RateLimitError', async () => {
        await expect(
            withContext(
                [{ match: PAGE_URL, body: "<html><body>You've been temporarily blocked</body></html>" }],
                ({ page }) => lookupProfile({ page, ...base }),
            ),
        ).rejects.toBeInstanceOf(RateLimitError);
    });
});

describe('unimplemented modes', () => {
    it('searchPosts and fetchComments throw rather than return empty results', async () => {
        await expect(searchPosts()).rejects.toThrow(/not yet implemented/i);
        await expect(fetchComments()).rejects.toThrow(/not yet implemented/i);
    });
});
