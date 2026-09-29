import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runtimeInfo, saveDiagnostics } from '../src/diagnostics.js';
import { launchBrowser } from './helpers/browser.js';

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

describe('saveDiagnostics', () => {
    it('saves a readable JSON record with url, title, truncated html and visible text', async () => {
        const page = await browser.newPage();
        const html = `<html><head><title>Hello</title></head><body>${'x'.repeat(10_000)}</body></html>`;
        await page.setContent(html);
        await saveDiagnostics(page, html, 'profile_x', { httpStatus: 200 });
        await page.close();

        const [key, value, opts] = setValue.mock.calls[0];
        expect(key).toBe('DIAG_profile_x');
        expect(opts.contentType).toMatch(/application\/json/);
        const rec = JSON.parse(value);
        expect(rec).toMatchObject({ title: 'Hello', htmlLength: html.length, meta: { httpStatus: 200 } });
        expect(rec.htmlHead).toHaveLength(4000);
        expect(rec.bodyText.length).toBeLessThanOrEqual(2000);
    });

    it('never throws if saving fails', async () => {
        setValue.mockRejectedValueOnce(new Error('kv down'));
        const page = await browser.newPage();
        await expect(saveDiagnostics(page, '', 't')).resolves.toBeTruthy();
        await page.close();
    });
});

describe('runtimeInfo', () => {
    it('reports the code version from package.json and the platform build env', () => {
        process.env.ACTOR_BUILD_NUMBER = '0.0.42';
        const info = runtimeInfo();
        expect(info.codeVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(info.buildNumber).toBe('0.0.42');
        delete process.env.ACTOR_BUILD_NUMBER;
    });
});
