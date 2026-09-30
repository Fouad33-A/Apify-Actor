import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { destinationsFromAnchors, isLinkInBioUrl, looksLikeErrorPage, resolveBioLinks } from '../src/linkinbio.js';
import { launchBrowser, serve } from './helpers/browser.js';

describe('isLinkInBioUrl', () => {
    it.each([
        ['https://linktr.ee/planbudgetdream', true],
        ['linktr.ee/planbudgetdream', true],
        ['https://www.beacons.ai/x', true],
        ['https://x.carrd.co/', true],
        ['https://bio.link/x', true],
        ['https://stan.store/x', true],
        ['https://example.com/linktr.ee', false],
        ['https://notlinktr.ee/x', false],
        ['https://nasa.gov', false],
        ['', false],
        [null, false],
    ])('%s -> %s', (url, expected) => {
        expect(isLinkInBioUrl(url)).toBe(expected);
    });
});

describe('looksLikeErrorPage', () => {
    it.each([
        [{ title: 'Error 502: Bad gateway | cloudflare', text: 'Cloudflare' }, true],
        [{ title: '', text: 'Just a moment... Checking your browser' }, true],
        [{ title: 'Access denied', text: '' }, true],
        [{ title: '', text: 'Sorry, this page could not be found' }, true],
        [{ title: 'Creator | Beacons', text: 'Shop my store Watch on YouTube Book a call', length: 40 }, false],
        [{ title: '', text: 'My 404 ebook guide and captcha tips '.repeat(40), length: 1400 }, false],
        [{}, false],
    ])('%j -> %s', (info, expected) => {
        expect(looksLikeErrorPage(info)).toBe(expected);
    });
});

describe('destinationsFromAnchors', () => {
    const page = 'https://linktr.ee/creator';
    it('keeps distinct outside destinations, drops own-host/mailto/javascript links and tracking parameters', () => {
        const anchors = [
            { href: 'https://stan.store/creator?utm_source=ig&ref=x&keep=1' },
            { href: 'https://stan.store/creator?keep=1#top' },
            { href: 'https://linktr.ee/creator/other' },
            { href: 'https://www.linktr.ee/privacy' },
            { href: 'mailto:hi@example.com' },
            // eslint-disable-next-line no-script-url -- a link that must be ignored
            { href: 'javascript:void(0)' },
            { href: 'not a url' },
            { href: 'https://www.amazon.com/shop/creator/' },
        ];
        expect(destinationsFromAnchors(anchors, page)).toEqual([
            'https://stan.store/creator?keep=1',
            'https://www.amazon.com/shop/creator',
        ]);
    });

    it('caps the number of destinations', () => {
        const anchors = Array.from({ length: 10 }, (_, i) => ({ href: `https://shop${i}.example.com/` }));
        expect(destinationsFromAnchors(anchors, page, { maxLinks: 3 })).toHaveLength(3);
    });
});

describe('resolveBioLinks (real Chromium, synthetic pages)', () => {
    let browser;
    beforeAll(async () => {
        browser = await launchBrowser();
    });
    afterAll(async () => {
        await browser?.close();
    });

    async function run(routes, links) {
        const context = await browser.newContext();
        try {
            await serve(context, routes);
            return await resolveBioLinks({ page: await context.newPage(), links, settleMs: 50 });
        } finally {
            await context.close();
        }
    }

    it('follows a link-in-bio page and returns the destinations, so a hidden Stan Store is visible', async () => {
        const body = `<html><body><a href="https://stan.store/creator?utm_source=ig">My store</a>
            <a href="https://www.youtube.com/@creator">YouTube</a><a href="https://linktr.ee/about">About Linktree</a></body></html>`;
        const r = await run(
            [{ match: /linktr\.ee\/creator$/, body }],
            ['https://creator-site.example', 'https://linktr.ee/creator'],
        );
        expect(r.targets).toEqual(['https://stan.store/creator', 'https://www.youtube.com/@creator']);
        expect(r.warnings).toEqual([]);
    });

    it('a link-in-bio page that cannot be loaded is a warning, not a clean pass', async () => {
        const r = await run([], ['https://linktr.ee/creator']);
        expect(r.targets).toEqual([]);
        expect(r.warnings[0]).toMatch(/linktr\.ee\/creator could not be read/);
    });

    it('a page with no outgoing links (empty, blocked, not rendered) is also a warning', async () => {
        const r = await run(
            [{ match: /beacons\.ai\/x$/, body: '<html><body>loading</body></html>' }],
            ['https://beacons.ai/x'],
        );
        expect(r.warnings[0]).toMatch(/showed no outgoing links/);
    });

    it('an error or bot-check page is a warning and its own links (Cloudflare) are NOT read as destinations', async () => {
        const body = `<html><head><title>Error 502: Bad gateway</title></head><body>Bad gateway
            <a href="https://www.cloudflare.com/5xx-error-landing">Cloudflare</a></body></html>`;
        const r = await run([{ match: /beacons\.ai\/cazzatime$/, body }], ['https://beacons.ai/cazzatime']);
        expect(r.targets).toEqual([]);
        expect(r.warnings[0]).toMatch(/error or bot-check page.*NOT read/);
    });

    it('follows at most maxPages pages and ignores ordinary links', async () => {
        const r = await run([], ['https://example.com/a', 'https://example.org/b']);
        expect(r).toEqual({ targets: [], warnings: [] });
    });
});
