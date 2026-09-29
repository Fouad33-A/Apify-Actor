import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RateLimitError } from '../src/errors.js';
import * as tiktok from '../src/platforms/tiktok.js';
import { launchBrowser, serve } from './helpers/browser.js';

vi.mock('apify', () => ({
    Actor: { setValue: vi.fn(async () => {}) },
    log: { info: vi.fn(), warning: vi.fn(), exception: vi.fn() },
}));

// SYNTHETIC data shaped like the live probe of https://www.tiktok.com/@nasa (2026-09-29):
// an inline <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"> holding __DEFAULT_SCOPE__['webapp.user-detail'].
const detail = (over = {}) => ({
    __DEFAULT_SCOPE__: {
        'webapp.app-context': { language: 'en' },
        'webapp.user-detail': {
            userInfo: {
                user: {
                    uniqueId: 'nasa',
                    nickname: 'NASA',
                    signature: 'Making the seemingly impossible, possible.',
                    verified: true,
                    privateAccount: false,
                    bioLink: { link: 'https://www.nasa.gov' },
                    createTime: 1_500_000_000,
                    ...over.user,
                },
                stats: {
                    followerCount: 1_912_345,
                    followingCount: 23,
                    heartCount: 9_876_543,
                    videoCount: 250,
                    ...over.stats,
                },
            },
            statusCode: 0,
        },
    },
});

const page = ({ json, visible = 'NASA nasa 23 1.9M 9.8M', extraScript = '' } = {}) =>
    `<!doctype html><html><head><title>TikTok - Make Your Day</title></head><body>${visible}
    ${json === undefined ? '' : `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(json)}</script>`}
    ${extraScript}</body></html>`;

describe('normalizeTiktokUsername', () => {
    it.each([
        ['nasa', 'nasa'],
        ['@nasa', 'nasa'],
        ['https://www.tiktok.com/@nasa', 'nasa'],
        ['https://www.tiktok.com/@nasa?lang=en', 'nasa'],
        ['  nasa  ', 'nasa'],
    ])('%s -> %s', (input, expected) => {
        expect(tiktok.normalizeTiktokUsername(input)).toBe(expected);
    });
});

describe('parseUserDetail (pure)', () => {
    it('extracts profile facts with exact counts', () => {
        expect(tiktok.parseUserDetail(detail())).toEqual({
            state: 'ok',
            username: 'nasa',
            displayName: 'NASA',
            bio: 'Making the seemingly impossible, possible.',
            verified: true,
            externalLinks: ['https://www.nasa.gov'],
            followerCount: 1_912_345,
            followingCount: 23,
            postCount: 250,
            totalLikes: 9_876_543,
            accountCreatedDate: new Date(1_500_000_000 * 1000).toISOString(),
        });
    });

    it('missing fields stay null / empty, never guessed', () => {
        const r = tiktok.parseUserDetail({
            __DEFAULT_SCOPE__: { 'webapp.user-detail': { userInfo: { user: { uniqueId: 'x' }, stats: {} } } },
        });
        expect(r).toMatchObject({
            state: 'ok',
            displayName: null,
            bio: null,
            verified: null,
            externalLinks: [],
            followerCount: null,
            totalLikes: null,
            accountCreatedDate: null,
        });
    });

    it('an empty bio is null', () => {
        expect(tiktok.parseUserDetail(detail({ user: { signature: '' } })).bio).toBeNull();
    });

    it('flags a private account', () => {
        expect(tiktok.parseUserDetail(detail({ user: { privateAccount: true } })).state).toBe('private');
    });

    it('statusCode 10221 with no user is not_found', () => {
        const r = tiktok.parseUserDetail({ __DEFAULT_SCOPE__: { 'webapp.user-detail': { statusCode: 10221 } } });
        expect(r.state).toBe('not_found');
    });

    it.each([[null], [{}], [{ __DEFAULT_SCOPE__: {} }]])('unrecognised structure %j', (root) => {
        expect(tiktok.parseUserDetail(root).state).toBe('unrecognised');
    });

    it('a user-less detail with another status code is unrecognised, not not_found', () => {
        const r = tiktok.parseUserDetail({ __DEFAULT_SCOPE__: { 'webapp.user-detail': { statusCode: 10000 } } });
        expect(r).toEqual({ state: 'unrecognised', statusCode: 10000 });
    });
});

describe('lookupProfile (full flow, synthetic pages)', () => {
    let browser;
    beforeAll(async () => {
        browser = await launchBrowser();
    });
    afterAll(async () => {
        await browser?.close();
    });

    async function run(routes, username = 'nasa') {
        const context = await browser.newContext();
        try {
            await serve(context, routes);
            return await tiktok.lookupProfile({ page: await context.newPage(), username, sourceInput: username });
        } finally {
            await context.close();
        }
    }
    const URL_RE = /tiktok\.com\/@nasa$/;

    it('returns a found profile from the embedded data, with no posts (not built)', async () => {
        const { profile, posts } = await run([{ match: URL_RE, body: page({ json: detail() }) }]);
        expect(profile).toMatchObject({
            recordType: 'profile',
            platform: 'tiktok',
            status: 'found',
            username: 'nasa',
            displayName: 'NASA',
            followerCount: 1_912_345,
            followingCount: 23,
            postCount: 250,
            totalLikes: 9_876_543,
            verified: true,
            externalLinks: ['https://www.nasa.gov'],
        });
        expect(posts).toEqual([]);
    }, 60_000);

    it('accepts an @handle or profile URL as the username', async () => {
        const { profile } = await run([{ match: URL_RE, body: page({ json: detail() }) }], '@nasa');
        expect(profile.status).toBe('found');
    });

    it('does NOT treat "captcha" inside script text as a rate limit (regression: TikTok ships it in a manifest)', async () => {
        const body = page({
            json: detail(),
            extraScript: '<script>var m = {"chunks":["captcha-ttp.js","captcha-sg.js"]};</script>',
        });
        const { profile } = await run([{ match: URL_RE, body }]);
        expect(profile.status).toBe('found');
    }, 60_000);

    it('a visible captcha challenge DOES throw RateLimitError', async () => {
        const body = page({ json: undefined, visible: 'Verify to continue: drag the slider' });
        await expect(run([{ match: URL_RE, body }])).rejects.toBeInstanceOf(RateLimitError);
    });

    it('HTTP 404 is not_found', async () => {
        const { profile } = await run([{ match: URL_RE, status: 404, body: '<html><body>nope</body></html>' }]);
        expect(profile.status).toBe('not_found');
    });

    it('missing embedded data is reported as blocked with a diagnostic pointer, not not_found', async () => {
        const { profile } = await run([
            { match: URL_RE, body: page({ json: undefined, visible: 'Something went wrong' }) },
        ]);
        expect(profile).toMatchObject({ status: 'blocked', followerCount: null, displayName: null });
        expect(profile.statusDetail).toMatch(/DIAG_profile/);
    });

    it('malformed embedded JSON is treated as unrecognised (blocked), not a crash', async () => {
        const body = `<html><body>x<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{not json</script></body></html>`;
        const { profile } = await run([{ match: URL_RE, body }]);
        expect(profile.status).toBe('blocked');
    });

    it('private accounts return only public header facts with a private status', async () => {
        const { profile } = await run([
            { match: URL_RE, body: page({ json: detail({ user: { privateAccount: true } }) }) },
        ]);
        expect(profile.status).toBe('private');
        expect(profile.statusDetail).toMatch(/private/i);
    });
});

describe('unimplemented modes', () => {
    it.each(['searchPosts', 'fetchComments'])('%s throws rather than returning empty data', async (fn) => {
        await expect(tiktok[fn]({})).rejects.toThrow(/not yet implemented/i);
    });
});
