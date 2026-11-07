import { describe, expect, it } from 'vitest';
import { readInput, run } from '../src/main.js';
import { discoverRedditThreads } from '../src/search.js';

const thread = (id, updated) => ({ id: `t3_${id}`, title: 'Test discussion', text: 'exam help', url: `https://www.reddit.com/r/igcse/comments/${id}/test`, author: null, updated, matchedKeywords: ['exam'] });
const blocked = async () => ({ status: 403, body: 'Forbidden' });
async function execute({ sinceDate, fallbackThreads, fallbackStatus = 200 }) {
    const rows = [];
    const input = readInput({ subreddits: ['igcse'], keywords: ['exam'], sinceDate, includeComments: false, maxThreadsPerSubreddit: 10, delayBetweenRequestsMs: 0, maxItems: 30 });
    const summary = await run({ input, pushData: async (row) => rows.push(row), fetch: blocked,
        discover: async () => ({ threads: fallbackThreads, attempts: [{ source: 'public_search', status: fallbackStatus, page: 0, found: fallbackThreads.length, added: fallbackThreads.length }], rateLimited: fallbackStatus === 429 }),
        backoffMs: 0 });
    return { rows, summary };
}
describe('public-search date and status handling', () => {
    it('keeps only records on or after sinceDate and rejects undated records', async () => {
        const { rows } = await execute({ sinceDate: '2026-10-01', fallbackThreads: [thread('old', '2025-01-25T00:00:00Z'), thread('new', '2026-10-05T00:00:00Z'), thread('unknown', null)] });
        expect(rows.filter((r) => r.recordType === 'thread').map((r) => r.threadId)).toEqual(['new']);
    });
    it('returns no_data when all indexed results are old', async () => {
        const { rows } = await execute({ sinceDate: '2026-10-01', fallbackThreads: [thread('old', '2024-01-01T00:00:00Z')] });
        expect(rows.some((r) => r.recordType === 'thread')).toBe(false);
        expect(rows.find((r) => r.recordType === 'no_data')).toBeTruthy();
    });
    it('reports rate_limited rather than no_data after a failed fallback', async () => {
        const { rows } = await execute({ sinceDate: '2026-10-01', fallbackThreads: [], fallbackStatus: 429 });
        expect(rows.find((r) => r.recordType === 'no_data').status).toBe('rate_limited');
        expect(rows.find((r) => r.recordType === 'subreddit').status).toBe('rate_limited');
    });
});

describe('search discovery filters before limiting', () => {
    it('does not let old search hits displace newer matching threads', async () => {
        const html = (id, date) => `<div><a href="https://www.reddit.com/r/igcse/comments/${id}/sample">Exam discussion</a><span>${date}</span></div>`;
        const body = html('old123', 'January 25, 2025') + html('new123', 'October 20, 2026');
        const result = await discoverRedditThreads({
            subreddit: 'igcse', keywords: ['exam'], maxThreads: 1, maxPages: 1,
            dateFromMs: Date.parse('2026-10-01'), paceMs: 0,
            fetch: async () => ({ status: 200, body }),
        });
        expect(result.threads.map((r) => r.id)).toEqual(['t3_new123']);
    });
});

describe('request accounting', () => {
    it('counts each Brave retry and enforces the shared request limit', async () => {
        const rows = [];
        let braveCalls = 0;
        const input = readInput({ subreddits: ['igcse'], keywords: ['exam'], includeComments: false, maxRequests: 3, delayBetweenRequestsMs: 0, maxItems: 10 });
        const summary = await run({
            input, pushData: async (row) => rows.push(row),
            fetch: async () => ({ status: 403, body: 'Forbidden' }),
            discover: async ({ beforeRequest }) => {
                for (let i = 0; i < 5; i++) { if (!beforeRequest()) break; braveCalls++; }
                return { threads: [], attempts: [{ status: 429, page: 0 }], rateLimited: true };
            },
            backoffMs: 0,
        });
        expect(braveCalls).toBe(2);
        expect(summary.requestsMade).toBe(3);
        expect(summary.stopReason).toBe('request_limit');
        expect(rows.find((r) => r.recordType === 'subreddit').status).toBe('partial');
    });
    it('counts archive requests toward the shared limit', async () => {
        const rows = [];
        const input = readInput({ subreddits: ['igcse'], keywords: ['exam'], includeComments: true, maxThreadsWithComments: 1, maxCommentsPerThread: 2, maxRequests: 3, delayBetweenRequestsMs: 0, maxItems: 10 });
        const summary = await run({
            input, pushData: async (row) => rows.push(row),
            fetch: async () => ({ status: 403, body: 'Forbidden' }),
            discover: async ({ beforeRequest }) => {
                beforeRequest();
                return { threads: [thread('new', '2026-10-05T00:00:00Z')], attempts: [{ status: 200, page: 0 }], rateLimited: false };
            },
            readArchive: async (_id, { beforeRequest }) => {
                expect(beforeRequest()).toBe(true);
                return { status: 'ok', comments: [{ text: 'Thanks', author: 'student', score: 2 }] };
            },
            backoffMs: 0,
        });
        expect(summary.requestsMade).toBe(3);
        expect(summary.stopReason).toBe('request_limit');
        expect(rows.find((r) => r.recordType === 'thread').topComments).toHaveLength(1);
    });
});
