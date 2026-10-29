import { describe, expect, it } from 'vitest';

import { parseLookup, parseReviewsFeed, readAppleReviews } from '../src/apple.js';
import { parseAppRef } from '../src/apps.js';
import { readPlayReviews } from '../src/play.js';
import { themeSummary } from '../src/rows.js';
import { buildClassifier } from '../src/themes.js';
import { appleFeed } from './fixtures.js';

describe('parseAppRef', () => {
    it.each([
        ['https://apps.apple.com/us/app/spotify/id324684580', { store: 'apple', appId: '324684580', country: 'us' }],
        ['https://apps.apple.com/gb/app/id324684580', { store: 'apple', appId: '324684580', country: 'gb' }],
        ['324684580', { store: 'apple', appId: '324684580', country: null }],
        ['id324684580', { store: 'apple', appId: '324684580', country: null }],
        ['com.spotify.music', { store: 'google', appId: 'com.spotify.music' }],
        [
            'https://play.google.com/store/apps/details?id=com.spotify.music&hl=en',
            { store: 'google', appId: 'com.spotify.music' },
        ],
    ])('%s', (input, expected) => {
        expect(parseAppRef(input)).toEqual(expected);
    });
    it('rejects what is neither', () => {
        expect(parseAppRef('spotify').error).toBeTruthy();
        expect(parseAppRef('').error).toBeTruthy();
    });
});

describe('parseReviewsFeed', () => {
    it('skips the app entry and reads the reviews', () => {
        const json = appleFeed({
            reviews: [
                {
                    id: 1,
                    rating: 1,
                    title: 'Crashes',
                    text: 'It keeps crashing on launch',
                    date: '2026-10-01T10:00:00-07:00',
                    votes: 4,
                },
            ],
        });
        const { reviews, lastPage } = parseReviewsFeed(json);
        expect(lastPage).toBe(2);
        expect(reviews).toEqual([
            {
                reviewId: '1',
                rating: 1,
                title: 'Crashes',
                text: 'It keeps crashing on launch',
                author: 'someone',
                date: '2026-10-01T17:00:00.000Z',
                version: '1.0',
                helpfulVotes: 4,
                totalVotes: 4,
            },
        ]);
    });
    it('copes with a feed that has no reviews', () => {
        expect(parseReviewsFeed({ feed: {} }).reviews).toEqual([]);
        expect(parseReviewsFeed(null).reviews).toEqual([]);
    });
});

describe('parseLookup', () => {
    it('maps the lookup fields', () => {
        expect(
            parseLookup({
                results: [{ trackId: 5, trackName: 'X', sellerName: 'Y', averageUserRating: 4.5, userRatingCount: 10 }],
            }),
        ).toMatchObject({ appId: '5', name: 'X', developer: 'Y', averageRating: 4.5, ratingCount: 10 });
        expect(parseLookup({ results: [] })).toBeNull();
    });
});

describe('readAppleReviews', () => {
    const pages = {
        1: appleFeed({
            page: 1,
            reviews: [
                { id: 1, rating: 5, text: 'Great app I love it', date: '2026-10-01T00:00:00Z' },
                { id: 2, rating: 1, text: 'Constantly crashing, useless', date: '2026-09-30T00:00:00Z' },
            ],
        }),
        2: appleFeed({
            page: 2,
            reviews: [{ id: 3, rating: 2, text: 'Too many ads everywhere', date: '2026-09-29T00:00:00Z' }],
        }),
    };
    const get = async (url) => {
        const page = Number(/page=(\d+)/.exec(url)[1]);
        return pages[page] ? { status: 200, json: pages[page] } : { status: 404, json: null };
    };
    it('reads pages until the last one and keeps only accepted reviews', async () => {
        const res = await readAppleReviews('111111', 'us', { get, delayMs: 0, accept: (r) => r.rating <= 2 });
        expect(res.reviews.map((r) => r.reviewId)).toEqual(['2', '3']);
        expect(res.reviewsRead).toBe(3);
        expect(res.pages).toBe(2);
    });
    it('stops at the review cap', async () => {
        const res = await readAppleReviews('111111', 'us', {
            get,
            delayMs: 0,
            maxReviews: 1,
            accept: (r) => r.rating <= 2,
        });
        expect(res.reviews.map((r) => r.reviewId)).toEqual(['2']);
        expect(res.pages).toBe(1);
    });
    it('says so when Apple has no feed', async () => {
        const res = await readAppleReviews('1', 'zz', { get: async () => ({ status: 404, json: null }), delayMs: 0 });
        expect(res.reviews).toEqual([]);
        expect(res.note).toMatch(/no review feed/);
    });
});

describe('readPlayReviews', () => {
    const fake = (calls) => ({
        sort: { NEWEST: 2 },
        reviews: async (opts) => {
            calls.push(opts);
            const star = opts.stars ?? 0;
            return {
                data: [
                    {
                        id: `r${star}a`,
                        score: star || 5,
                        title: null,
                        text: `Review text number ${star}`,
                        userName: 'u',
                        date: `2026-10-0${star || 9}T00:00:00Z`,
                        thumbsUp: star,
                        version: '2.0',
                    },
                ],
                nextPaginationToken: null,
            };
        },
    });
    it('asks Google Play for each star rating and merges newest first', async () => {
        const calls = [];
        const res = await readPlayReviews('com.x.y', { stars: [1, 2], gplay: fake(calls), maxReviews: 10 });
        expect(calls.map((c) => c.stars)).toEqual([1, 2]);
        expect(res.reviews.map((r) => r.reviewId)).toEqual(['r2a', 'r1a']);
        expect(res.reviews[0]).toMatchObject({ rating: 2, helpfulVotes: 2, version: '2.0', country: 'us' });
    });
    it('reports a failure without throwing', async () => {
        const gplay = {
            sort: { NEWEST: 2 },
            reviews: async () => {
                throw new Error('app not found (404)');
            },
        };
        const res = await readPlayReviews('com.x.y', { stars: [1], gplay });
        expect(res.reviews).toEqual([]);
        expect(res.note).toMatch(/app not found/);
    });
});

describe('themes', () => {
    const classify = buildClassifier({ sync: ['out of sync'], ads: ['sponsored junk'] });
    const themes = (text) => classify(text).map((h) => h.theme);
    it('matches whole words and phrases, several themes per review', () => {
        expect(themes('It crashes every time and customer service never replied')).toEqual(['crashes_bugs', 'support']);
        expect(themes('Charged twice, want a refund')).toEqual(['billing_subscription']);
        expect(themes('Way too many ads and popups')).toEqual(['ads']);
    });
    it('does not match inside other words', () => {
        expect(themes('The pass was a bad one')).toEqual([]); // no "ads", "bug", "lag" inside words
        expect(themes('Loved the gradient adsorb')).toEqual([]);
    });
    it('handles typographic apostrophes and custom themes', () => {
        expect(themes('It doesn’t work at all')).toEqual(['crashes_bugs']);
        expect(themes('Always out of sync, plus sponsored junk')).toEqual(['ads', 'sync']);
    });
});

describe('themeSummary', () => {
    it('counts, ranks and quotes the most helpful reviews', () => {
        const classify = buildClassifier();
        const mk = (id, text, helpfulVotes) => {
            const review = { reviewId: id, rating: 1, title: 'T', text, date: '2026-10-01', helpfulVotes };
            return { review, hits: classify(text) };
        };
        const rows = [
            mk('1', 'crashes constantly', 1),
            mk('2', 'crashes on start', 9),
            mk('3', 'too many ads', 0),
            mk('4', 'meh', 0),
        ];
        const summary = themeSummary(rows);
        expect(summary[0]).toMatchObject({ theme: 'crashes_bugs', reviews: 2, pctOfKeptReviews: 50 });
        expect(summary[0].examples[0].text).toContain('crashes on start');
        expect(summary[1]).toMatchObject({ theme: 'ads', reviews: 1 });
    });
});
