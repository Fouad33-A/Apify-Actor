import { describe, expect, it } from 'vitest';

import { computeReach, median } from '../src/reach.js';

const post = (likes, views = null, over = {}) => ({
    status: 'found',
    likeCount: likes,
    commentCount: 1,
    viewCount: views,
    ...over,
});

describe('median', () => {
    it.each([
        [[3, 1, 2], 2],
        [[4, 1, 3, 2], 2.5],
        [[5], 5],
        [[], null],
        [[NaN, 7, null], 7],
    ])('%j -> %s', (values, expected) => {
        expect(median(values)).toBe(expected);
    });
});

describe('computeReach', () => {
    it('median likes as a percentage of followers (one viral post does not move it)', () => {
        const r = computeReach([post(1000), post(1200), post(900), post(50_000), post(1100)], 50_000);
        expect(r).toMatchObject({
            postsSampled: 5,
            medianLikes: 1100,
            likesPctOfFollowers: 2.2,
            viewsPctOfFollowers: null,
            reachPctOfFollowers: 2.2,
            reachBasis: 'median likes of the sampled posts / followers',
        });
    });

    it('prefers views when at least 3 posts show them', () => {
        const r = computeReach([post(100, 5000), post(120, 4000), post(90, 6000), post(80)], 10_000);
        expect(r).toMatchObject({ medianViews: 5000, viewsPctOfFollowers: 50, reachPctOfFollowers: 50 });
        expect(r.reachBasis).toMatch(/views/);
    });

    it('falls back to likes when fewer than 3 posts have views', () => {
        const r = computeReach([post(100, 5000), post(120, 4000), post(90)], 10_000);
        expect(r.viewsPctOfFollowers).toBeNull();
        expect(r.reachPctOfFollowers).toBe(1);
    });

    it('needs at least 3 posts with the number: fewer gives null, never a guess', () => {
        const r = computeReach([post(100), post(120)], 1000);
        expect(r).toMatchObject({ postsSampled: 2, medianLikes: null, reachPctOfFollowers: null, reachBasis: null });
    });

    it('hidden likes (null) are not counted as zero', () => {
        const r = computeReach([post(null), post(null), post(null), post(200)], 1000);
        expect(r.medianLikes).toBeNull();
    });

    it('posts that were not read (blocked, error) are ignored', () => {
        const r = computeReach([post(100), post(100), post(100), post(999_999, null, { status: 'blocked' })], 1000);
        expect(r).toMatchObject({ postsSampled: 3, medianLikes: 100, likesPctOfFollowers: 10 });
    });

    it('unknown or zero followers: counts stay, percentages are null', () => {
        const r = computeReach([post(100), post(100), post(100)], 0);
        expect(r).toMatchObject({ medianLikes: 100, likesPctOfFollowers: null, reachPctOfFollowers: null });
        expect(computeReach([], 100).postsSampled).toBe(0);
    });
});
