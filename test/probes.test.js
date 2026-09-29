import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_PROBES, runProbes, sanitizeHeaders, validateProbe } from '../src/probes.js';
import { launchBrowser, serve } from './helpers/browser.js';

describe('validateProbe', () => {
    it('accepts https URLs on instagram, facebook and tiktok (incl. subdomains)', () => {
        for (const url of [
            'https://www.instagram.com/nasa/',
            'https://m.facebook.com/NASA',
            'https://www.tiktok.com/@nasa',
        ]) {
            expect(validateProbe({ url }).ok).toBe(true);
        }
    });

    it.each([
        ['http://www.instagram.com/nasa/', /https/],
        ['https://example.com/', /host not allowed/],
        ['https://instagram.com.evil.test/', /host not allowed/],
        ['https://evilinstagram.com/', /host not allowed/],
        ['not a url', /invalid/],
    ])('rejects %s', (url, reason) => {
        const r = validateProbe({ url });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(reason);
    });

    it('rejects unknown probe types', () => {
        expect(validateProbe({ url: 'https://www.tiktok.com/@a', type: 'post' }).ok).toBe(false);
    });
});

describe('sanitizeHeaders', () => {
    it('keeps only allow-listed headers, lower-cased', () => {
        expect(sanitizeHeaders({ 'X-IG-App-ID': '123', Cookie: 'secret=1', Authorization: 'Bearer x' })).toEqual({
            'x-ig-app-id': '123',
        });
    });
});

describe('runProbes (synthetic responses, no network)', () => {
    let browser;
    beforeAll(async () => {
        browser = await launchBrowser();
    });
    afterAll(async () => {
        await browser?.close();
    });

    async function withContext(routes, fn) {
        const context = await browser.newContext();
        try {
            await serve(context, routes);
            return await fn(context);
        } finally {
            await context.close();
        }
    }

    it('page probe reports status, final URL, title, text and embedded JSON', async () => {
        const body = `<html><head><title>NASA on TikTok</title><meta property="og:title" content="NASA"></head><body>
            hello world<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{"userInfo":{"stats":{"followerCount":5}}}</script></body></html>`;
        const [r] = await withContext([{ match: /tiktok\.com\/@nasa$/, body }], (ctx) =>
            runProbes({ context: ctx, probes: [{ url: 'https://www.tiktok.com/@nasa', waitMs: 10 }] }),
        );
        expect(r).toMatchObject({ httpStatus: 200, title: 'NASA on TikTok', ogTitle: 'NASA' });
        expect(r.bodyText).toContain('hello world');
        expect(r.jsonScripts[0].id).toBe('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        expect(r.jsonScripts[0].head).toContain('followerCount');
    });

    it('fetch probe returns status, content type and a truncated body', async () => {
        const routes = [
            { match: /instagram\.com\/$/, body: '<html><body>home</body></html>' },
            {
                match: /\/api\/v1\/users\/web_profile_info/,
                contentType: 'application/json',
                status: 401,
                body: JSON.stringify({ message: 'login_required', pad: 'x'.repeat(10_000) }),
            },
        ];
        const [r] = await withContext(routes, (ctx) =>
            runProbes({
                context: ctx,
                probes: [
                    {
                        url: 'https://www.instagram.com/api/v1/users/web_profile_info/?username=nasa',
                        type: 'fetch',
                        headers: { 'x-ig-app-id': '1' },
                    },
                ],
            }),
        );
        expect(r).toMatchObject({ type: 'fetch', httpStatus: 401, contentType: 'application/json' });
        expect(r.bodyHead).toContain('login_required');
        expect(r.bodyHead.length).toBeLessThanOrEqual(6000);
        expect(r.bodyLength).toBeGreaterThan(10_000);
    });

    it('reports a login redirect as it is (final URL), without following any further', async () => {
        const [r] = await withContext(
            [
                {
                    match: /instagram\.com\/nasa\/$/,
                    body: '<html><head><title>Instagram</title></head><body>Log into Instagram</body></html>',
                },
            ],
            (ctx) => runProbes({ context: ctx, probes: [{ url: 'https://www.instagram.com/nasa/', waitMs: 10 }] }),
        );
        expect(r.bodyText).toContain('Log into Instagram');
    });

    it('records a disallowed host as an error and never requests it', async () => {
        const context = await browser.newContext();
        const seen = await serve(context, []);
        const results = await runProbes({ context, probes: [{ url: 'https://example.com/' }] });
        await context.close();
        expect(results[0].error).toMatch(/host not allowed/);
        expect(seen).toEqual([]);
    });

    it('a failing navigation is captured per probe and does not stop the others', async () => {
        const routes = [{ match: /tiktok\.com\/@ok$/, body: '<html><title>ok</title></html>' }];
        const results = await withContext(routes, (ctx) =>
            runProbes({
                context: ctx,
                probes: [
                    { url: 'https://www.tiktok.com/@blocked', waitMs: 10 },
                    { url: 'https://www.tiktok.com/@ok', waitMs: 10 },
                ],
            }),
        );
        expect(results[0].error).toBeTruthy();
        expect(results[1].title).toBe('ok');
    });

    it(`caps the run at ${MAX_PROBES} probes`, async () => {
        const probes = Array.from({ length: MAX_PROBES + 5 }, () => ({ url: 'https://example.com/' }));
        const context = await browser.newContext();
        const results = await runProbes({ context, probes });
        await context.close();
        expect(results).toHaveLength(MAX_PROBES);
    });
});
