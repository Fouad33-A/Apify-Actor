import { describe, expect, it, vi } from 'vitest';

import { BudgetTracker } from '../src/budget.js';
import { RateLimitError } from '../src/errors.js';
import { runMode } from '../src/run.js';

vi.mock('apify', () => ({ log: { warning: vi.fn(), exception: vi.fn(), info: vi.fn() } }));
vi.mock('../src/websearch.js', async (original) => ({
    ...(await original()),
    discoverByWebSearch: vi.fn(),
}));
vi.mock('../src/linkinbio.js', async (original) => ({
    ...(await original()),
    resolveBioLinks: vi.fn(async () => ({ targets: ['https://www.youtube.com/@ok'], emails: [], warnings: [] })),
}));
vi.mock('../src/sitescan.js', async (original) => ({
    ...(await original()),
    scanCreatorSites: vi.fn(async ({ urls }) => ({
        sites: [
            {
                url: urls[0],
                title: 'Blog',
                description: null,
                text: urls[0].includes('coach') ? 'Courses | Blog' : 'Recipes',
            },
        ],
        emails: urls[0].includes('mail') ? ['hello@mail.test'] : [],
        emailSources: urls[0].includes('mail') ? [{ email: 'hello@mail.test', source: 'site', url: urls[0] }] : [],
        warnings: [],
    })),
}));
const { discoverByWebSearch } = await import('../src/websearch.js');

const NOW = Date.now();
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();
const igPosts = (n, likes = 1500) =>
    Array.from({ length: n }, (_, i) => ({
        status: 'found',
        postUrl: `https://www.instagram.com/p/${i}/`,
        caption: 'budget tips',
        likeCount: likes,
        commentCount: 50,
        publishDate: daysAgo(i * 2),
    }));

const cand = (platform, handle, over = {}) => ({
    platform,
    handle,
    queries: ['budgeting'],
    timesSeen: 1,
    profileHit: true,
    snippet: 'snip',
    hint: '50K',
    engines: ['bing'],
    ...over,
});

function harness(input, mods, candidates) {
    discoverByWebSearch.mockResolvedValue({
        candidates,
        report: { queries: [], enginesBlocked: [], totalHits: candidates.length },
    });
    const pushed = [];
    const report = {};
    const rateLimitErrors = [];
    return {
        pushed,
        report,
        rateLimitErrors,
        run: () =>
            runMode({
                mode: 'discover',
                mods,
                page: {},
                input: { searchKeywords: ['budgeting'], ...input },
                budget: new BudgetTracker(100),
                pushData: async (r) => pushed.push(r),
                rateLimitErrors,
                report,
            }),
    };
}

const igMod = (byHandle) => ({
    lookupProfile: vi.fn(async ({ username, maxRecentPosts }) => ({
        profile: {
            recordType: 'profile',
            platform: 'instagram',
            status: 'found',
            username,
            sourceInput: username,
            followerCount: 60_000,
            contactEmails: ['me@jane.com'],
            bio: 'budgeting',
            externalLinks: [`https://${username}.test/`],
            ...byHandle[username],
        },
        posts: maxRecentPosts ? igPosts(10) : [],
    })),
});

const criteria = { minFollowers: 10_000, maxFollowers: 150_000, scorecard: true, minScore: 25 };

describe('discover mode: keywords -> accounts -> screening -> score', () => {
    it('scores a clean Instagram account out of 60 and records where it was discovered', async () => {
        const mod = igMod({});
        const h = harness(
            { ...criteria, followCreatorSite: true, excludeSitePatterns: ['course'] },
            { instagram: mod },
            [cand('instagram', 'jane')],
        );
        await h.run();
        const row = h.pushed[0];
        expect(row).toMatchObject({
            username: 'jane',
            passesFilters: true,
            discoveredFrom: ['budgeting'],
            searchFollowerHint: '50K',
            scoreMax: 60,
        });
        expect(row.scoreTotal).toBe(60);
        expect(row.scorecard.B4.points).toBe(10);
        expect(row.contactEmailSources).toEqual([{ email: 'me@jane.com', source: 'bio' }]);
        expect(h.report.discovery).toMatchObject({ lookedUp: 1, toLookUp: 1 });
    });

    it('skips handles already in the tracker without opening them, and lists them', async () => {
        const mod = igMod({});
        const h = harness({ ...criteria, excludeUsernames: ['Jane'] }, { instagram: mod }, [
            cand('instagram', 'jane'),
            cand('instagram', 'bob'),
        ]);
        await h.run();
        expect(mod.lookupProfile.mock.calls.map((c) => c[0].username)).toContain('bob');
        expect(mod.lookupProfile.mock.calls.map((c) => c[0].username)).not.toContain('jane');
        expect(h.report.discovery.skippedDuplicates).toEqual(['instagram:jane']);
    });

    it('hard filters fail with reasons: followers, agency e-mail in the bio, course words on the site', async () => {
        const mod = igMod({
            big: { followerCount: 900_000 },
            agency: { contactEmails: ['lucy@moxymanagement.co.uk'] },
            coach: { externalLinks: ['https://coachsite.test/'] },
        });
        const h = harness(
            { ...criteria, followCreatorSite: true, excludeSitePatterns: ['course'] },
            { instagram: mod },
            ['big', 'agency', 'coach'].map((x) => cand('instagram', x)),
        );
        await h.run();
        const by = Object.fromEntries(h.pushed.map((r) => [r.username, r]));
        expect(by.big.filterFailures).toEqual(['followers 900000 above 150000']);
        expect(by.agency.filterFailures[0]).toMatch(/looks like a management\/agency address \("management"\)/);
        expect(by.coach.filterFailures).toContain('website coachsite.test mentions "course"');
        expect(by.big.scorecard ?? null).toBeNull(); // the score is only computed for profiles that passed the hard filters
    });

    it('a site e-mail counts for B4 and is recorded with its source', async () => {
        const mod = igMod({ jane: { contactEmails: [], externalLinks: ['https://mail.test/'] } });
        const h = harness({ ...criteria, followCreatorSite: true }, { instagram: mod }, [cand('instagram', 'jane')]);
        await h.run();
        expect(h.pushed[0].contactEmailSources).toEqual([
            { email: 'hello@mail.test', source: 'site', url: 'https://mail.test/' },
        ]);
        expect(h.pushed[0].scorecard.B4.points).toBe(10);
    });

    it('below the minimum score fails with the numbers', async () => {
        const mod = igMod({ jane: { contactEmails: [], followerCount: 12_000 } });
        mod.lookupProfile.mockImplementation(async ({ username }) => ({
            profile: {
                recordType: 'profile',
                platform: 'instagram',
                status: 'found',
                username,
                sourceInput: username,
                followerCount: 12_000,
                contactEmails: [],
                externalLinks: [],
            },
            posts: igPosts(10, 10), // 10 likes + 50 comments on 12k followers = 0.5%
        }));
        const h = harness({ ...criteria, minScore: 40 }, { instagram: mod }, [cand('instagram', 'jane')]);
        await h.run();
        expect(h.pushed[0].passesFilters).toBe(false);
        expect(h.pushed[0].filterFailures.at(-1)).toMatch(/^score \d+ of 60 is below 40$/);
    });

    it('TikTok: posts come with the profile load (one call), unknown rules get full points and say so', async () => {
        const tt = {
            lookupProfile: vi.fn(async ({ username }) => ({
                profile: {
                    recordType: 'profile',
                    platform: 'tiktok',
                    status: 'found',
                    username,
                    sourceInput: username,
                    followerCount: 40_000,
                    contactEmails: ['t@jane.com'],
                    externalLinks: [],
                },
                posts: [], // TikTok's video list did not load
            })),
        };
        const h = harness(criteria, { tiktok: tt }, [cand('tiktok', 'tiktoker')]);
        await h.run();
        const row = h.pushed[0];
        expect(tt.lookupProfile).toHaveBeenCalledTimes(1);
        expect(tt.lookupProfile.mock.calls[0][0].maxRecentPosts).toBe(10);
        expect(row.scoreUnknownRules).toEqual(['B1', 'B2', 'B5']);
        expect(row.scoreUnknownTreatedAsFull).toBe(true);
        expect(row.scoreTotal).toBe(58); // B1 20 + B2 15 + B3 8 (40k) + B4 10 + B5 5
        expect(row.passesFilters).toBe(true);
    });

    it('Facebook: the score stage reopens the Page by its address, not by its display name, and scores the plugin posts', async () => {
        const fb = {
            lookupProfile: vi.fn(async ({ username, maxRecentPosts }) => ({
                profile: {
                    recordType: 'profile',
                    platform: 'facebook',
                    status: 'found',
                    username: 'Ameris Bank', // the Page's display name, as Facebook rows carry it
                    sourceInput: username,
                    followerCount: 60_000,
                    contactEmails: ['me@bank.test'],
                    externalLinks: [],
                },
                posts: maxRecentPosts
                    ? Array.from({ length: 6 }, (_, i) => ({
                          status: 'found',
                          postUrl: `https://www.facebook.com/x/posts/${i}`,
                          caption: 'tips',
                          likeCount: 1500,
                          commentCount: 100,
                          publishDate: daysAgo(i * 2),
                      }))
                    : [],
            })),
        };
        const h = harness(criteria, { facebook: fb }, [cand('facebook', 'amerisbank')]);
        await h.run();
        expect(fb.lookupProfile.mock.calls.map((c) => c[0].username)).toEqual(['amerisbank', 'amerisbank']);
        const row = h.pushed[0];
        expect(row.postsReadForScore).toBe(6);
        expect(row.scoreUnknownRules).toEqual([]);
        expect(row.scoreTotal).toBe(60); // B1 20 + B2 15 + B3 10 + B4 10 + B5 5
    });

    it('a platform that rate-limits is stopped, the others carry on; rows are still written', async () => {
        const tt = {
            lookupProfile: vi.fn(async () => {
                throw new RateLimitError('tiktok', 'profile', 'throttled');
            }),
        };
        const mod = igMod({});
        const h = harness(criteria, { instagram: mod, tiktok: tt }, [
            cand('tiktok', 't1'),
            cand('tiktok', 't2'),
            cand('instagram', 'jane'),
        ]);
        await h.run();
        expect(tt.lookupProfile).toHaveBeenCalledTimes(1); // t2 was not tried
        expect(h.pushed.map((r) => r.username)).toEqual(['jane']);
        expect(h.rateLimitErrors).toHaveLength(1);
        expect(h.report.discovery.blockedPlatforms).toEqual(['tiktok']);
    });

    it('needs at least one keyword', async () => {
        const h = harness({ searchKeywords: [] }, { instagram: igMod({}) }, []);
        await expect(h.run()).rejects.toThrow(/at least one search keyword/);
    });
});
