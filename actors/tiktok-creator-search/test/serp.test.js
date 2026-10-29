import { describe, expect, it } from 'vitest';

import {
    accountsInText,
    buildQuery,
    classifySearchPage,
    discoverCreators,
    followerHint,
    handleFromSnippet,
    handleFromTitle,
    handleFromUrl,
    parseFollowerHint,
    parseSerpHtml,
    unwrapSearchUrl,
} from '../src/serp.js';

// A Google-like result page: redirect links /url?q=..., the account printed as "TikTok · handle"
const resultBlock = ({ href, title, line, extra = '' }) =>
    `<div class="g"><a href="/url?q=${encodeURIComponent(href)}&amp;sa=U"><h3>${title}</h3></a><span>${line}</span><div>${extra}</div></div>`;
const page = (blocks) => `<html><head><title>q - Google Search</title></head><body>${blocks.join('\n')}</body></html>`;

describe('buildQuery', () => {
    it('has three wordings and adds modifiers', () => {
        expect(buildQuery({ keyword: 'budgeting', variant: 0 })).toBe('site:tiktok.com budgeting');
        expect(buildQuery({ keyword: '#budgeting', variant: 1 })).toBe('#budgeting tiktok followers');
        expect(buildQuery({ keyword: 'debt', variant: 2, modifiers: ['creator'] })).toBe('debt "tiktok.com" creator');
    });
});

describe('addresses and names', () => {
    it('reads a profile and a video address', () => {
        expect(handleFromUrl('https://www.tiktok.com/@Jane.Doe')).toEqual({
            handle: 'jane.doe',
            kind: 'profile',
            videoId: null,
        });
        expect(handleFromUrl('https://www.tiktok.com/@jane/video/7600000000000000001?lang=en')).toEqual({
            handle: 'jane',
            kind: 'post',
            videoId: '7600000000000000001',
        });
        expect(handleFromUrl('https://www.tiktok.com/tag/budgeting')).toBeNull();
        expect(handleFromUrl('https://www.instagram.com/jane')).toBeNull();
    });
    it('unwraps Google redirects, also with an empty q', () => {
        expect(unwrapSearchUrl('https://www.google.com/url?q=https://www.tiktok.com/@jane&sa=U')).toBe(
            'https://www.tiktok.com/@jane',
        );
        expect(unwrapSearchUrl('https://www.google.com/url?q=&url=https://www.tiktok.com/@jane')).toBe(
            'https://www.tiktok.com/@jane',
        );
    });
    it('takes handles from titles and snippets, never display names or counts', () => {
        expect(handleFromTitle('Jane Doe (@jane_doe) | TikTok')).toBe('jane_doe');
        expect(handleFromSnippet('TikTok · thebudgetmom 900+ likes')).toBe('thebudgetmom');
        expect(handleFromSnippet('TikTok · 85K views')).toBeNull();
        expect(handleFromSnippet('TikTok · Dave Ramsey 3K')).toBeNull();
        expect(handleFromSnippet('TikTok · debt free journey')).toBeNull();
        expect(
            accountsInText('TikTok · one 10K likes TikTok · two 4 likes TikTok · one again').map((a) => a.handle),
        ).toEqual(['one', 'two']);
    });
    it('reads follower hints', () => {
        expect(followerHint('Jane 12.4K Followers · 300 Following')).toBe('12.4K');
        expect(parseFollowerHint('12.4K')).toBe(12_400);
        expect(parseFollowerHint('1.2M')).toBe(1_200_000);
        expect(parseFollowerHint('abc')).toBeNull();
    });
});

describe('parseSerpHtml + classifySearchPage', () => {
    const html = page([
        resultBlock({
            href: 'https://www.tiktok.com/@alpha',
            title: 'Alpha (@alpha) | TikTok',
            line: 'TikTok · alpha 12.4K Followers',
        }),
        resultBlock({
            href: 'https://www.tiktok.com/@beta/video/7600000000000000002',
            title: 'How I budget',
            line: 'TikTok · beta 3K likes',
        }),
        resultBlock({
            href: 'https://www.tiktok.com/@gamma/video/7600000000000000003',
            title: 'Free course on budgeting',
            line: 'TikTok · gamma 1K likes',
        }),
        resultBlock({ href: 'https://www.example.com/blog', title: 'A blog', line: 'nothing here' }),
    ]);
    it('finds creators, builds video links, applies the exclude words', async () => {
        const parsed = parseSerpHtml(html);
        const res = classifySearchPage({ ...parsed, excludeWords: ['course'] });
        expect(res.status).toBe('ok');
        expect(res.hits.map((h) => [h.handle, h.kind])).toEqual([
            ['alpha', 'profile'],
            ['beta', 'post'],
        ]);
        expect(res.hits[0].hint).toBe('12.4K');
        expect(res.hits[1].videoUrl).toBe('https://www.tiktok.com/@beta/video/7600000000000000002');
        expect(res.excluded).toBe(1);
    });
    it('recognises a bot check, no results, and a page without TikTok results', () => {
        expect(
            classifySearchPage({
                title: 'Before you continue',
                text: 'Our systems have detected unusual traffic from your computer network',
            }).status,
        ).toBe('blocked');
        expect(classifySearchPage({ title: 'x', text: 'Your search did not match any documents' }).status).toBe(
            'no_results',
        );
        const other = parseSerpHtml(page([resultBlock({ href: 'https://www.example.com/a', title: 'A', line: 'x' })]));
        expect(classifySearchPage({ ...other }).status).toBe('unrecognised');
    });
    it('reads accounts that only appear in the page source or visible text', () => {
        const src =
            '<html><head><title>t</title></head><body><script>var u="https:\\/\\/www.tiktok.com\\/@hidden_one";</script><p>TikTok · text_only 5K likes</p></body></html>';
        const parsed = parseSerpHtml(src.replace(/\\\//g, '/'));
        const res = classifySearchPage({ ...parsed });
        expect(res.hits.map((h) => h.handle).sort()).toEqual(['hidden_one', 'text_only']);
    });
});

describe('discoverCreators', () => {
    const answers = {
        'site:tiktok.com budgeting': page([
            resultBlock({
                href: 'https://www.tiktok.com/@alpha',
                title: 'Alpha (@alpha)',
                line: 'TikTok · alpha 12K Followers',
            }),
        ]),
        'site:tiktok.com #saving': page([]),
        '#saving tiktok followers': page([
            resultBlock({
                href: 'https://www.tiktok.com/@alpha/video/7600000000000000009',
                title: 'Save',
                line: 'TikTok · alpha 1K likes',
            }),
            resultBlock({ href: 'https://www.tiktok.com/@delta', title: 'Delta (@delta)', line: 'TikTok · delta' }),
        ]),
    };
    const serpFetch = async ({ url }) => {
        const q = decodeURIComponent(new URL(url).searchParams.get('q'));
        const html = answers[q] ?? page([]);
        return parseSerpHtml(html);
    };

    it('tries the next wording when one is empty, merges creators and records every attempt', async () => {
        const { candidates, report } = await discoverCreators({
            keywords: ['budgeting', '#saving'],
            serpProxyUrl: 'http://x',
            serpFetch,
            maxPages: 1,
        });
        const byHandle = Object.fromEntries(candidates.map((c) => [c.handle, c]));
        expect(Object.keys(byHandle).sort()).toEqual(['alpha', 'delta']);
        expect(byHandle.alpha.queries.sort()).toEqual(['#saving', 'budgeting']);
        expect(byHandle.alpha.timesSeen).toBe(2);
        expect(byHandle.alpha.profileHit).toBe(true);
        expect(byHandle.alpha.videoUrls).toEqual(['https://www.tiktok.com/@alpha/video/7600000000000000009']);
        const saving = report.queries.find((q) => q.keyword === '#saving');
        expect(saving.attempts.map((a) => [a.query, a.status])).toEqual([
            ['site:tiktok.com #saving', 'unrecognised'],
            ['#saving tiktok followers', 'ok'],
        ]);
    });

    it('stops everything after a bot check and says so', async () => {
        const blocked = async () =>
            parseSerpHtml(
                '<html><head><title>Sorry</title></head><body>Our systems have detected unusual traffic</body></html>',
            );
        const { candidates, report } = await discoverCreators({
            keywords: ['a1', 'b1', 'c1', 'd1'],
            serpProxyUrl: 'http://x',
            serpFetch: blocked,
            maxPages: 1,
        });
        expect(candidates).toEqual([]);
        expect(report.blocked).toBe(true);
        expect(report.queries.every((q) => q.attempts.every((a) => a.status === 'blocked'))).toBe(true);
    });

    it('reports an unavailable proxy and a failed request without throwing', async () => {
        const none = await discoverCreators({ keywords: ['x1'], serpProxyUrl: null });
        expect(none.report.queries[0].attempts[0].status).toBe('unavailable');
        const failing = await discoverCreators({
            keywords: ['x1'],
            serpProxyUrl: 'http://x',
            serpFetch: async () => {
                throw new Error('Timeout awaiting request');
            },
            maxPages: 1,
        });
        expect(failing.report.queries[0].attempts.map((a) => a.status)).toEqual(['error', 'error', 'error']);
    });

    it('does not start searches after the time budget', async () => {
        const { report } = await discoverCreators({
            keywords: ['a1', 'b1'],
            serpProxyUrl: 'http://x',
            serpFetch,
            maxSeconds: 0,
        });
        expect(report.queries).toEqual([]);
        expect(report.stoppedOnTime).toBe(true);
    });
});
