import { describe, expect, it } from 'vitest';

import { classifyResponse, htmlToText, parseAtom, searchFeed, subredditFeed, threadFeed } from '../src/feed.js';
import { readInput, run } from '../src/main.js';
import { mergeThemes, tagText } from '../src/themes.js';

const entry = ({ id, title, author = 'u1', updated, html, link, kind = 'post' }) =>
    `<entry><author><name>/u/${author}</name></author><category term="igcse" label="r/igcse"/><content type="html">${html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</content><id>${id}</id><link href="${link ?? `https://www.reddit.com/r/igcse/comments/${id.replace('t3_', '')}/slug/`}"/><updated>${updated}</updated><title>${title}</title></entry>`;
const feed = (...entries) =>
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`;
const post = (n, updated, extra = {}) =>
    entry({
        id: `t3_p${n}`,
        title: `Is Magoosh worth it? ${n}`,
        updated,
        html: '<div class="md"><p>It is too <b>expensive</b> for me.</p><p>Any free alternative?</p></div><table><tr><td>submitted by u1 [link] [comments]</td></tr></table>',
        ...extra,
    });
const comment = (n) =>
    entry({
        id: `t1_c${n}`,
        title: `/u/x on thread`,
        updated: '2026-10-02T00:00:00+00:00',
        html: `<div class="md"><p>Try Khan Academy, it is free. ${n}</p></div>`,
    });

describe('feed parsing', () => {
    it('builds the addresses', () => {
        expect(subredditFeed('igcse')).toBe('https://www.reddit.com/r/igcse/new/.rss?limit=100');
        expect(subredditFeed('igcse', { after: 't3_x' })).toMatch(/&after=t3_x$/);
        expect(searchFeed('SAT', 'worth it')).toBe(
            'https://www.reddit.com/r/SAT/search.rss?q=worth%20it&restrict_sr=1&sort=new&t=all&limit=100',
        );
        expect(threadFeed('https://www.reddit.com/r/igcse/comments/p1/slug/')).toBe(
            'https://www.reddit.com/r/igcse/comments/p1/slug/.rss?limit=100&sort=top',
        );
    });
    it('reads entries and turns the HTML into text without the footer', () => {
        const [e] = parseAtom(feed(post(1, '2026-10-01T00:00:00+00:00')));
        expect(e).toMatchObject({
            id: 't3_p1',
            kind: 'post',
            author: 'u1',
            subreddit: 'igcse',
            updated: '2026-10-01T00:00:00+00:00',
        });
        expect(e.text).toContain('too expensive for me.');
        expect(e.text).not.toMatch(/submitted by|\[link\]/);
        expect(htmlToText('<p>a</p><p>b</p>')).toBe('a\nb');
        expect(parseAtom(feed(comment(1)))[0].kind).toBe('comment');
    });
    it('classifies answers', () => {
        expect(classifyResponse(200, feed()).status).toBe('ok');
        expect(classifyResponse(403, '').status).toBe('blocked');
        expect(classifyResponse(429, '').status).toBe('rate_limited');
        expect(classifyResponse(404, '').status).toBe('not_found');
        expect(classifyResponse(200, '<html>').status).toBe('unreadable');
    });
});

describe('themes', () => {
    it('tags price, worth it, free alternative and competitors', () => {
        const t = tagText('Is Magoosh worth it? Too expensive. Any free alternative like Khan Academy?');
        expect(t.themes.sort()).toEqual(['competitor', 'free_alternative', 'price', 'worth_it']);
        expect(t.competitorsMentioned).toEqual(['magoosh', 'khan academy']);
        expect(tagText('The albertson store').competitorsMentioned).toEqual([]); // whole words only
    });
    it('adds custom themes', () => {
        const themes = mergeThemes({ scholarship: ['scholarship', 'financial aid'] });
        expect(tagText('any financial aid?', { themes, competitors: [] }).themes).toEqual(['scholarship']);
    });
});

describe('run', () => {
    const quick = { delayBetweenRequestsMs: 0 };
    it('reads threads inside the date range, adds tagged comments and a subreddit summary', async () => {
        const rows = [];
        const input = readInput({ subreddits: ['r/igcse'], dateFrom: '2026-10-01', dateTo: '2026-10-31', ...quick });
        const asked = [];
        const fetch = async (url) => {
            asked.push(url);
            if (url.includes('/new/.rss'))
                return {
                    status: 200,
                    body: feed(
                        post(1, '2026-11-05T00:00:00+00:00'),
                        post(2, '2026-10-20T00:00:00+00:00'),
                        post(3, '2026-10-02T00:00:00+00:00'),
                        post(4, '2026-09-01T00:00:00+00:00'),
                        post(5, '2026-08-01T00:00:00+00:00'),
                    ),
                };
            return { status: 200, body: feed(post(2, '2026-10-20T00:00:00+00:00'), comment(1), comment(2)) };
        };
        const summary = await run({ input, pushData: async (r) => void rows.push(r), fetch });
        const threads = rows.filter((r) => r.recordType === 'thread');
        expect(threads.map((t) => t.threadId)).toEqual(['p2', 'p3']);
        expect(threads[0]).toMatchObject({ score: null, status: 'ok', commentsStatus: 'ok' });
        expect(threads[0].comments).toHaveLength(2);
        expect(threads[0].threadThemes).toEqual(
            expect.arrayContaining(['price', 'worth_it', 'free_alternative', 'competitor']),
        );
        expect(rows.find((r) => r.recordType === 'subreddit')).toMatchObject({
            status: 'ok',
            threadsRead: 2,
            commentsRead: 4,
        });
        expect(summary).toMatchObject({ threads: 2, comments: 4, blocked: 0 });
        expect(rows.every((r) => r.scrapedAt && r.status)).toBe(true);
        expect(asked.length).toBeGreaterThan(1);
    });

    it('uses the subreddit search for keywords and merges duplicate threads', async () => {
        const rows = [];
        const input = readInput({
            subreddits: ['igcse'],
            keywords: ['worth it', 'free'],
            includeComments: false,
            ...quick,
        });
        const fetch = async () => ({
            status: 200,
            body: feed(
                post(1, '2026-10-01T00:00:00+00:00'),
                post(2, '2026-10-02T00:00:00+00:00'),
                post(3, '2026-10-03T00:00:00+00:00'),
                post(4, '2026-10-04T00:00:00+00:00'),
                post(5, '2026-10-05T00:00:00+00:00'),
            ),
        });
        await run({ input: { ...input, maxThreadsPerSubreddit: 10 }, pushData: async (r) => void rows.push(r), fetch });
        const threads = rows.filter((r) => r.recordType === 'thread');
        expect(threads).toHaveLength(5);
        expect(threads[0].matchedKeywords.sort()).toEqual(['free', 'worth it']);
        expect(threads[0].commentsStatus).toBe('not_requested');
    });

    it('says blocked, and does not throw, when Reddit refuses', async () => {
        const rows = [];
        const summary = await run({
            input: readInput({ subreddits: ['igcse', 'SAT'], ...quick }),
            pushData: async (r) => void rows.push(r),
            fetch: async () => ({ status: 403, body: 'Blocked' }),
        });
        expect(rows.filter((r) => r.recordType === 'subreddit').map((r) => r.status)).toEqual(['blocked', 'blocked']);
        expect(rows[0].statusDetail).toMatch(/does not give the feed/);
        expect(summary.blocked).toBe(2);
    });

    it('waits out a 429 twice and then reports rate_limited', async () => {
        const rows = [];
        let calls = 0;
        await run({
            input: readInput({ subreddits: ['igcse'], ...quick }),
            pushData: async (r) => void rows.push(r),
            fetch: async () => {
                calls += 1;
                return { status: 429, body: '' };
            },
            backoffMs: 0,
        });
        expect(calls).toBe(3);
        expect(rows[0]).toMatchObject({ recordType: 'subreddit', status: 'rate_limited' });
    });

    it('validates input', () => {
        expect(() => readInput({})).toThrow(/subreddit/);
        expect(() => readInput({ subreddits: ['a'], dateFrom: 'x' })).toThrow(/dateFrom/);
        expect(() => readInput({ subreddits: ['a'], dateFrom: '2026-02-01', dateTo: '2026-01-01' })).toThrow(/after/);
    });
});
