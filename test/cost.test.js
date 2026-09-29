import http from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BudgetTracker } from '../src/budget.js';
import { computeUnits, CostTracker } from '../src/cost.js';
import { launchBrowser } from './helpers/browser.js';

describe('computeUnits', () => {
    it('is GB x hours', () => {
        expect(computeUnits(1024, 3600)).toBe(1);
        expect(computeUnits(4096, 900)).toBe(1);
    });
    it('is null when an input is unknown rather than guessed', () => {
        expect(computeUnits(null, 10)).toBeNull();
        expect(computeUnits(1024, 0)).toBeNull();
    });
});

describe('CostTracker (unit)', () => {
    it('sums bytes and requests and reports megabytes', () => {
        const c = new CostTracker({ maxProxyMegabytes: 10 });
        c.addBytes(1_500_000);
        c.addBytes(500_000);
        const r = c.report();
        expect(r.proxyMegabytes).toBe(2);
        expect(r.requests).toBe(2);
        expect(r.maxProxyMegabytes).toBe(10);
    });

    it('ignores nonsense byte counts', () => {
        const c = new CostTracker();
        c.addBytes(NaN);
        c.addBytes(-5);
        c.addBytes(0);
        expect(c.report().proxyMegabytes).toBe(0);
        expect(c.report().requests).toBe(0);
    });

    it('stops the run through the budget once the megabyte cap is exceeded', () => {
        const budget = new BudgetTracker(100);
        const c = new CostTracker({ budget, maxProxyMegabytes: 1 });
        c.addBytes(900_000);
        expect(budget.canWriteMore()).toBe(true);
        c.addBytes(200_000);
        expect(budget.canWriteMore()).toBe(false);
        expect(budget.summary().stopReason).toBe('max_proxy_megabytes');
    });

    it('a cap of null/0 means no proxy cap', () => {
        const budget = new BudgetTracker(100);
        const c = new CostTracker({ budget, maxProxyMegabytes: 0 });
        c.addBytes(900_000_000);
        expect(budget.canWriteMore()).toBe(true);
    });

    it('only estimates dollars when a price was given', () => {
        const noPrice = new CostTracker();
        noPrice.addBytes(50_000_000);
        expect(noPrice.report().estimatedProxyUsd).toBeNull();
        const priced = new CostTracker({ proxyPricePerGbUsd: 8 });
        priced.addBytes(250_000_000);
        expect(priced.report().estimatedProxyUsd).toBe(2);
    });

    it('passes the platform usage figure through unchanged', () => {
        const c = new CostTracker();
        expect(c.report({ platformUsage: { usageTotalUsd: 0.12 } }).platformUsage).toEqual({ usageTotalUsd: 0.12 });
        expect(c.report().platformUsage).toBeNull();
    });
});

describe('CostTracker (real Chromium, local server)', () => {
    let server;
    let base;
    let browser;
    // A valid 1x1 GIF followed by padding (decoders ignore bytes after the trailer), so the browser really loads it.
    const png = Buffer.concat([
        Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
        Buffer.alloc(200_000),
    ]);

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            if (req.url.startsWith('/img')) {
                res.writeHead(200, { 'Content-Type': 'image/gif' });
                res.end(png);
            } else if (req.url.startsWith('/data')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ hello: 'x'.repeat(5000) }));
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><img src="/img1.png"><img src="/img2.png"><p>hi</p></body></html>');
            }
        });
        await new Promise((resolve) => {
            server.listen(0, '127.0.0.1', resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
        browser = await launchBrowser();
    });

    afterAll(async () => {
        await browser?.close();
        await new Promise((resolve) => {
            server.close(resolve);
        });
    });

    it('blocks images and counts far fewer bytes than loading them', async () => {
        const blocked = new CostTracker();
        const ctxA = await browser.newContext();
        await blocked.attach(ctxA, { blockHeavyResources: true });
        const pageA = await ctxA.newPage();
        await pageA.goto(`${base}/page`, { waitUntil: 'load' });
        await blocked.settle();
        await ctxA.close();

        const open = new CostTracker();
        const ctxB = await browser.newContext();
        await open.attach(ctxB, { blockHeavyResources: false });
        const pageB = await ctxB.newPage();
        await pageB.goto(`${base}/page`, { waitUntil: 'load' });
        await open.settle();
        await ctxB.close();

        expect(blocked.blockedRequests).toBe(2);
        expect(open.blockedRequests).toBe(0);
        expect(open.bytes).toBeGreaterThan(150_000);
        expect(blocked.bytes).toBeLessThan(50_000);
    });

    it('does not block data requests (fetch/xhr) and stops the run when the cap is passed', async () => {
        const budget = new BudgetTracker(100);
        const c = new CostTracker({ budget, maxProxyMegabytes: 0.004 });
        const ctx = await browser.newContext();
        await c.attach(ctx, { blockHeavyResources: true });
        const page = await ctx.newPage();
        await page.goto(`${base}/page`, { waitUntil: 'load' });
        const body = await page.evaluate(async (u) => (await fetch(u)).text(), `${base}/data`);
        await c.settle();
        await ctx.close();
        expect(body).toContain('hello');
        expect(budget.summary().stopReason).toBe('max_proxy_megabytes');
    });
});
