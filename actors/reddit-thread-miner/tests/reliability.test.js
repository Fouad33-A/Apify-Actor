import { describe, expect, it } from 'vitest';
import { readInput, run } from '../src/main.js';

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
