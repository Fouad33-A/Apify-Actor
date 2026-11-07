import { describe, expect, it } from 'vitest';

import { readInput, run } from '../src/main.js';
import { readChannel } from '../src/scrape.js';
import { notFoundHtml, previewHtml, profileCardHtml } from './fixtures.js';

const now = Date.parse('2026-10-29T12:00:00Z');
const iso = (daysAgo) => new Date(now - daysAgo * 86_400_000).toISOString();

// fake network: a map of url -> { status, body }
const fakeFetch = (pages) => async (url) => pages[url] ?? { status: 404, url, body: '' };

const channelPages = (name, { subscribers = '20K', mentions = '' } = {}) => ({
    [`https://t.me/s/${name}`]: {
        status: 200,
        body: previewHtml({
            username: name,
            subscribers,
            before: 8,
            posts: [
                { id: 10, date: iso(1), views: '2K', text: `news ${mentions}` },
                { id: 9, date: iso(3), views: '1K', text: `more ${mentions}` },
                { id: 8, date: iso(5), views: '3K', text: 'x' },
            ],
        }),
    },
    [`https://t.me/s/${name}?before=8`]: {
        status: 200,
        body: previewHtml({
            username: name,
            subscribers,
            posts: [
                { id: 7, date: iso(10), views: '2K', text: 'y' },
                { id: 6, date: iso(40), views: '2K', text: 'z' },
            ],
        }),
    },
});

describe('readChannel', () => {
    it('reads two pages, computes the facts and stops when the older page has no more', async () => {
        const result = await readChannel('alpha', { fetch: fakeFetch(channelPages('alpha')), delayMs: 0, now });
        expect(result.status).toBe('ok');
        expect(result.members).toBe(20_000);
        expect(result.pagesFetched).toBe(2);
        expect(result.posts.map((p) => p.id)).toEqual([10, 9, 8, 7, 6]);
        expect(result.metrics.postsPerWeek).toBe(0.93);
        expect(result.metrics.medianViews).toBe(2000);
    });
    it('skips posts of channels outside the member range', async () => {
        const result = await readChannel('alpha', {
            fetch: fakeFetch(channelPages('alpha')),
            minMembers: 50_000,
            delayMs: 0,
            now,
        });
        expect(result.status).toBe('filtered');
        expect(result.pagesFetched).toBe(1);
        expect(result.posts).toEqual([]);
    });
    it('reports a channel without a preview, an unknown name and a person', async () => {
        const pages = {
            'https://t.me/s/nopreview': { status: 200, body: profileCardHtml({ extra: '5 400 subscribers' }) },
            'https://t.me/nopreview': { status: 200, body: profileCardHtml({ extra: '5 400 subscribers' }) },
            'https://t.me/s/ghost': { status: 200, body: notFoundHtml() },
            'https://t.me/ghost': { status: 200, body: notFoundHtml() },
            'https://t.me/s/someone': { status: 200, body: profileCardHtml({ extra: '@someone' }) },
            'https://t.me/someone': { status: 200, body: profileCardHtml({ extra: '@someone' }) },
        };
        const fetch = fakeFetch(pages);
        expect(await readChannel('nopreview', { fetch })).toMatchObject({ status: 'preview_disabled', members: 5400 });
        expect(await readChannel('ghost', { fetch })).toMatchObject({ status: 'not_found' });
        expect(await readChannel('someone', { fetch })).toMatchObject({ status: 'not_a_channel' });
    });
    it('reports blocking and network errors honestly', async () => {
        expect(await readChannel('alpha', { fetch: async () => ({ status: 429, url: '', body: '' }) })).toMatchObject({
            status: 'blocked',
        });
        expect(
            await readChannel('alpha', { fetch: async () => ({ status: 0, url: '', body: '', error: 'ECONNRESET' }) }),
        ).toMatchObject({ status: 'error', statusDetail: 'ECONNRESET' });
    });
});

describe('run', () => {
    const collect = () => {
        const out = [];
        return { out, pushData: async (row) => out.push(row) };
    };

    it('returns a row per channel, flags invalid input, and writes post rows on request', async () => {
        const { out, pushData } = collect();
        const input = readInput({
            channels: ['alpha', 'https://t.me/+secret', 'alpha', 'ghost1'],
            includePosts: true,
            delayBetweenRequestsMs: 0,
            concurrency: 1,
        });
        const pages = {
            ...channelPages('alpha'),
            'https://t.me/s/ghost1': { status: 200, body: notFoundHtml() },
            'https://t.me/ghost1': { status: 200, body: notFoundHtml() },
        };
        const { summary } = await run({ input, pushData, fetch: fakeFetch(pages), now });
        const channels = out.filter((r) => r.recordType === 'channel');
        expect(channels.map((r) => [r.username, r.status])).toEqual([
            [null, 'invalid_input'],
            ['alpha', 'ok'],
            ['ghost1', 'not_found'],
        ]);
        expect(out.filter((r) => r.recordType === 'post')).toHaveLength(5);
        expect(out.filter((r) => r.recordType === 'no_data')).toHaveLength(1);
        expect(summary).toMatchObject({ channelsOk: 1, invalidInputs: 1, stoppedBecause: 'completed' });
    });

    it('filters sampled posts by date and emits per-channel no_data', async () => {
        const { out, pushData } = collect();
        const input = readInput({
            channels: ['alpha', 'ghost1'], sinceDate: '2026-10-27', includePosts: true,
            delayBetweenRequestsMs: 0, concurrency: 1, runLabel: 'telegram-weekly',
        });
        const pages = {
            ...channelPages('alpha'),
            'https://t.me/s/ghost1': { status: 200, body: notFoundHtml() },
            'https://t.me/ghost1': { status: 200, body: notFoundHtml() },
        };
        const { summary } = await run({ input, pushData, fetch: fakeFetch(pages), now });
        expect(out.filter((r) => r.recordType === 'post')).toHaveLength(1);
        expect(out.filter((r) => r.recordType === 'no_data')).toHaveLength(1);
        expect(out.every((r) => r.runLabel === 'telegram-weekly' && r.scrapedAt && r.status)).toBe(true);
        expect(summary).toMatchObject({ dateExcluded: 4, noData: 1, status: 'partial' });
    });
    it('enforces a global maxItems cap across channel and post rows', async () => {
        const { out, pushData } = collect();
        const input = readInput({
            channels: ['alpha', 'bravo'], maxItems: 3, includePosts: true,
            delayBetweenRequestsMs: 0, concurrency: 2,
        });
        const { summary } = await run({ input, pushData, fetch: fakeFetch(channelPages('alpha')), now });
        expect(out).toHaveLength(3);
        expect(out.map((r) => r.recordType)).toEqual(['channel', 'post', 'post']);
        expect(summary).toMatchObject({ status: 'partial', stoppedBecause: 'maxItems', itemsEmitted: 3 });
    });
    it('returns no_matching_posts when sampled posts are older than sinceDate', async () => {
        const { out, pushData } = collect();
        const input = readInput({ channels: ['alpha'], sinceDate: '2026-11-01', delayBetweenRequestsMs: 0 });
        const { summary } = await run({ input, pushData, fetch: fakeFetch(channelPages('alpha')), now });
        expect(out.map((r) => r.recordType)).toEqual(['channel', 'no_data']);
        expect(out[0].status).toBe('no_matching_posts');
        expect(summary).toMatchObject({ noData: 1, dateExcluded: 5 });
    });

    it('follows channels mentioned often enough, one step, and marks where they came from', async () => {
        const { out, pushData } = collect();
        const input = readInput({
            channels: ['alpha'],
            followMentionedChannels: true,
            minMentions: 2,
            delayBetweenRequestsMs: 0,
            concurrency: 1,
        });
        const pages = {
            ...channelPages('alpha', { mentions: '@beta_channel @rare_one' }),
            ...channelPages('beta_channel', { mentions: '@gamma_chan' }),
        };
        // rare_one is mentioned in 2 posts as well, so it is followed too; it does not exist
        pages['https://t.me/s/rare_one'] = { status: 200, body: notFoundHtml() };
        pages['https://t.me/rare_one'] = { status: 200, body: notFoundHtml() };
        await run({ input, pushData, fetch: fakeFetch(pages), now });
        const rows = out.filter((r) => r.recordType === 'channel');
        expect(rows.map((r) => [r.username, r.discoveredFrom, r.status])).toEqual([
            ['alpha', null, 'ok'],
            ['beta_channel', 'alpha', 'ok'],
            ['rare_one', 'alpha', 'not_found'],
        ]);
        // gamma_chan is a second-step mention: not followed
        expect(rows.some((r) => r.username === 'gamma_chan')).toBe(false);
    });

    it('stops at maxChannels and says how many were not reached', async () => {
        const { out, pushData } = collect();
        const input = readInput({
            channels: ['alpha', 'bravo', 'charlie'],
            maxChannels: 1,
            concurrency: 1,
            delayBetweenRequestsMs: 0,
        });
        const { summary } = await run({ input, pushData, fetch: fakeFetch(channelPages('alpha')), now });
        expect(out.filter((r) => r.recordType === 'channel')).toHaveLength(1);
        expect(summary).toMatchObject({ stoppedBecause: 'maxChannels', channelsNotReached: 2 });
    });
});

describe('readInput', () => {
    it('requires channels and sane numbers', () => {
        expect(() => readInput({})).toThrow(/channels/);
        expect(() => readInput({ channels: ['a'], maxPostsPerChannel: 0 })).toThrow(/maxPostsPerChannel/);
        expect(readInput({ channels: ['alpha'] })).toMatchObject({ maxPostsPerChannel: 100, windowDays: 30 });
        expect(() => readInput({ channels: ['alpha'], sinceDate: '2026-02-30' })).toThrow(/sinceDate/);
        expect(() => readInput({ channels: ['alpha'], maxItems: 0 })).toThrow(/maxItems/);
    });
});
