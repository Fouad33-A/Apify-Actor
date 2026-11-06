import { describe, it, expect } from 'vitest';
import { fromCandidateFeed, normalizeCandidate } from '../src/candidate-source.js';
import { readInput } from '../src/main.js';

describe('offline candidate source', () => {
    it('normalizes profile URLs and handles without network requests', () => {
        expect(normalizeCandidate('https://www.tiktok.com/@Example.Name/video/123')).toBe('example.name');
        expect(normalizeCandidate('@Example.Name')).toBe('example.name');
        expect(normalizeCandidate('not a handle')).toBe(null);
    });
    it('deduplicates and excludes already-screened handles', () => {
        const rows = fromCandidateFeed(['@One', 'https://www.tiktok.com/@one', '@Two', '@bad..name'], ['two']);
        expect(rows.map((r) => r.handle)).toEqual(['one']);
        expect(rows[0].hint).toBe(null);
    });
    it('retains strict screening requirements', () => {
        const input = readInput({ candidateFeed: ['@one'] });
        expect(input.minFollowers).toBe(10000);
        expect(input.maxFollowers).toBe(150000);
        expect(input.minMedianViews).toBe(5000);
        expect(input.maxDaysSinceLastPost).toBe(7);
        expect(input.onlyPassing).toBe(true);
    });
});
