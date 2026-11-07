import { describe, expect, it } from 'vitest';

import { groupsOf, readInput, run } from '../src/main.js';
import { exploreRequest, findWidgets, parseTrendsJson, relatedFrom, summarise } from '../src/trends.js';

const wrap = (o) => `)]}',\n${JSON.stringify(o)}`;
const t = (day) => String(Date.UTC(2026, 0, day) / 1000);
const timeline = [10, 20, 30, 60, 80, 100].map((v, i) => ({ time: t(i + 1), value: [v, 0], isPartial: false }));

describe('parsing', () => {
    it("strips the )]}' prefix", () => {
        expect(parseTrendsJson(wrap({ a: 1 }))).toEqual({ a: 1 });
    });
    it('builds the request and finds widgets', () => {
        expect(exploreRequest({ keywords: ['a', 'b'], geo: 'AE', time: 'today 12-m' }).comparisonItem).toHaveLength(2);
        const w = findWidgets(
            {
                widgets: [
                    { id: 'TIMESERIES', token: 't' },
                    { id: 'RELATED_QUERIES_0', token: 'r0' },
                    { id: 'RELATED_QUERIES_1', token: 'r1' },
                ],
            },
            2,
        );
        expect(w.timeseries.token).toBe('t');
        expect(w.related.map((x) => x.token)).toEqual(['r0', 'r1']);
    });
    it('summarises a rising series and an empty one', () => {
        const s = summarise(timeline, 0);
        expect(s).toMatchObject({ hasData: true, peak: 100, latest: 100, trend: 'rising', peakDate: '2026-01-06' });
        expect(s.trendPct).toBeGreaterThan(100);
        expect(summarise(timeline, 1)).toMatchObject({ hasData: false, average: 0, trend: null });
    });
    it('reads related queries', () => {
        const json = {
            default: {
                rankedList: [
                    { rankedKeyword: [{ query: 'igcse past papers', value: 100, formattedValue: '100' }] },
                    { rankedKeyword: [{ query: 'igcse 2026', value: 5000, formattedValue: 'Breakout' }] },
                ],
            },
        };
        expect(relatedFrom(json)).toEqual([
            { type: 'top', query: 'igcse past papers', value: '100' },
            { type: 'rising', query: 'igcse 2026', value: 'Breakout' },
        ]);
    });
});

describe('input and run', () => {
    it('validates input and groups keywords', () => {
        expect(() => readInput({})).toThrow(/keyword/);
        expect(() => readInput({ keywords: ['a'], geos: ['Dubai'] })).toThrow(/country code/);
        expect(() => readInput({ keywords: ['a'], timeRange: 'last year' })).toThrow(/timeRange/);
        expect(groupsOf(['a', 'b', 'c', 'd', 'e', 'f'], true).map((g) => g.length)).toEqual([5, 1]);
        expect(groupsOf(['a', 'b'], false)).toEqual([['a'], ['b']]);
        expect(() => readInput({ keywords: ['a'], maxItems: 0 })).toThrow(/maxItems/);
        expect(() => readInput({ keywords: ['a'], sinceDate: '2026-02-30' })).toThrow(/sinceDate/);
    });

    const get =
        (log = []) =>
        async (url) => {
            log.push(url);
            if (url.includes('/explore?'))
                return {
                    status: 200,
                    body: wrap({
                        widgets: [
                            { id: 'TIMESERIES', token: 'T', request: {} },
                            { id: 'RELATED_QUERIES_0', token: 'R', request: {} },
                        ],
                    }),
                };
            if (url.includes('multiline')) return { status: 200, body: wrap({ default: { timelineData: timeline } }) };
            return {
                status: 200,
                body: wrap({
                    default: {
                        rankedList: [
                            { rankedKeyword: [{ query: 'q1', value: 100, formattedValue: '100' }] },
                            { rankedKeyword: [] },
                        ],
                    },
                }),
            };
        };

    it('returns an interest row, timeline rows and related queries per keyword and country', async () => {
        const rows = [];
        const input = readInput({
            keywords: ['igcse'],
            geos: ['AE', 'SA'],
            includeTimeline: true,
            delayBetweenRequestsMs: 0,
        });
        const summary = await run({ input, pushData: async (r) => void rows.push(r), get: get() });
        expect(rows.filter((r) => r.recordType === 'interest').map((r) => [r.geo, r.status, r.trend])).toEqual([
            ['AE', 'ok', 'rising'],
            ['SA', 'ok', 'rising'],
        ]);
        expect(rows.filter((r) => r.recordType === 'timeline')).toHaveLength(12);
        expect(rows.filter((r) => r.recordType === 'relatedQuery')).toHaveLength(2);
        expect(rows.every((r) => r.scrapedAt && r.status)).toBe(true);
        expect(summary.failed).toBe(0);
    });

    it('filters timeline points by sinceDate and recomputes the interest summary', async () => {
        const rows = [];
        const input = readInput({
            keywords: ['igcse'], geos: ['AE'], sinceDate: '2026-01-04',
            includeTimeline: true, includeRelatedQueries: false, delayBetweenRequestsMs: 0, runLabel: 'weekly',
        });
        const summary = await run({ input, pushData: async (r) => void rows.push(r), get: get() });
        expect(rows.filter((r) => r.recordType === 'timeline')).toHaveLength(3);
        expect(rows[0]).toMatchObject({ recordType: 'interest', latest: 100, dataPoints: 3, runLabel: 'weekly' });
        expect(rows.every((r) => r.sourceUrl && r.scrapedAt && r.status)).toBe(true);
        expect(summary).toMatchObject({ dateExcluded: 3, rows: 4, status: 'completed' });
    });
    it('honors maxItems across all row types and stops before another request', async () => {
        const rows = [];
        const requests = [];
        const input = readInput({
            keywords: ['igcse', 'sat'], geos: ['AE'], includeTimeline: true,
            includeRelatedQueries: false, maxItems: 2, delayBetweenRequestsMs: 0,
        });
        const summary = await run({ input, pushData: async (r) => void rows.push(r), get: get(requests) });
        expect(rows).toHaveLength(2);
        expect(summary).toMatchObject({ rows: 2, stoppedBecause: 'maxItems', status: 'partial' });
        expect(requests).toHaveLength(2);
    });
    it('reports no_data when sinceDate excludes all timeline points', async () => {
        const rows = [];
        const input = readInput({
            keywords: ['igcse'], sinceDate: '2026-02-01', includeRelatedQueries: false, delayBetweenRequestsMs: 0,
        });
        const summary = await run({ input, pushData: async (r) => void rows.push(r), get: get() });
        expect(rows[0]).toMatchObject({ recordType: 'interest', status: 'no_data' });
        expect(summary).toMatchObject({ noData: 1, dateExcluded: 6 });
    });

    it('reports a rate limit instead of failing the run', async () => {
        const rows = [];
        const input = readInput({ keywords: ['igcse'], delayBetweenRequestsMs: 0 });
        const summary = await run({
            input,
            pushData: async (r) => void rows.push(r),
            get: async () => ({ status: 429, body: '' }),
            backoffMs: 0,
        });
        expect(rows).toMatchObject([{ recordType: 'interest', status: 'rate_limited' }]);
        expect(summary.failed).toBe(1);
    });
});
