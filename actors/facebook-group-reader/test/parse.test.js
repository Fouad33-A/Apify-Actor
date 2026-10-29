import { describe, expect, it } from 'vitest';

import { readInput, run } from '../src/main.js';
import { isLoginWall, normalizeGroup, parseGroupMeta, parsePosts } from '../src/parse.js';

// A page built to the structure this reader looks for (meta tags + embedded JSON with message text and creation time).
const post = (id, text, created, extra = {}) => ({
    post_id: id,
    url: `https://www.facebook.com/groups/g1/posts/${id}/`,
    message: { text },
    creation_time: created,
    feedback: { reaction_count: { count: 12 }, comment_count: { total_count: 3 }, share_count: { count: 1 } },
    actors: [{ name: 'Some Person' }],
    ...extra,
});
const page = (posts) =>
    `<html><head><title>IGCSE Help | Facebook</title><meta property="og:title" content="IGCSE Help"/><meta property="og:description" content="Public group · 12.5K members. Help for IGCSE students."/></head><body><script type="application/json" data-sjs>${JSON.stringify({ require: [{ group_feed: posts }] })}</script></body></html>`;

describe('addresses', () => {
    it('accepts group addresses and ids, rejects the rest', () => {
        expect(normalizeGroup('https://www.facebook.com/groups/igcse.help/')).toEqual({
            id: 'igcse.help',
            url: 'https://www.facebook.com/groups/igcse.help',
        });
        expect(normalizeGroup('https://m.facebook.com/groups/123456789?ref=x').id).toBe('123456789');
        expect(normalizeGroup('somegroup').id).toBe('somegroup');
        expect(normalizeGroup('https://www.facebook.com/somepage').error).toBe('not_a_group_address');
        expect(normalizeGroup('https://www.facebook.com/groups/feed/').error).toBe('not_a_group_address');
    });
});

describe('page reading', () => {
    it('detects a login wall by address or title', () => {
        expect(isLoginWall({ finalUrl: 'https://www.facebook.com/login/?next=x', html: '' })).toBe(true);
        expect(
            isLoginWall({ finalUrl: 'https://www.facebook.com/groups/g1', html: '<title>Log in to Facebook</title>' }),
        ).toBe(true);
        expect(isLoginWall({ finalUrl: 'https://www.facebook.com/groups/g1', html: page([]) })).toBe(false);
    });
    it('reads name, members and privacy', () => {
        expect(parseGroupMeta(page([]))).toMatchObject({ name: 'IGCSE Help', memberCount: 12500, privacy: 'public' });
    });
    it('reads posts with counts, leaves authors out unless asked, and de-duplicates', () => {
        const html = page([
            post('1', 'Is it worth paying for notes?', 1760000000),
            post('1', 'Is it worth paying for notes?', 1760000000),
            post('2', 'Past paper help', '1760100000'),
        ]);
        const posts = parsePosts(html);
        expect(posts).toHaveLength(2);
        // newest post first
        expect(posts.map((p) => p.postId)).toEqual(['2', '1']);
        const first = posts.find((p) => p.postId === '1');
        expect(first).toMatchObject({
            postId: '1',
            text: 'Is it worth paying for notes?',
            reactions: 12,
            comments: 3,
            shares: 1,
            createdAt: '2025-10-09T08:53:20.000Z',
        });
        expect(first.author).toBeUndefined();
        expect(parsePosts(html, { includeAuthors: true })[0].author).toBe('Some Person');
        expect(parsePosts('<html></html>')).toEqual([]);
    });
});

describe('run', () => {
    const rows = [];
    const push = async (r) => void rows.push(r);
    it('reports login_wall without reading anything', async () => {
        rows.length = 0;
        const summary = await run({
            input: {
                ...readInput({ groups: ['https://www.facebook.com/groups/g1', 'nope!'], delayBetweenGroupsMs: 0 }),
            },
            pushData: push,
            fetchAttempt: async () => ({
                status: 200,
                html: '<title>Log in to Facebook</title>',
                finalUrl: 'https://www.facebook.com/login/?next=x',
            }),
        });
        expect(rows.map((r) => r.status)).toEqual(['invalid_input', 'login_wall']);
        expect(rows[1].statusDetail).toMatch(/redirected the anonymous public feed to login/);
        expect(summary).toMatchObject({ groups: 1, loginWall: 1, posts: 0 });
    });
    it('returns the group row and post rows, newest filter applied', async () => {
        rows.length = 0;
        const html = page([post('1', 'Old', 1700000000), post('2', 'New', 1790000000)]);
        const summary = await run({
            input: readInput({ groups: ['g1abc'], sinceDate: '2026-01-01', delayBetweenGroupsMs: 0 }),
            pushData: push,
            fetchAttempt: async (url) => ({ status: 200, html, finalUrl: url }),
        });
        expect(rows.map((r) => [r.recordType, r.status])).toEqual([
            ['group', 'ok'],
            ['post', 'ok'],
        ]);
        expect(rows[0]).toMatchObject({ name: 'IGCSE Help', memberCount: 12500, postsVisible: 1 });
        expect(summary).toMatchObject({ ok: 1, posts: 1 });
        expect(rows.every((r) => r.scrapedAt && r.status)).toBe(true);
    });
    it('says no_posts_visible when the page loads but holds no posts, and reports HTTP errors', async () => {
        rows.length = 0;
        await run({
            input: readInput({ groups: ['g1abc', 'g2abc'], delayBetweenGroupsMs: 0 }),
            pushData: push,
            fetchAttempt: async (url) =>
                url.endsWith('g2abc')
                    ? { status: 404, html: '', finalUrl: url }
                    : { status: 200, html: page([]), finalUrl: url },
        });
        expect(rows.map((r) => r.status)).toEqual(['no_posts_visible', 'not_found']);
    });
    it('validates input', () => {
        expect(() => readInput({})).toThrow(/at least one/);
        expect(() => readInput({ groups: ['g1abc'], sinceDate: 'x' })).toThrow(/sinceDate/);
    });
});
