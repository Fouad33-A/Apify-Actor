import { describe, expect, it } from 'vitest';

import { applyScreening, extractMentions, normalizeHandle, rankCandidates } from '../src/expand.js';

describe('normalizeHandle', () => {
    it.each([
        ['@PlanBudgetDream', 'planbudgetdream'],
        ['easy_budget', 'easy_budget'],
        ['  a.b_c  ', 'a.b_c'],
    ])('%s -> %s', (raw, expected) => {
        expect(normalizeHandle(raw)).toBe(expected);
    });

    it.each([
        [''],
        [null],
        ['explore'],
        ['p'],
        ['has space'],
        ['trailing.'],
        ['.leading'],
        ['x'.repeat(31)],
        ['a@b.co'],
    ])('rejects %j', (raw) => {
        expect(normalizeHandle(raw)).toBeNull();
    });
});

describe('extractMentions', () => {
    it('finds distinct @handles in a caption', () => {
        expect(extractMentions('Collab with @planbudgetdream and @Easy_Budget! cc @planbudgetdream')).toEqual([
            'planbudgetdream',
            'easy_budget',
        ]);
    });
    it('does not treat e-mail addresses as mentions', () => {
        expect(extractMentions('business: hello@example.com or @real.person')).toEqual(['real.person']);
    });
    it('drops trailing punctuation and reserved words, tolerates empty input', () => {
        expect(extractMentions('thanks @a.b. and @explore, @c_d!')).toEqual(['a.b', 'c_d']);
        expect(extractMentions(null)).toEqual([]);
        expect(extractMentions('')).toEqual([]);
    });
});

describe('rankCandidates', () => {
    const ev = (handle, signal, seed, postUrl = 'u') => ({ handle, signal, seed, postUrl });

    it('ranks by distinct seeds, then sightings, then mention over commenter, then name', () => {
        const events = [
            ev('solo_many', 'commenter', 's1'),
            ev('solo_many', 'commenter', 's1'),
            ev('solo_many', 'commenter', 's1'),
            ev('two_seeds', 'commenter', 's1'),
            ev('two_seeds', 'commenter', 's2'),
            ev('mentioned', 'mention', 's1'),
            ev('commented', 'commenter', 's1'),
        ];
        expect(rankCandidates(events).map((c) => c.handle)).toEqual([
            'two_seeds',
            'solo_many',
            'mentioned',
            'commented',
        ]);
    });

    it('drops seeds and excluded handles (any case, with @) and invalid handles', () => {
        const events = [
            ev('Seed_One', 'commenter', 's'),
            ev('known', 'mention', 's'),
            ev('bad handle', 'mention', 's'),
            ev('new_one', 'mention', 's'),
        ];
        expect(rankCandidates(events, { seeds: ['seed_one'], exclude: ['@KNOWN'] }).map((c) => c.handle)).toEqual([
            'new_one',
        ]);
    });

    it('aggregates signals, seeds and up to 3 distinct example URLs', () => {
        const events = ['a', 'b', 'c', 'd', 'a'].map((u, i) =>
            ev('x', i % 2 ? 'mention' : 'commenter', i < 3 ? 's1' : 's2', u),
        );
        const [c] = rankCandidates(events);
        expect(c).toMatchObject({ handle: 'x', timesSeen: 5, signals: ['commenter', 'mention'], seeds: ['s1', 's2'] });
        expect(c.examples).toEqual(['a', 'b', 'c']);
    });

    it('no events -> no candidates', () => {
        expect(rankCandidates([])).toEqual([]);
    });
});

describe('applyScreening', () => {
    const row = (over = {}) => ({
        status: 'found',
        followerCount: 100_000,
        contactEmails: ['a@b.co'],
        bio: 'Budgeting tips',
        externalLinks: ['https://example.com'],
        ...over,
    });

    it('no criteria -> null verdict, never true or false', () => {
        expect(applyScreening(row(), {})).toEqual({ passes: null, failures: [] });
        expect(applyScreening(row(), { excludeBioPatterns: ['  '] })).toEqual({ passes: null, failures: [] });
    });

    it('passes when every criterion is met (bounds are inclusive)', () => {
        expect(
            applyScreening(row({ followerCount: 30_000 }), {
                minFollowers: 30_000,
                maxFollowers: 150_000,
                requireContactEmail: true,
                excludeBioPatterns: ['stan.store'],
            }),
        ).toEqual({ passes: true, failures: [] });
    });

    it('reports every failed criterion with its reason', () => {
        const r = applyScreening(
            row({
                followerCount: 400_000,
                contactEmails: [],
                bio: 'my ebook',
                externalLinks: ['https://stan.store/x'],
            }),
            {
                minFollowers: 30_000,
                maxFollowers: 150_000,
                requireContactEmail: true,
                excludeBioPatterns: ['STAN.STORE', 'ebook'],
            },
        );
        expect(r.passes).toBe(false);
        expect(r.failures).toEqual([
            'followers 400000 above 150000',
            'no contact email in the bio',
            'bio or link contains "stan.store"',
            'bio or link contains "ebook"',
        ]);
    });

    it('an unknown follower count fails a follower criterion (never guessed as a pass)', () => {
        expect(applyScreening(row({ followerCount: null }), { minFollowers: 1 })).toEqual({
            passes: false,
            failures: ['follower count unknown'],
        });
    });

    it('a profile that was not read (blocked, not found...) cannot pass', () => {
        const r = applyScreening(row({ status: 'blocked' }), { requireContactEmail: true });
        expect(r.passes).toBe(false);
        expect(r.failures[0]).toMatch(/status is "blocked"/);
    });
});
