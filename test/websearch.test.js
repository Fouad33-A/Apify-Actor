import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    buildQuery,
    classifySearchPage,
    discoverByWebSearch,
    followerHint,
    handleFromUrl,
    orderCandidates,
    unwrapSearchUrl,
} from '../src/websearch.js';
import { launchBrowser, serve } from './helpers/browser.js';

let browser;
beforeAll(async () => {
    browser = await launchBrowser();
});
afterAll(async () => {
    await browser?.close();
});

const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('buildQuery', () => {
    it('site + keyword + followers hint + minus words (phrases quoted)', () => {
        expect(
            buildQuery({ platform: 'instagram', keyword: 'budgeting tips', excludeWords: ['course', '-my book', ' '] }),
        ).toBe('site:instagram.com budgeting tips followers -course -"my book"');
        expect(buildQuery({ platform: 'facebook', keyword: 'debt free' })).toBe(
            'site:facebook.com debt free page followers',
        );
        expect(buildQuery({ platform: 'tiktok', keyword: 'etf' })).toBe('site:tiktok.com etf followers');
    });
});

describe('unwrapSearchUrl', () => {
    it('unwraps Bing, DuckDuckGo and Google redirect links, and passes direct links through', () => {
        const real = 'https://www.instagram.com/jane/';
        expect(unwrapSearchUrl(`https://www.bing.com/ck/a?!&&p=x&u=a1${b64url(real)}&ntb=1`)).toBe(real);
        expect(unwrapSearchUrl(`//duckduckgo.com/l/?uddg=${encodeURIComponent(real)}&rut=abc`)).toBe(real);
        expect(unwrapSearchUrl(`https://www.google.com/url?q=${encodeURIComponent(real)}&sa=U`)).toBe(real);
        expect(unwrapSearchUrl(real)).toBe(real);
    });
    it('returns null for junk and for a wrapper it cannot open', () => {
        expect(unwrapSearchUrl('')).toBeNull();
        expect(unwrapSearchUrl('not a url')).toBeNull();
        expect(unwrapSearchUrl('https://www.bing.com/ck/a?u=zzzz')).toBeNull();
    });
});

describe('handleFromUrl', () => {
    it.each([
        ['https://www.instagram.com/jane.budgets/', { platform: 'instagram', handle: 'jane.budgets', kind: 'profile' }],
        ['https://www.instagram.com/jane/reel/ABC123/', { platform: 'instagram', handle: 'jane', kind: 'post' }],
        ['https://www.instagram.com/p/ABC123/', null],
        ['https://www.instagram.com/explore/tags/budget/', null],
        ['https://www.tiktok.com/@Money.Mia', { platform: 'tiktok', handle: 'money.mia', kind: 'profile' }],
        [
            'https://www.tiktok.com/@money.mia/video/7123456789',
            { platform: 'tiktok', handle: 'money.mia', kind: 'post' },
        ],
        ['https://www.tiktok.com/discover/budget', null],
        ['https://www.facebook.com/BudgetBabe', { platform: 'facebook', handle: 'BudgetBabe', kind: 'profile' }],
        ['https://m.facebook.com/BudgetBabe/posts/123', { platform: 'facebook', handle: 'BudgetBabe', kind: 'post' }],
        ['https://www.facebook.com/groups/money', null],
        ['https://www.facebook.com/profile.php?id=1000', null],
        ['https://example.com/jane', null],
    ])('%s', (url, expected) => {
        expect(handleFromUrl(url)).toEqual(expected);
    });
});

describe('followerHint / classifySearchPage', () => {
    it('reads the follower figure a snippet shows (a hint only)', () => {
        expect(followerHint('12.4K Followers, 300 Following, 1,200 Posts - Jane on Instagram')).toBe('12.4K');
        expect(followerHint('nothing here')).toBeNull();
    });

    const anchor = (url, container = '') => ({ href: url, text: 'r', container });
    it('ok: keeps the target platform hits, profile and post kinds, with snippet and hint', () => {
        const res = classifySearchPage({
            title: 'budgeting - Bing',
            text: 'results',
            platform: 'instagram',
            anchors: [
                anchor('https://www.instagram.com/jane/', '25K Followers, 10 Following - Jane'),
                anchor('https://www.instagram.com/jane/reel/X1/', 'reel'),
                anchor('https://www.tiktok.com/@other', 'other platform'),
                anchor('https://example.com/', 'x'),
            ],
        });
        expect(res.status).toBe('ok');
        expect(res.hits.map((h) => [h.handle, h.kind])).toEqual([
            ['jane', 'profile'],
            ['jane', 'post'],
        ]);
        expect(res.hits[0].hint).toBe('25K');
    });
    it('blocked: a bot check / CAPTCHA page is reported, never parsed', () => {
        expect(
            classifySearchPage({ title: 'Verify you are human', text: '', anchors: [], platform: 'instagram' }).status,
        ).toBe('blocked');
        expect(
            classifySearchPage({
                title: 'DuckDuckGo',
                text: 'Unfortunately, bots use DuckDuckGo too.',
                anchors: [],
                platform: 'instagram',
            }).status,
        ).toBe('blocked');
    });
    it('no_results / no_platform_results / unrecognised are told apart', () => {
        expect(
            classifySearchPage({ title: 't', text: 'No results found for x', anchors: [], platform: 'instagram' })
                .status,
        ).toBe('no_results');
        const many = Array.from({ length: 8 }, (_, i) => anchor(`https://example.com/${i}`));
        expect(classifySearchPage({ title: 't', text: 'fine', anchors: many, platform: 'instagram' }).status).toBe(
            'no_platform_results',
        );
        expect(classifySearchPage({ title: 't', text: 'blank', anchors: [], platform: 'instagram' }).status).toBe(
            'unrecognised',
        );
    });
});

describe('orderCandidates', () => {
    const c = (platform, handle, o = {}) => ({
        platform,
        handle,
        profileHit: false,
        timesSeen: 1,
        queries: ['k'],
        ...o,
    });
    it('drops handles already in the tracker, profile hits first, platforms take turns, limit applies', () => {
        const { ordered, skippedDuplicates } = orderCandidates(
            [
                c('instagram', 'a', { timesSeen: 1 }),
                c('instagram', 'b', { profileHit: true }),
                c('instagram', 'dup', { profileHit: true }),
                c('tiktok', 't1'),
                c('tiktok', 't2', { timesSeen: 3 }),
                c('facebook', 'f1'),
            ],
            { exclude: ['@DUP'], limit: 5, platforms: ['instagram', 'facebook', 'tiktok'] },
        );
        expect(ordered.map((x) => x.handle)).toEqual(['b', 'f1', 't2', 'a', 't1']);
        expect(skippedDuplicates).toEqual(['instagram:dup']);
    });
});

describe('discoverByWebSearch (real page, synthetic search engines)', () => {
    const real = (u) => `https://www.bing.com/ck/a?!&&p=1&u=a1${b64url(u)}&ntb=1`;
    const bingPage = `<html><head><title>q - Bing</title></head><body><ol>
        <li class="b_algo"><h2><a href="${real('https://www.instagram.com/jane.budgets/')}">Jane</a></h2><p>25K Followers, 10 Following, 300 Posts - Jane on Instagram</p></li>
        <li class="b_algo"><h2><a href="${real('https://www.instagram.com/bob/reel/AB/')}">Bob</a></h2><p>reel</p></li>
        </ol></body></html>`;
    const ddgPage = `<html><head><title>DuckDuckGo</title></head><body>
        <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://www.instagram.com/zoe/')}">Zoe</a><a class="result__snippet">8,000 Followers</a></div></body></html>`;

    async function run(routes, extra = {}) {
        const context = await browser.newContext();
        try {
            await serve(context, routes);
            const page = await context.newPage();
            return await discoverByWebSearch({
                page,
                keywords: ['budgeting'],
                platforms: ['instagram'],
                maxPages: 1,
                ...extra,
            });
        } finally {
            await context.close();
        }
    }

    it('finds handles through Bing redirect links, with the snippet hint, and reports the query', async () => {
        const { candidates, report } = await run([{ match: /bing\.com\/search/, body: bingPage }]);
        expect(candidates.map((x) => [x.handle, x.profileHit, x.hint])).toEqual([
            ['jane.budgets', true, '25K'],
            ['bob', false, null],
        ]);
        expect(report.queries[0]).toMatchObject({ platform: 'instagram', handlesFound: 2 });
        expect(report.queries[0].attempts).toEqual([{ engine: 'bing', status: 'ok', results: 2 }]);
        expect(report.queries[0].query).toContain('site:instagram.com budgeting');
    });

    it('a blocked engine is reported, skipped for the rest of the run, and the next engine answers', async () => {
        const blocked =
            '<html><head><title>Verify you are human</title></head><body>Please solve the captcha</body></html>';
        const { candidates, report } = await run([
            { match: /bing\.com\/search/, body: blocked },
            { match: /duckduckgo\.com\/html/, body: ddgPage },
        ]);
        expect(candidates.map((x) => x.handle)).toEqual(['zoe']);
        expect(report.enginesBlocked).toEqual(['bing']);
        expect(report.queries[0].attempts.map((a) => [a.engine, a.status])).toEqual([
            ['bing', 'blocked'],
            ['duckduckgo', 'ok'],
        ]);
    }, 60_000);

    it('when every engine shows nothing usable the run says so, with what each page showed', async () => {
        const empty = '<html><head><title>x</title></head><body>nothing</body></html>';
        const { candidates, report } = await run(
            [
                { match: /bing\.com\/search/, body: empty },
                { match: /duckduckgo\.com\/html/, body: empty },
                { match: /search\.brave\.com/, body: empty },
            ],
            {},
        );
        expect(candidates).toEqual([]);
        expect(report.queries[0].attempts).toHaveLength(3);
        expect(report.queries[0].attempts[0]).toMatchObject({ engine: 'bing', status: 'unrecognised' });
        expect(report.queries[0].attempts[0].detail).toContain('nothing');
    }, 90_000);
});
