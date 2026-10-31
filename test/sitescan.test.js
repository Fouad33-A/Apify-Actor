import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyScreening } from '../src/expand.js';
import { isLinkInBioUrl } from '../src/linkinbio.js';
import { cleanEmails, looksParked, pickSiteUrls, scanCreatorSites, siteText } from '../src/sitescan.js';
import { launchBrowser, serve } from './helpers/browser.js';

let browser;
beforeAll(async () => {
    browser = await launchBrowser();
});
afterAll(async () => {
    await browser?.close();
});

describe('pickSiteUrls', () => {
    it("puts the creator's own domain first, skips platforms, trackers and link-in-bio pages, reads the home page", () => {
        const links = [
            'https://linktr.ee/jane',
            'https://www.instagram.com/jane',
            'https://iggroup.sjv.io/k4bbNn',
            'https://sponsor-brand.com/deal?x=1',
            'https://www.janebudgets.com/offers/checkout',
            'https://janebudgets.com/other',
        ];
        expect(pickSiteUrls(links, 'janebudgets', 2, isLinkInBioUrl)).toEqual([
            'https://www.janebudgets.com/',
            'https://sponsor-brand.com/',
        ]);
    });

    it('returns nothing when there is no site, and respects the maximum', () => {
        expect(pickSiteUrls(['https://tiktok.com/@x', 'not a url'], 'x', 2)).toEqual([]);
        expect(pickSiteUrls(['https://a.com', 'https://b.com', 'https://c.com'], 'zzzz', 2)).toEqual([
            'https://a.com/',
            'https://b.com/',
        ]);
    });
});

describe('cleanEmails / looksParked / siteText', () => {
    it('keeps real addresses from text and mailto, drops placeholders and image names', () => {
        expect(
            cleanEmails([
                'mailto:Hello@Jane.com',
                'write to jane@jane.com or you@example.com or logo@2x.png or x@sentry.io',
            ]),
        ).toEqual(['hello@jane.com', 'jane@jane.com']);
    });

    it('recognises parked / for-sale domains and leaves normal pages alone', () => {
        expect(looksParked({ title: 'gofundyourself.co.uk is for sale', text: 'Buy this domain' })).toBe(true);
        expect(looksParked({ title: 'Jane - money coach', text: 'Welcome to my blog about budgeting' })).toBe(false);
    });

    it('siteText joins headings and menu labels once each', () => {
        expect(siteText({ headings: ['Courses'], menu: ['Courses', 'Blog'] })).toBe('Courses | Blog');
    });
});

describe('scanCreatorSites (real page, synthetic sites)', () => {
    const home = (extra = '') =>
        `<!doctype html><html><head><title>Jane | Money</title><meta name="description" content="Budgeting for real life"></head>
         <body><header><nav><a href="/courses">Courses</a><a href="/contact">Contact</a></nav></header>
         <h1>Budget like a pro</h1>${extra}</body></html>`;

    async function scan(routes, urls) {
        const context = await browser.newContext();
        try {
            await serve(context, routes);
            const page = await context.newPage();
            return await scanCreatorSites({ page, urls, max: 2 });
        } finally {
            await context.close();
        }
    }

    it('reads title, description, headings and menu, and an e-mail written on the home page', async () => {
        const { sites, emails, warnings } = await scan(
            [
                {
                    match: /jane\.test\/$/,
                    body: home('<p>Business: <a href="mailto:biz@jane.test">biz@jane.test</a></p>'),
                },
            ],
            ['https://jane.test/'],
        );
        expect(warnings).toEqual([]);
        expect(emails).toEqual(['biz@jane.test']);
        expect(sites[0]).toMatchObject({
            url: 'https://jane.test/',
            title: 'Jane | Money',
            description: 'Budgeting for real life',
        });
        expect(sites[0].text).toContain('Courses');
        expect(sites[0].text).toContain('Budget like a pro');
    });

    it('follows one contact page when the home page shows no e-mail', async () => {
        const { emails } = await scan(
            [
                { match: /jane\.test\/$/, body: home() },
                { match: /jane\.test\/contact$/, body: '<html><body><p>Reach me: pr@jane.test</p></body></html>' },
            ],
            ['https://jane.test/'],
        );
        expect(emails).toEqual(['pr@jane.test']);
    });

    it('reports parked, error and unreachable sites as warnings, never as a clean read', async () => {
        const { sites, emails, warnings } = await scan(
            [
                {
                    match: /parked\.test\//,
                    body: '<html><head><title>parked.test is for sale</title></head><body>Buy this domain today</body></html>',
                },
                {
                    match: /down\.test\//,
                    body: '<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>',
                },
            ],
            ['https://parked.test/', 'https://down.test/'],
        );
        expect(sites).toEqual([]);
        expect(emails).toEqual([]);
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toMatch(/parked or for sale/);
        expect(warnings[1]).toMatch(/error or bot-check/);
    }, 60_000);
});

describe('applyScreening: website patterns', () => {
    const row = (sites) => ({
        status: 'found',
        followerCount: 50_000,
        contactEmails: [],
        bio: '',
        creatorSites: sites,
    });

    it('fails a profile whose site says course/coaching, naming the site and the word', () => {
        const { passes, failures } = applyScreening(
            row([
                {
                    url: 'https://www.zerotoamillion.com/',
                    title: 'Zero',
                    description: null,
                    text: 'Home | Online Courses | Blog',
                },
            ]),
            { excludeSitePatterns: ['course', 'coaching'] },
        );
        expect(passes).toBe(false);
        expect(failures).toEqual(['website zerotoamillion.com mentions "course"']);
    });

    it('passes when the site text has none of the words, or no site was read', () => {
        expect(
            applyScreening(row([{ url: 'https://a.com/', title: 'Blog', text: 'Recipes' }]), {
                excludeSitePatterns: ['course'],
            }).passes,
        ).toBe(true);
        expect(applyScreening(row([]), { excludeSitePatterns: ['course'] }).passes).toBe(true);
    });
});
