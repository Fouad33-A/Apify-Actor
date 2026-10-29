import { describe, expect, it } from 'vitest';

import { checkFilters, creatorRow, orderCandidates, readInput, runSearch } from '../src/main.js';
import { parseSerpHtml } from '../src/serp.js';

const block = (handle, hint = '') =>
    `<div class="g"><a href="/url?q=${encodeURIComponent(`https://www.tiktok.com/@${handle}`)}"><h3>${handle} (@${handle})</h3></a><span>TikTok · ${handle} ${hint}</span></div>`;
const serpFetch = async () =>
    parseSerpHtml(
        `<html><head><title>t</title></head><body>${block('small_one', '2K Followers')}${block('mid_one', '50K Followers')}${block('big_one', '5M Followers')}${block('ghost_one')}</body></html>`,
    );

const profiles = new Map([
    ['small_one', { rowType: 'profile', username: 'small_one', status: 'ok', followers: 2000, likes: 10, emails: [] }],
    [
        'mid_one',
        {
            rowType: 'profile',
            username: 'mid_one',
            status: 'ok',
            followers: 50_000,
            likes: 900,
            videos: 40,
            emails: ['hi@mid.com'],
            bio: 'hello',
            bioLink: 'https://mid.com',
        },
    ],
    ['big_one', { rowType: 'profile', username: 'big_one', status: 'ok', followers: 5_000_000, emails: [] }],
]);

describe('readInput', () => {
    it('needs a keyword or hashtag, normalises hashtags and checks the range', () => {
        expect(() => readInput({})).toThrow(/keyword/);
        expect(readInput({ keywords: ['a b'], hashtags: ['#saving', 'budget'] }).searches).toEqual([
            'a b',
            '#saving',
            '#budget',
        ]);
        expect(() => readInput({ keywords: ['x'], minFollowers: 10, maxFollowers: 5 })).toThrow(/minFollowers/);
    });
});

describe('orderCandidates / checkFilters / creatorRow', () => {
    it('puts hints inside the range first and outside last', () => {
        const c = (handle, hint) => ({ handle, hint, profileHit: false, timesSeen: 1 });
        const out = orderCandidates([c('big', '5M'), c('none', null), c('ok', '50K')], {
            minFollowers: 10_000,
            maxFollowers: 150_000,
        });
        expect(out.map((x) => x.handle)).toEqual(['ok', 'none', 'big']);
    });
    it('judges only when followers are known', () => {
        expect(checkFilters({ followers: null }, { minFollowers: 1 })).toEqual({ passes: null, failures: [] });
        expect(checkFilters({ followers: 5 }, { minFollowers: 10, maxFollowers: 20 }).failures).toEqual([
            'followers 5 below 10',
        ]);
        expect(checkFilters({ followers: 15 }, { minFollowers: 10, maxFollowers: 20 }).passes).toBe(true);
    });
    it('keeps nulls for what was not enriched', () => {
        const row = creatorRow(
            { handle: 'x', queries: ['q'], timesSeen: 1, profileHit: false, snippets: [], videoUrls: [], hint: null },
            null,
            'enrichProfiles is off',
        );
        expect(row).toMatchObject({
            enriched: false,
            followers: null,
            emails: [],
            foundVia: 'video',
            enrichNote: 'enrichProfiles is off',
        });
    });
});

describe('run', () => {
    const collect = () => {
        const out = [];
        return { out, pushData: async (r) => out.push(r) };
    };

    it('searches, enriches through the profile Actor and marks who is inside the follower range', async () => {
        const { out, pushData } = collect();
        const calls = [];
        const enrich = async (actor, names) => {
            calls.push([actor, names]);
            return new Map(names.filter((n) => profiles.has(n)).map((n) => [n, profiles.get(n)]));
        };
        const input = readInput({
            keywords: ['budgeting'],
            minFollowers: 10_000,
            maxFollowers: 150_000,
            maxSearchPages: 1,
        });
        const summary = await runSearch({ input, pushData, serpProxyUrl: 'http://x', serpFetch, enrich });
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('fouad_dp/tiktok-profile-video-stats');
        const byHandle = Object.fromEntries(out.map((r) => [r.handle, r]));
        expect(byHandle.mid_one).toMatchObject({
            followers: 50_000,
            passesFilters: true,
            emails: ['hi@mid.com'],
            enriched: true,
        });
        expect(byHandle.small_one.passesFilters).toBe(false);
        expect(byHandle.big_one.filterFailures[0]).toMatch(/above 150000/);
        expect(byHandle.ghost_one).toMatchObject({ enriched: false, passesFilters: null });
        expect(byHandle.ghost_one.enrichNote).toMatch(/returned no row/);
        expect(summary).toMatchObject({ handlesFound: 4, returned: 4, passing: 1, outOfRange: 2, unenriched: 1 });
    });

    it('returns only creators in range when asked, and keeps going when enrichment fails', async () => {
        const a = collect();
        await runSearch({
            input: readInput({ keywords: ['b1'], onlyPassing: true, minFollowers: 10_000, maxSearchPages: 1 }),
            pushData: a.pushData,
            serpProxyUrl: 'http://x',
            serpFetch,
            enrich: async (_, names) => new Map(names.filter((n) => profiles.has(n)).map((n) => [n, profiles.get(n)])),
        });
        expect(a.out.map((r) => r.handle).sort()).toEqual(['big_one', 'mid_one']);

        const b = collect();
        const summary = await runSearch({
            input: readInput({ keywords: ['b1'], maxSearchPages: 1 }),
            pushData: b.pushData,
            serpProxyUrl: 'http://x',
            serpFetch,
            enrich: async () => {
                throw new Error('Actor not found');
            },
        });
        expect(b.out).toHaveLength(4);
        expect(
            b.out.every((r) => r.enriched === false && /Profile enrichment failed: Actor not found/.test(r.enrichNote)),
        ).toBe(true);
        expect(summary.enrichNote).toMatch(/Actor not found/);
    });

    it('does not call the profile Actor when enrichment is off, and respects maxCreators', async () => {
        const { out, pushData } = collect();
        let called = false;
        await runSearch({
            input: readInput({ keywords: ['b1'], enrichProfiles: false, maxCreators: 2, maxSearchPages: 1 }),
            pushData,
            serpProxyUrl: 'http://x',
            serpFetch,
            enrich: async () => {
                called = true;
                return new Map();
            },
        });
        expect(called).toBe(false);
        expect(out).toHaveLength(2);
        expect(out[0].enrichNote).toBe('enrichProfiles is off');
    });
});
