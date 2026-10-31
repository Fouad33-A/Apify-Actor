import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { captureJson } from '../src/capture.js';
import { describeCapture, runProbes } from '../src/probes.js';
import { launchBrowser, serve } from './helpers/browser.js';

const PAGE = `<html><body><p>hi</p><script>
setTimeout(() => fetch('/api/post/item_list/?cursor=0').then((r) => r.json()), 100);
setTimeout(() => fetch('/api/other/thing').then((r) => r.text()), 120);
</script></body></html>`;
const ROUTES = [
    {
        match: /\/api\/post\/item_list/,
        contentType: 'application/json',
        body: JSON.stringify({ itemList: [{ id: '1' }], hasMore: false }),
    },
    { match: /\/api\/other/, contentType: 'text/plain', body: 'nope' },
    { match: /tiktok\.com\/@nasa$/, body: PAGE },
];

describe('captureJson / probe captureUrls (synthetic, no network)', () => {
    let browser;
    beforeAll(async () => {
        browser = await launchBrowser();
    });
    afterAll(async () => {
        await browser?.close();
    });

    it('captures only the matching JSON responses and lets a caller wait for one', async () => {
        const ctx = await browser.newContext();
        await serve(ctx, ROUTES);
        const page = await ctx.newPage();
        const cap = captureJson(page, ['/api/post/item_list']);
        await page.goto('https://www.tiktok.com/@nasa');
        const hit = await cap.waitFor((h) => Array.isArray(h.data?.itemList), 5000);
        cap.stop();
        await ctx.close();
        expect(hit.data.itemList).toEqual([{ id: '1' }]);
        expect(cap.hits).toHaveLength(1);
    });

    it('waitFor resolves null on timeout instead of hanging', async () => {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const cap = captureJson(page, ['/nothing']);
        expect(await cap.waitFor(() => true, 100)).toBeNull();
        cap.stop();
        await ctx.close();
    });

    it('records a non-JSON body as a hit with data null', async () => {
        const ctx = await browser.newContext();
        await serve(ctx, ROUTES);
        const page = await ctx.newPage();
        const cap = captureJson(page, ['/api/other']);
        await page.goto('https://www.tiktok.com/@nasa');
        await cap.waitFor(() => true, 5000);
        cap.stop();
        await ctx.close();
        expect(cap.hits[0].data).toBeNull();
    });

    it("a probe with captureUrls reports the page's own JSON call", async () => {
        const ctx = await browser.newContext();
        await serve(ctx, ROUTES);
        const [r] = await runProbes({
            context: ctx,
            probes: [{ url: 'https://www.tiktok.com/@nasa', waitMs: 600, captureUrls: ['/api/post/item_list'] }],
        });
        await ctx.close();
        expect(r.captured).toHaveLength(1);
        expect(r.captured[0]).toMatchObject({ status: 200, keys: ['itemList', 'hasMore'] });
        expect(r.captured[0].head).toContain('"itemList"');
    });

    it('describeCapture truncates the head and tolerates null data', () => {
        expect(describeCapture({ url: 'u', status: 200, data: { a: 'x'.repeat(50) } }, 10).head).toHaveLength(10);
        expect(describeCapture({ url: 'u', status: 200, data: null })).toMatchObject({ keys: null, head: null });
    });
});
