import { describe, expect, it } from 'vitest';

import { applyScreening } from '../src/expand.js';
import { agencyEmails, isSponsoredPost, postStats, scoreRow, warnHits } from '../src/scorecard.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();
const post = (over = {}) => ({
    status: 'found',
    caption: 'a normal caption',
    likeCount: 100,
    commentCount: 10,
    publishDate: daysAgo(1),
    ...over,
});
const posts = (n, over = {}) => Array.from({ length: n }, (_, i) => post({ publishDate: daysAgo(i * 2), ...over }));

describe('isSponsoredPost / agencyEmails / warnHits', () => {
    it('#ad, #sponsored, paid partnership, the platform flag; not #add or #adventure', () => {
        expect(isSponsoredPost({ caption: 'love it #ad' })).toBe(true);
        expect(isSponsoredPost({ caption: '#Sponsored by x' })).toBe(true);
        expect(isSponsoredPost({ caption: 'Paid partnership with brand' })).toBe(true);
        expect(isSponsoredPost({ caption: 'x', isSponsored: true })).toBe(true);
        expect(isSponsoredPost({ caption: '#add #adventure #ads' })).toBe(false);
    });
    it('flags management/agency e-mails with the matching word', () => {
        expect(agencyEmails(['lucy@moxymanagement.co.uk', 'me@jane.com'], ['management', 'talent'])).toEqual([
            { email: 'lucy@moxymanagement.co.uk', pattern: 'management' },
        ]);
    });
    it('warn words are found in the bio, links and the site text', () => {
        const row = {
            bio: 'ETF investor',
            externalLinks: ['https://x.com'],
            creatorSites: [{ url: 'https://s.com', text: 'Crypto | Blog' }],
        };
        expect(warnHits(row, ['crypto', 'trading'])).toEqual(['crypto']);
    });
});

describe('postStats', () => {
    it('counts sponsored posts, engagement (median likes+comments) and posting rate', () => {
        const list = [
            ...posts(8),
            post({ caption: 'x #ad', publishDate: daysAgo(17) }),
            post({ caption: 'y #sponsored', publishDate: daysAgo(19) }),
        ];
        const s = postStats(list, 10_000, { now: NOW });
        expect(s.sponsoredPosts).toBe(2);
        expect(s.medianInteractions).toBe(110);
        expect(s.engagementPctOfFollowers).toBe(1.1);
        // 10 posts, oldest 19 days ago -> window 19 days -> 10 / 19 * 7 = 3.68
        expect(s.postsPerWeek).toBe(3.68);
    });
    it('is null (not guessed) with fewer than 3 usable posts, or hidden likes', () => {
        expect(postStats(posts(2), 10_000, { now: NOW })).toMatchObject({
            sponsoredPosts: null,
            engagementPctOfFollowers: null,
            postsPerWeek: null,
        });
        const hidden = postStats(posts(5, { likeCount: null }), 10_000, { now: NOW });
        expect(hidden.engagementPctOfFollowers).toBeNull();
        expect(hidden.sponsoredPosts).toBe(0);
    });
});

describe('scoreRow', () => {
    const base = (over = {}) => ({
        followerCount: 60_000,
        contactEmails: ['me@jane.com'],
        externalLinks: ['https://jane.com'],
        bioLinkTargets: [],
        creatorSites: [],
        sponsoredPosts: 0,
        postsReadForScore: 10,
        engagementPctOfFollowers: 2.5,
        postsPerWeek: 4,
        ...over,
    });

    it('a clean, active, reachable 60k creator scores the maximum 60', () => {
        const r = scoreRow(base(), { platform: 'instagram' });
        expect(r.scoreTotal).toBe(60);
        expect(r.scoreMax).toBe(60);
        expect(r.scoreUnknownRules).toEqual([]);
        expect(r.scorecard.B3).toMatchObject({ points: 10, max: 10 });
    });

    it.each([
        [2, 15],
        [1.99, 7],
        [1, 7],
        [0.99, 0],
    ])('B2 engagement %s%% -> %s points', (eng, pts) => {
        expect(scoreRow(base({ engagementPctOfFollowers: eng }), { platform: 'instagram' }).scorecard.B2.points).toBe(
            pts,
        );
    });

    it.each([
        [150_000, 0],
        [100_000, 10],
        [50_000, 10],
        [49_999, 8],
        [20_000, 8],
        [19_999, 5],
        [10_000, 5],
    ])('B3 size %s followers -> %s points', (n, pts) => {
        expect(scoreRow(base({ followerCount: n }), { platform: 'instagram' }).scorecard.B3.points).toBe(pts);
    });

    it('B1: a shop link or more than 1 sponsored post scores 0, with the reason', () => {
        const shop = scoreRow(base({ creatorSites: [{ url: 'https://jane.com', text: 'Home | Shop | Blog' }] }), {
            platform: 'instagram',
        });
        expect(shop.scorecard.B1).toMatchObject({ points: 0, unknown: false });
        expect(shop.scorecard.B1.value).toContain('shop');
        const sponsored = scoreRow(base({ sponsoredPosts: 2 }), { platform: 'instagram' });
        expect(sponsored.scorecard.B1.points).toBe(0);
        expect(scoreRow(base({ sponsoredPosts: 1 }), { platform: 'instagram' }).scorecard.B1.points).toBe(20);
    });

    it('B4 and B5: e-mail found / not, 3 posts a week / fewer', () => {
        const r = scoreRow(base({ contactEmails: [], postsPerWeek: 2.9 }), { platform: 'instagram' });
        expect(r.scorecard.B4.points).toBe(0);
        expect(r.scorecard.B5.points).toBe(0);
    });

    it('Instagram/Facebook: unknown rules count 0 and warn "check by hand"', () => {
        const r = scoreRow(base({ engagementPctOfFollowers: null, postsPerWeek: null, sponsoredPosts: null }), {
            platform: 'instagram',
        });
        expect(r.scoreUnknownRules).toEqual(['B1', 'B2', 'B5']);
        expect(r.scoreTotal).toBe(20); // B3 10 + B4 10
        expect(r.scoreUnknownTreatedAsFull).toBe(false);
        expect(r.scoreWarnings.join(' ')).toMatch(/B2 .*counted as 0, check by hand/);
    });

    it('TikTok: unknown rules get full points, are listed as unknown, and warn', () => {
        const r = scoreRow(base({ engagementPctOfFollowers: null, postsPerWeek: null, sponsoredPosts: null }), {
            platform: 'tiktok',
        });
        expect(r.scoreUnknownRules).toEqual(['B1', 'B2', 'B5']);
        expect(r.scoreTotal).toBe(60);
        expect(r.scoreUnknownTreatedAsFull).toBe(true);
        expect(r.scorecard.B2).toMatchObject({ points: 15, unknown: true, note: 'unknown: full points given' });
        // a known shop link still scores 0 on TikTok
        const shop = scoreRow(base({ sponsoredPosts: null, creatorSites: [{ url: 'https://j.com', text: 'Shop' }] }), {
            platform: 'tiktok',
        });
        expect(shop.scorecard.B1).toMatchObject({ points: 0, unknown: false });
    });

    it('minScore: below it is a failure with the numbers', () => {
        const r = scoreRow(
            base({ engagementPctOfFollowers: 0.2, postsPerWeek: 1, contactEmails: [], sponsoredPosts: 5 }),
            {
                platform: 'instagram',
                config: { minScore: 25 },
            },
        );
        expect(r.scoreTotal).toBe(10);
        expect(r.failures).toEqual(['score 10 of 60 is below 25']);
    });
});

describe('applyScreening: A3 management/agency e-mail in the bio', () => {
    const criteria = { agencyEmailPatterns: ['management', 'talent'] };
    it('fails a bio e-mail that looks like an agency; ignores one found later on a website', () => {
        const bad = applyScreening(
            {
                status: 'found',
                contactEmails: ['lucy@moxymanagement.co.uk'],
                contactEmailSources: [{ email: 'lucy@moxymanagement.co.uk', source: 'bio' }],
            },
            criteria,
        );
        expect(bad.passes).toBe(false);
        expect(bad.failures[0]).toContain('lucy@moxymanagement.co.uk');
        const site = applyScreening(
            {
                status: 'found',
                contactEmails: ['x@talentco.com'],
                contactEmailSources: [{ email: 'x@talentco.com', source: 'site' }],
            },
            criteria,
        );
        expect(site.passes).toBe(true);
    });
});
