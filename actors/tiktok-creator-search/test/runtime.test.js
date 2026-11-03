import { describe, expect, it } from 'vitest';
import { readInput, checkFilters } from '../src/main.js';
import { buildBraveQuery, buildQuery, CRITERIA_QUERY } from '../src/serp.js';

describe('criteria-only discovery', () => {
    it('does not inject topical keywords when none are given', () => {
        const input = readInput({});
        expect(input.criteriaOnly).toBe(true);
        expect(input.searches).toEqual([CRITERIA_QUERY]);
        expect(input.onlyPassing).toBe(true);
        expect(input.maxRunSeconds).toBe(300);
        for (let variant = 0; variant < 6; variant++) {
            const brave = buildBraveQuery({ keyword: CRITERIA_QUERY, variant });
            const google = buildQuery({ keyword: CRITERIA_QUERY, variant });
            expect(brave).toMatch(/tiktok\.com/);
            expect(google).toMatch(/tiktok\.com/);
            expect(brave).not.toMatch(/creator|tips|tutorial|how to|recommendations/i);
        }
    });

    it('diversifies follower bands without adding topic seeds', () => {
        const queries = Array.from({ length: 6 }, (_, variant) => buildQuery({ keyword: CRITERIA_QUERY, variant }));
        expect(new Set(queries).size).toBe(6);
        expect(queries).toEqual(expect.arrayContaining([
            'site:tiktok.com/@ "20K" "followers"',
            'site:tiktok.com/@ "75K" "followers"',
            'site:tiktok.com/@ "followers" -verified -official',
        ]));
        expect(queries.every((q) => q.includes('site:tiktok.com/@'))).toBe(true);
    });

    it('keeps explicit keywords and hashtags with hashtag-first ordering', () => {
        const input = readInput({ keywords: ['home'], hashtags: ['#finance'] });
        expect(input.searches).toEqual(['#finance', 'home']);
        expect(input.criteriaOnly).toBe(false);
    });

    it('loads a resume token and skips previously handled names', () => {
        const input = readInput({
            resumeToken: { nextSearchIndex: 1, processedHandles: ['@Done', '@Already'] },
            excludeHandles: ['@Seen'],
        });
        expect(input.resumeIndex).toBe(1);
        expect(input.knownHandles).toEqual(expect.arrayContaining(['done', 'already', 'seen']));
    });
});

describe('strict creator screening', () => {
    const good = {
        followers: 20000,
        medianViews: 7500,
        daysSinceLastPost: 2,
        verified: false,
        profileStatus: 'ok',
    };
    const rules = {
        minFollowers: 10000,
        maxFollowers: 150000,
        minMedianViews: 5000,
        maxDaysSinceLastPost: 7,
        excludeVerified: true,
    };
    it('accepts complete passing metrics', () => {
        expect(checkFilters(good, rules).passes).toBe(true);
    });
    it('does not pass verified or unknown-verification profiles', () => {
        expect(checkFilters({ ...good, verified: true }, rules).passes).toBe(false);
        expect(checkFilters({ ...good, verified: null }, rules).passes).toBeNull();
    });
    it('does not pass missing activity or views', () => {
        expect(checkFilters({ ...good, daysSinceLastPost: null }, rules).passes).toBeNull();
        expect(checkFilters({ ...good, medianViews: null }, rules).passes).toBeNull();
    });
    it('does not pass out-of-range or failed profiles', () => {
        expect(checkFilters({ ...good, followers: 200000 }, rules).passes).toBe(false);
        expect(checkFilters({ ...good, profileStatus: 'failed' }, rules).passes).toBeNull();
    });
});
