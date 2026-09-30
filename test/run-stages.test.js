import { describe, expect, it, vi } from 'vitest';

import { BudgetTracker } from '../src/budget.js';
import { runMode } from '../src/run.js';

vi.mock('apify', () => ({ log: { warning: vi.fn(), exception: vi.fn(), info: vi.fn() } }));
vi.mock('../src/linkinbio.js', async (original) => ({
    ...(await original()),
    resolveBioLinks: vi.fn(async ({ links }) =>
        links.some((l) => l.includes('hidden'))
            ? { targets: ['https://stan.store/hidden'], warnings: [] }
            : { targets: ['https://www.youtube.com/@ok'], warnings: [] },
    ),
}));
const { resolveBioLinks } = await import('../src/linkinbio.js');

const profile = (username, over = {}) => ({
    recordType: 'profile',
    status: 'found',
    username,
    sourceInput: username,
    followerCount: 50_000,
    contactEmails: ['a@b.co'],
    bio: 'budgeting',
    externalLinks: [`https://linktr.ee/${username}`],
    ...over,
});
const posts = (likes) =>
    likes.map((l, i) => ({ status: 'found', postUrl: `https://x/p/${i}`, likeCount: l, commentCount: 1 }));

function harness(input, lookup) {
    const pushed = [];
    const lookupProfile = vi.fn(lookup);
    return {
        pushed,
        lookupProfile,
        run: () =>
            runMode({
                mode: 'profile',
                mod: { lookupProfile },
                page: {},
                input: { platform: 'instagram', ...input },
                budget: new BudgetTracker(100),
                pushData: async (r) => pushed.push(r),
                rateLimitErrors: [],
            }),
    };
}

describe('staged screen: link-in-bio pages', () => {
    it('a Stan Store hidden behind a Linktree fails the bio/link screen, with the reason', async () => {
        resolveBioLinks.mockClear();
        const h = harness(
            { usernames: ['hidden_one', 'clean_one'], excludeBioPatterns: ['stan.store'] },
            async ({ username }) => ({
                profile: profile(username, { externalLinks: [`https://linktr.ee/${username}`] }),
                posts: [],
            }),
        );
        await h.run();
        const [hidden, clean] = h.pushed;
        expect(hidden).toMatchObject({ passesFilters: false, bioLinkTargets: ['https://stan.store/hidden'] });
        expect(hidden.filterFailures).toEqual(['bio or link contains "stan.store"']);
        expect(clean).toMatchObject({ passesFilters: true, bioLinkTargets: ['https://www.youtube.com/@ok'] });
    });

    it('link pages are opened only for profiles that passed the first checks, and only when patterns are set', async () => {
        resolveBioLinks.mockClear();
        const h = harness(
            { usernames: ['small', 'big'], maxFollowers: 100_000, excludeBioPatterns: ['stan.store'] },
            async ({ username }) => ({
                profile: profile(username, { followerCount: username === 'small' ? 5000 : 500_000 }),
                posts: [],
            }),
        );
        await h.run();
        expect(resolveBioLinks).toHaveBeenCalledTimes(1);
        const none = harness({ usernames: ['x'], requireContactEmail: true }, async ({ username }) => ({
            profile: profile(username),
            posts: [],
        }));
        resolveBioLinks.mockClear();
        await none.run();
        expect(resolveBioLinks).not.toHaveBeenCalled();
    });

    it('followLinkInBio=false skips the step; an unreadable page is carried as a warning, not a failure', async () => {
        resolveBioLinks.mockClear();
        const off = harness(
            { usernames: ['x'], excludeBioPatterns: ['stan.store'], followLinkInBio: false },
            async ({ username }) => ({ profile: profile(username), posts: [] }),
        );
        await off.run();
        expect(resolveBioLinks).not.toHaveBeenCalled();
        resolveBioLinks.mockResolvedValueOnce({
            targets: [],
            warnings: ['link-in-bio page https://linktr.ee/x could not be read: timeout'],
        });
        const warn = harness({ usernames: ['x'], excludeBioPatterns: ['stan.store'] }, async ({ username }) => ({
            profile: profile(username),
            posts: [],
        }));
        await warn.run();
        expect(warn.pushed[0]).toMatchObject({ passesFilters: true });
        expect(warn.pushed[0].screeningWarnings[0]).toMatch(/could not be read/);
    });
});

describe('staged screen: the reach rule', () => {
    const lookup = async ({ username, maxRecentPosts }) => ({
        profile: profile(username, { externalLinks: [], followerCount: username === 'lowfollow' ? 500_000 : 50_000 }),
        posts:
            maxRecentPosts > 0
                ? posts(username === 'weak' ? [100, 120, 90, 110, 95] : [2500, 3000, 2800, 2600, 2700])
                : [],
    });

    it('computes reach only for profiles that passed the first screen (one extra lookup each)', async () => {
        const h = harness(
            { usernames: ['strong', 'lowfollow'], maxFollowers: 100_000, reachPosts: 5, minReachPercent: 3 },
            lookup,
        );
        await h.run();
        const strong = h.pushed.find((r) => r.username === 'strong');
        const low = h.pushed.find((r) => r.username === 'lowfollow');
        expect(strong).toMatchObject({
            postsSampled: 5,
            medianLikes: 2700,
            likesPctOfFollowers: 5.4,
            reachPctOfFollowers: 5.4,
            passesFilters: true,
        });
        expect(low.postsSampled ?? null).toBeNull(); // failed the follower screen: no post pages were read
        // strong: 2 lookups (profile + posts); lowfollow: 1
        expect(h.lookupProfile.mock.calls.filter((c) => c[0].username === 'strong')).toHaveLength(2);
        expect(h.lookupProfile.mock.calls.filter((c) => c[0].username === 'lowfollow')).toHaveLength(1);
    });

    it('a profile below minReachPercent fails with the numbers', async () => {
        const h = harness({ usernames: ['weak'], reachPosts: 5, minReachPercent: 3 }, lookup);
        await h.run();
        expect(h.pushed[0]).toMatchObject({ passesFilters: false, reachPctOfFollowers: 0.2 });
        expect(h.pushed[0].filterFailures).toEqual(['reach 0.2% of followers is below 3%']);
    });

    it('unknown reach (hidden likes / too few posts) does not fail the screen: it warns so the row is checked by hand', async () => {
        const noCounts = async ({ username, maxRecentPosts }) => ({
            profile: profile(username, { externalLinks: [] }),
            posts: maxRecentPosts ? posts([null, null, null]) : [],
        });
        const strict = harness({ usernames: ['x'], reachPosts: 5, minReachPercent: 3 }, noCounts);
        await strict.run();
        expect(strict.pushed[0].passesFilters).toBe(true);
        expect(strict.pushed[0].filterFailures).toEqual([]);
        expect(strict.pushed[0].screeningWarnings[0]).toMatch(/reach not computed.*check the reach by hand/);
        // other criteria still fail it
        const other = harness(
            { usernames: ['x'], reachPosts: 5, minReachPercent: 3, requireContactEmail: true },
            async (a) => {
                const r = await noCounts(a);
                return { ...r, profile: { ...r.profile, contactEmails: [] } };
            },
        );
        await other.run();
        expect(other.pushed[0]).toMatchObject({
            passesFilters: false,
            filterFailures: ['no contact email in the bio'],
        });
    });

    it('says how many post pages could not be loaded, so a failed load is not mistaken for hidden likes', async () => {
        const failing = async ({ username, maxRecentPosts }) => ({
            profile: profile(username, { externalLinks: [] }),
            posts: maxRecentPosts
                ? [
                      {
                          status: 'found',
                          likeCount: null,
                          statusDetail: 'post page could not be loaded (timeout or block): its counts are unavailable',
                      },
                      {
                          status: 'found',
                          likeCount: null,
                          statusDetail: 'post page could not be loaded (timeout or block): its counts are unavailable',
                      },
                      { status: 'found', likeCount: 10 },
                  ]
                : [],
        });
        const h = harness({ usernames: ['x'], reachPosts: 3 }, failing);
        await h.run();
        expect(h.pushed[0].screeningWarnings).toContain('2 of 3 post pages could not be loaded (timeout or block)');
    });

    it('reachPosts 0 (default) never reads posts', async () => {
        const h = harness({ usernames: ['strong'], maxFollowers: 100_000 }, lookup);
        await h.run();
        expect(h.lookupProfile).toHaveBeenCalledTimes(1);
        expect(h.pushed[0].postsSampled ?? null).toBeNull();
    });
});
