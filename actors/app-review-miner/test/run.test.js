import { describe, expect, it } from 'vitest';

import { makeAccept, readInput, run } from '../src/main.js';

const now = Date.parse('2026-10-29T00:00:00Z');
const collect = () => {
    const out = [];
    return { out, pushData: async (row) => out.push(row) };
};

const appleStub = {
    lookupApp: async (id) => ({ status: 200, app: { appId: id, name: 'Rival Notes', developer: 'Rival Inc', averageRating: 3.1, ratingCount: 900, url: 'https://apps.apple.com/x' } }),
    searchApps: async (term) => ({ apps: [{ appId: '222222', name: `${term} app` }] }),
    readAppleReviews: async (id, country, { accept }) => {
        const all = [
            { reviewId: 'a1', rating: 1, title: 'Crash', text: 'Crashes all the time, and support never replied', date: '2026-10-20T00:00:00.000Z', helpfulVotes: 3 },
            { reviewId: 'a2', rating: 5, title: 'Love', text: 'Best app ever, five stars from me', date: '2026-10-21T00:00:00.000Z', helpfulVotes: 0 },
            { reviewId: 'a3', rating: 2, title: 'Meh', text: 'Nothing special about it at all', date: '2026-10-22T00:00:00.000Z', helpfulVotes: 0 },
        ];
        return { reviews: all.filter(accept), reviewsRead: all.length, pages: 1, note: null };
    },
};
const playStub = {
    lookupPlayApp: async (id) => ({ appId: id, name: 'Rival Notes', developer: 'Rival Inc', averageRating: 3.4, ratingCount: 5000, url: 'https://play.google.com/x' }),
    searchPlayApps: async () => [{ appId: 'com.rival.notes' }],
    readPlayReviews: async (id, { stars, accept }) => {
        expect(stars).toEqual([1, 2]);
        const all = [{ reviewId: 'g1', rating: 1, title: null, text: 'Charged twice, I want a refund now', date: '2026-10-25T00:00:00.000Z', helpfulVotes: 7 }];
        return { reviews: all.filter(accept), reviewsRead: 40, note: null };
    },
};

describe('readInput', () => {
    it('needs apps or keywords, countries and valid store/rating values', () => {
        expect(() => readInput({})).toThrow(/at least one app/);
        expect(() => readInput({ apps: ['x'], countries: ['usa'] })).toThrow(/countries/);
        expect(() => readInput({ apps: ['x'], maxRating: 6 })).toThrow(/maxRating/);
        expect(() => readInput({ searchKeywords: ['x'], searchStores: ['other'] })).toThrow(/searchStores/);
        expect(readInput({ apps: ['x'] })).toMatchObject({ countries: ['us'], maxRating: 2 });
    });
});

describe('makeAccept', () => {
    const base = { maxRating: 2, minReviewLength: 15 };
    it('filters by rating, length, date and keyword', () => {
        const ok = { rating: 1, title: 'Bad', text: 'Crashes a lot lately', date: '2026-10-20T00:00:00Z' };
        expect(makeAccept(base, now)(ok)).toBe(true);
        expect(makeAccept(base, now)({ ...ok, rating: 4 })).toBe(false);
        expect(makeAccept(base, now)({ ...ok, text: 'bad', title: '' })).toBe(false);
        expect(makeAccept({ ...base, recentDays: 3 }, now)(ok)).toBe(false);
        expect(makeAccept({ ...base, keywords: ['refund'] }, now)(ok)).toBe(false);
        expect(makeAccept({ ...base, keywords: ['crash'] }, now)(ok)).toBe(true);
    });
});

describe('run', () => {
    it('mines both stores, classifies complaints and writes review and app rows', async () => {
        const { out, pushData } = collect();
        const input = readInput({ apps: ['https://apps.apple.com/us/app/rival/id111111', 'com.rival.notes', 'not an app'] });
        const summary = await run({ input, pushData, apple: appleStub, play: playStub, now });
        const reviews = out.filter((r) => r.recordType === 'review');
        expect(reviews.map((r) => [r.store, r.reviewId, r.themes])).toEqual([
            ['apple', 'a1', ['crashes_bugs', 'support']],
            ['apple', 'a3', []],
            ['google', 'g1', ['billing_subscription']],
        ]);
        const apps = out.filter((r) => r.recordType === 'app');
        expect(apps.map((a) => [a.store ?? null, a.status, a.reviewsRead ?? null, a.reviewsKept ?? null])).toEqual([
            [null, 'invalid_input', null, null], ['apple', 'ok', 3, 2], ['google', 'ok', 40, 1],
        ]);
        expect(summary).toMatchObject({ appsRead: 2, reviewRows: 3, stoppedBecause: 'completed' });
    });

    it('finds apps by keyword and honours maxReviewRows', async () => {
        const { out, pushData } = collect();
        const input = readInput({ searchKeywords: ['notes'], searchStores: ['apple'], countries: ['us', 'gb'], maxReviewRows: 1 });
        const summary = await run({ input, pushData, apple: appleStub, play: playStub, now });
        expect(out.filter((r) => r.recordType === 'app')).toHaveLength(1);
        expect(summary.stoppedBecause).toBe('maxReviewRows');
    });

    it('enforces maxAppsPerSearch and keeps Apple and Google targets distinct', async () => {
        const { out, pushData } = collect();
        const noisyApple = { ...appleStub, searchApps: async () => ({ apps: [{ appId: '111111' }, { appId: '222222' }] }) };
        const noisyPlay = { ...playStub, searchPlayApps: async () => [{ appId: 'com.one.app' }, { appId: 'com.two.app' }] };
        const input = readInput({ searchKeywords: ['notes'], searchStores: ['apple', 'google'], maxAppsPerSearch: 1, maxReviewsPerApp: 1, maxReviewRows: 10 }); // the fake Apple reader ignores the review budget, so leave room for its rows
        const summary = await run({ input, pushData, apple: noisyApple, play: noisyPlay, now });
        expect(out.filter((r) => r.recordType === 'app').map((r) => [r.store, r.appId])).toEqual([
            ['apple', '111111'], ['google', 'com.one.app'],
        ]);
        expect(summary).toMatchObject({ appsRead: 2, targets: 2 });
    });

    it('isolates keyword-search failures by store', async () => {
        const { out, pushData } = collect();
        const failingApple = { ...appleStub, searchApps: async () => { throw new Error('Apple search down'); } };
        const input = readInput({ searchKeywords: ['notes'], searchStores: ['apple', 'google'], maxAppsPerSearch: 1 });
        const summary = await run({ input, pushData, apple: failingApple, play: playStub, now });
        expect(out.filter((r) => r.recordType === 'app').map((r) => r.store)).toEqual(['google']);
        expect(summary.problems).toEqual([{ input: 'notes', store: 'apple', problem: 'search failed: Apple search down' }]);
    });

    it('reports a store failure on the app row instead of stopping the run', async () => {
        const { out, pushData } = collect();
        const input = readInput({ apps: ['com.gone.app', 'com.rival.notes'] });
        const failing = { ...playStub, lookupPlayApp: async (id) => { if (id === 'com.gone.app') throw new Error('App not found (404)'); return playStub.lookupPlayApp(id); } };
        await run({ input, pushData, apple: appleStub, play: failing, now });
        expect(out.filter((r) => r.recordType === 'app').map((a) => [a.appId, a.status])).toEqual([
            ['com.gone.app', 'not_found'], ['com.rival.notes', 'ok'],
        ]);
    });

    it('can return summaries only without treating analyzed reviews as emitted review rows', async () => {
        const { out, pushData } = collect();
        const input = readInput({ apps: ['111111', '222222'], includeReviews: false, maxReviewRows: 1 });
        const summary = await run({ input, pushData, apple: appleStub, play: playStub, now });
        expect(out.every((r) => r.recordType === 'app')).toBe(true);
        expect(out).toHaveLength(2);
        expect(out[0].themeCounts.map((t) => t.theme)).toEqual(['crashes_bugs', 'support']);
        expect(out[0].reviewsKept).toBe(2);
        expect(summary).toMatchObject({ appsRead: 2, reviewRows: 0, stoppedBecause: 'completed' });
    });
});
