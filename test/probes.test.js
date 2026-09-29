import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractJsonPath, grepText, MAX_PROBES, runProbes, sanitizeHeaders, validateProbe } from '../src/probes.js';
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

describe('grepText', () => {
    it('returns snippets around the first matches and caps hits per term', () => {
        const text = `${'a'.repeat(300)}NEEDLE${'b'.repeat(400)}NEEDLE second NEEDLE third NEEDLE fourth`;
        const r = grepText(text, ['NEEDLE', 'missing']);
        expect(r.NEEDLE).toHaveLength(3);
        expect(r.NEEDLE[0]).toContain('NEEDLE');
        expect(r.NEEDLE[0].length).toBeLessThan(600);
        expect(r.missing).toEqual([]);
    });

    it('caps the number of terms', () => {
        const terms = Array.from({ length: 20 }, (_, i) => `t${i}`);
        expect(Object.keys(grepText('t0 t1', terms))).toHaveLength(8);
    });
});

describe('extractJsonPath', () => {
    const json = JSON.stringify({ a: { 'b.c': { x: 1, y: [1, 2] } } });

    it('walks a path of keys, including keys that contain dots', () => {
        const r = extractJsonPath(json, ['a', 'b.c']);
        expect(r.keys).toEqual(['x', 'y']);
        expect(JSON.parse(r.head)).toEqual({ x: 1, y: [1, 2] });
    });

    it('reports where a path breaks and what keys exist there', () => {
        const r = extractJsonPath(json, ['a', 'nope']);
        expect(r.error).toMatch(/nope/);
        expect(r.keysAtFailure).toEqual(['b.c']);
    });

    it('reports invalid JSON', () => {
        expect(extractJsonPath('{bad', []).error).toMatch(/not valid JSON/);
    });

    it('truncates large values', () => {
        expect(extractJsonPath(JSON.stringify({ big: 'x'.repeat(20_000) }), []).head.length).toBeLessThanOrEqual(6000);
    });
});

describe('probe options: grep / outline / jsonScriptId (synthetic pages)', () => {
    let browser;
    beforeAll(async () => {
        browser = await launchBrowser();
    });
    afterAll(async () => {
        await browser?.close();
    });

    it('page probe returns grep snippets, a DOM outline and an extracted JSON path', async () => {
        const body = `<html><head><title>t</title></head><body><div role="main"><h1>NASA</h1><div><a href="/x/y">link text</a></div></div>
            <script id="DATA" type="application/json">{"scope":{"user-detail":{"stats":{"followerCount":5}}}}</script></body></html>`;
        const context = await browser.newContext();
        await serve(context, [{ match: /tiktok\.com\/@nasa$/, body }]);
        const [r] = await runProbes({
            context,
            probes: [
                {
                    url: 'https://www.tiktok.com/@nasa',
                    waitMs: 10,
                    grep: ['followerCount'],
                    outline: { selector: '[role=main]', maxDepth: 5, maxLines: 20 },
                    jsonScriptId: 'DATA',
                    jsonPath: ['scope', 'user-detail'],
                },
            ],
        });
        await context.close();
        expect(r.grep.followerCount[0]).toContain('followerCount');
        expect(r.outline.join('\n')).toMatch(/role="main"/);
        expect(r.outline.join('\n')).toMatch(/href="\/x\/y"/);
        expect(JSON.parse(r.json.head)).toEqual({ stats: { followerCount: 5 } });
    });

    it('a missing script id is reported, not thrown', async () => {
        const context = await browser.newContext();
        await serve(context, [{ match: /tiktok\.com\/@a$/, body: '<html><body>x</body></html>' }]);
        const [r] = await runProbes({
            context,
            probes: [{ url: 'https://www.tiktok.com/@a', waitMs: 10, jsonScriptId: 'NOPE' }],
        });
        await context.close();
        expect(r.json).toEqual({ error: 'script id not found' });
    });

    it('fetch probe supports grep on the response body', async () => {
        const context = await browser.newContext();
        await serve(context, [
            { match: /instagram\.com\/$/, body: '<html><body>home</body></html>' },
            { match: /\/api\/x$/, contentType: 'application/json', body: '{"needle":"found-me"}' },
        ]);
        const [r] = await runProbes({
            context,
            probes: [{ url: 'https://www.instagram.com/api/x', type: 'fetch', grep: ['found-me'] }],
        });
        await context.close();
        expect(r.grep['found-me'][0]).toContain('found-me');
        expect(r.fullBody).toBeUndefined();
    });
});
