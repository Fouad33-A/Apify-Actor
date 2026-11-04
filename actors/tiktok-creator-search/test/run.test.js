import { describe, expect, it } from 'vitest';

import { checkFilters, creatorRow, orderCandidates, readInput, runSearch } from '../src/main.js';
import { parseSerpHtml } from '../src/serp.js';

const block = (handle, hint = '') =>
    `<div class="g"><a href="/url?q=${encodeURIComponent(`https://www.tiktok.com/@${handle}`)}"><h3>${handle} (@${handle})</h3></a><span>TikTok · ${handle} ${hint}</span></div>`;
const serpFetch = async () =>
    parseSerpHtml(`<html><head><title>t</title></head><body>${block('small_one', '2K Followers')}${block('mid_one', '50K Followers')}${block('big_one', '5M Followers')}${block('ghost_one')}</body></html>`);

const profile = (handle, overrides = {}) => [handle, {
    rowType: 'profile', username: handle, status: 'ok', followers: 50_000,
    verified: false, daysSinceLastPost: 1, medianPlays: 8_000,
    emails: [], ...overrides,
}];
const profiles = new Map([
    profile('small_one', { followers: 2_000 }),
    profile('mid_one', { emails: ['hi@mid.com'], bio: 'hello', bioLink: 'https://mid.com' }),
    profile('big_one', { followers: 5_000_000 }),
]);

const collect = () => {
    const out = [];
    return { out, pushData: async (row) => { out.push(row); } };
};
const run = async (extra = {}, enrich = async (_, names) =>
    new Map(names.filter((name) => profiles.has(name)).map((name) => [name, profiles.get(name)]))) => {
    const collected = collect();
    const input = readInput({ keywords: ['budgeting'], maxSearchPages: 1, ...extra });
    const summary = await runSearch({
        input, ...collected, serpProxyUrl: 'http://x', serpFetch, enrich,
    });
    return { ...collected, summary };
};

describe('readInput and candidate ranking', () => {
    it('supports criteria-only and normalizes hashtag-first searches', () => {
        expect(readInput({}).criteriaOnly).toBe(true);
        expect(readInput({ keywords: ['a b'], hashtags: ['#saving', 'budget'] }).searches)
            .toEqual(['#saving', '#budget', 'a b']);
        expect(() => readInput({ keywords: ['x'], minFollowers: 10, maxFollowers: 5 })).toThrow(/minFollowers/);
    });

    it('normalizes previously qualified handles supplied for history backfill', () => {
        const input = readInput({ knownHandles: ['@Suarezz_XO', 'emely_d', '@suarezz_xo'] });
        expect(input.knownHandles).toEqual(['suarezz_xo', 'emely_d']);
        expect(input.criteriaOnly).toBe(true);
    });

    it('prioritizes candidates with hints inside the range', () => {
        const candidate = (handle, hint) => ({ handle, hint, profileHit: false, timesSeen: 1 });
        const sorted = orderCandidates([
            candidate('big', '5M'), candidate('none', null), candidate('ok', '50K'),
        ], { minFollowers: 10_000, maxFollowers: 150_000 });
        expect(sorted.map((row) => row.handle)).toEqual(['ok', 'none', 'big']);
    });

    it('retains unknown enrichment fields and reports the failure', () => {
        const row = creatorRow({
            handle: 'x', queries: ['q'], timesSeen: 1, profileHit: false,
            snippets: [], videoUrls: [], hint: null,
        }, null, 'enrichProfiles is off');
        expect(row).toMatchObject({
            enriched: false, enrichStatus: 'failed', followers: null,
            emails: [], foundVia: 'video', enrichNote: 'enrichProfiles is off',
        });
    });
});

describe('creator filtering', () => {
    const filters = {
        minFollowers: 10_000, maxFollowers: 150_000, minMedianViews: 5_000,
        maxDaysSinceLastPost: 7, excludeVerified: true,
    };
    const passing = {
        followers: 50_000, medianViews: 8_000, daysSinceLastPost: 1,
        verified: false, profileStatus: 'ok',
    };

    it('accepts complete metrics and rejects out-of-range metrics', () => {
        expect(checkFilters(passing, filters).passes).toBe(true);
        expect(checkFilters({ ...passing, followers: 5_000 }, filters).passes).toBe(false);
        expect(checkFilters({ ...passing, medianViews: 2_000 }, filters).passes).toBe(false);
        expect(checkFilters({ ...passing, verified: true }, filters).passes).toBe(false);
    });

    it('does not silently pass unknown activity, verification or profile status', () => {
        expect(checkFilters({ ...passing, daysSinceLastPost: null }, filters).passes).toBeNull();
        expect(checkFilters({ ...passing, verified: null }, filters).passes).toBeNull();
        expect(checkFilters({ ...passing, profileStatus: 'failed' }, filters).passes).toBeNull();
    });
});

describe('runSearch', () => {
    it('emits only confirmed passing creators by default, and always writes a summary', async () => {
        const { out, summary } = await run({
            minFollowers: 10_000, maxFollowers: 150_000, minMedianViews: 5_000,
        });
        expect(out.filter((row) => row.recordType === 'creator').map((row) => row.handle))
            .toEqual(['mid_one']);
        expect(out.at(-1).recordType).toBe('RUN_SUMMARY');
        expect(summary).toMatchObject({ handlesFound: 4, returned: 1, passing: 1, searchVariantsAttempted: 3, searchVariantsPlanned: 3 });
    });

    it('can emit diagnostic creator rows when onlyPassing is disabled', async () => {
        const { out, summary } = await run({
            minFollowers: 10_000, maxFollowers: 150_000,
            onlyPassing: false,
        });
        const rows = out.filter((row) => row.recordType === 'creator');
        expect(rows).toHaveLength(4);
        expect(rows.find((row) => row.handle === 'small_one').passesFilters).toBe(false);
        expect(rows.find((row) => row.handle === 'big_one').passesFilters).toBe(false);
        expect(rows.find((row) => row.handle === 'ghost_one').passesFilters).toBeNull();
        expect(summary.unenriched).toBe(2); // out-of-range hint skip plus missing profile
    });

    it('records child enrichment errors without inventing profile data', async () => {
        const { out, summary } = await run({ onlyPassing: false }, async () => {
            throw new Error('Actor not found');
        });
        expect(out.filter((row) => row.recordType === 'creator')).toHaveLength(4);
        expect(summary.errors).toBeGreaterThan(0);
        expect(summary.enrichNote).toMatch(/Actor not found/);
    });

    it('passes the video and region options to the child Actor', async () => {
        const calls = [];
        const enrich = async (_actor, names, options) => {
            calls.push(options);
            return new Map(names.filter((name) => profiles.has(name)).map((name) => [name, profiles.get(name)]));
        };
        const { out } = await run({
            minMedianViews: 5_000, regions: ['AE'], matchMode: 'only',
            videosForMedian: 5, onlyPassing: false,
        }, enrich);
        expect(calls[0]).toMatchObject({
            medianViews: false, needLatestVideo: false,
        });
        expect(calls[1]).toMatchObject({
            medianViews: true, videosForMedian: 5, needLatestVideo: true,
        });
        expect(out.at(-1).recordType).toBe('RUN_SUMMARY');
    });

    it('finishes a search when the only unprocessed handle is in persistent history', async () => {
        const { summary } = await run({
            knownHandles: ['mid_one'],
            minFollowers: 10_000, maxFollowers: 150_000, minMedianViews: 5_000,
        });
        expect(summary.skippedKnownHandles).toBe(1);
        expect(summary.nextSearchIndex).toBe(1);
        expect(summary.stoppedEarly).toBe(false);
        expect(summary.resumeToken).toBeNull();
    });

    it('resumes from the supplied index and excludes previously handled names', async () => {
        const { summary } = await run({
            resumeToken: { nextSearchIndex: 0, processedHandles: ['mid_one'] },
            minFollowers: 10_000,
        });
        expect(summary.skippedKnownHandles).toBeGreaterThan(0);
        expect(summary.returned).toBe(1); // the previously seen mid_one is excluded; big_one remains eligible
    });
});
