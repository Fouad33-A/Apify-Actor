import { describe, expect, it, vi } from 'vitest';

import { BudgetTracker } from '../src/budget.js';
import { RateLimitError } from '../src/errors.js';
import { runMode } from '../src/run.js';

vi.mock('apify', () => ({
    log: { warning: vi.fn(), exception: vi.fn(), info: vi.fn() },
}));

const post = (n) => ({ postUrl: `https://x/p/${n}/` });

function harness({ input: inputOverride = {}, cap = 1000, mod = {} } = {}) {
    const input = { platform: 'instagram', ...inputOverride };
    const pushed = [];
    const rateLimitErrors = [];
    const budget = new BudgetTracker(cap);
    const fullMod = {
        lookupProfile: vi.fn(async ({ username }) => ({ profile: { id: `profile:${username}` }, posts: [] })),
        searchPosts: vi.fn(async () => []),
        fetchComments: vi.fn(async ({ postUrl }) => [{ id: `comment:${postUrl}:1` }, { id: `comment:${postUrl}:2` }]),
        ...mod,
    };
    const run = (mode) =>
        runMode({
            mode,
            mod: fullMod,
            page: {},
            input,
            budget,
            pushData: async (row) => {
                pushed.push(row);
            },
            rateLimitErrors,
        });
    return { run, pushed, rateLimitErrors, budget, mod: fullMod };
}

describe('runMode: profile (Mode A)', () => {
    it('writes the profile then its posts, in order', async () => {
        const h = harness({
            input: { usernames: ['a'] },
            mod: { lookupProfile: vi.fn(async () => ({ profile: { id: 'P' }, posts: [{ id: 'p1' }, { id: 'p2' }] })) },
        });
        await h.run('profile');
        expect(h.pushed.map((r) => r.id)).toEqual(['P', 'p1', 'p2']);
        expect(h.budget.counts).toMatchObject({ profiles: 1, posts: 2, total: 3 });
    });

    it('passes maxRecentPosts (default 25) and the username as sourceInput to the platform', async () => {
        const h = harness({ input: { usernames: ['a'] } });
        await h.run('profile');
        expect(h.mod.lookupProfile).toHaveBeenCalledWith(
            expect.objectContaining({ username: 'a', sourceInput: 'a', maxRecentPosts: 25 }),
        );
    });

    it('does not fetch comments unless fetchComments is true', async () => {
        const h = harness({
            input: { usernames: ['a'] },
            mod: { lookupProfile: vi.fn(async () => ({ profile: { id: 'P' }, posts: [post(1)] })) },
        });
        await h.run('profile');
        expect(h.mod.fetchComments).not.toHaveBeenCalled();
    });

    it('fetchComments=true attaches comment rows after each post, using the comment options', async () => {
        const h = harness({
            input: { usernames: ['a'], fetchComments: true, maxCommentsPerPost: 7, topLevelCommentsOnly: false },
            mod: { lookupProfile: vi.fn(async () => ({ profile: { id: 'P' }, posts: [post(1), post(2)] })) },
        });
        await h.run('profile');
        expect(h.pushed.map((r) => r.id)).toEqual([
            'P',
            undefined,
            'comment:https://x/p/1/:1',
            'comment:https://x/p/1/:2',
            undefined,
            'comment:https://x/p/2/:1',
            'comment:https://x/p/2/:2',
        ]);
        expect(h.mod.fetchComments).toHaveBeenCalledWith(
            expect.objectContaining({ maxComments: 7, topLevelOnly: false, sourceInput: 'a' }),
        );
    });

    it('stops writing at the item cap and reports stoppedOnCap', async () => {
        const h = harness({
            cap: 3,
            input: { usernames: ['a', 'b'] },
            mod: {
                lookupProfile: vi.fn(async () => ({
                    profile: { id: 'P' },
                    posts: [{ id: '1' }, { id: '2' }, { id: '3' }],
                })),
            },
        });
        await h.run('profile');
        expect(h.pushed).toHaveLength(3);
        expect(h.budget.summary().stoppedOnCap).toBe(true);
        expect(h.mod.lookupProfile).toHaveBeenCalledTimes(1); // second username never looked up
    });

    it('a non-rate-limit failure on one username is logged and the next username still runs', async () => {
        const lookupProfile = vi
            .fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce({ profile: { id: 'B' }, posts: [] });
        const h = harness({ input: { usernames: ['a', 'b'] }, mod: { lookupProfile } });
        await h.run('profile');
        // the failed lookup is reported as a row (never silently dropped), then the next username runs
        expect(h.pushed[0]).toMatchObject({
            recordType: 'profile',
            platform: 'instagram',
            sourceInput: 'a',
            username: 'a',
            status: 'error',
            statusDetail: 'Lookup failed: boom',
            followerCount: null,
        });
        expect(h.pushed.map((r) => r.id)).toEqual([undefined, 'B']);
        expect(h.rateLimitErrors).toEqual([]);
    });

    it('an error row carries only the first line of the message, truncated', async () => {
        const lookupProfile = vi.fn().mockRejectedValue(new Error(`first line ${'x'.repeat(500)}\nsecond line`));
        const h = harness({ input: { usernames: ['a'] }, mod: { lookupProfile } });
        await h.run('profile');
        expect(h.pushed[0].statusDetail).not.toMatch(/second line/);
        expect(h.pushed[0].statusDetail.length).toBeLessThanOrEqual('Lookup failed: '.length + 300);
    });

    it('a failed comment fetch is reported as an error row and the run continues', async () => {
        const fetchComments = vi
            .fn()
            .mockRejectedValueOnce(new Error('page broke'))
            .mockResolvedValueOnce([{ id: 'c' }]);
        const h = harness({ input: { postUrls: ['https://x/p/1/', 'https://x/p/2/'] }, mod: { fetchComments } });
        await h.run('comments');
        expect(h.pushed[0]).toMatchObject({
            recordType: 'comment',
            postUrl: 'https://x/p/1/',
            status: 'error',
            statusDetail: 'Comment fetch failed: page broke',
        });
        expect(h.pushed[1].id).toBe('c');
    });

    it('a rate limit stops the whole run (fail fast) and is recorded', async () => {
        const lookupProfile = vi
            .fn()
            .mockRejectedValueOnce(new RateLimitError('instagram', 'profile', 'HTTP 429'))
            .mockResolvedValue({ profile: { id: 'never' }, posts: [] });
        const h = harness({ input: { usernames: ['a', 'b', 'c'] }, mod: { lookupProfile } });
        await h.run('profile');
        expect(lookupProfile).toHaveBeenCalledTimes(1);
        expect(h.pushed).toEqual([]);
        expect(h.rateLimitErrors).toHaveLength(1);
        expect(h.rateLimitErrors[0]).toMatchObject({ platform: 'instagram', endpoint: 'profile' });
    });

    it('a rate limit while fetching comments also stops the run instead of carrying on', async () => {
        const fetchComments = vi.fn().mockRejectedValue(new RateLimitError('instagram', 'comments', 'blocked'));
        const lookupProfile = vi.fn(async () => ({ profile: { id: 'P' }, posts: [post(1), post(2)] }));
        const h = harness({
            input: { usernames: ['a', 'b'], fetchComments: true },
            mod: { lookupProfile, fetchComments },
        });
        await h.run('profile');
        expect(fetchComments).toHaveBeenCalledTimes(1); // not once per remaining post
        expect(lookupProfile).toHaveBeenCalledTimes(1); // second username never looked up
        expect(h.rateLimitErrors).toHaveLength(1);
    });

    it('a non-rate-limit comment failure keeps going with the next post', async () => {
        const fetchComments = vi
            .fn()
            .mockRejectedValueOnce(new Error('post page broke'))
            .mockResolvedValueOnce([{ id: 'c' }]);
        const h = harness({
            input: { usernames: ['a'], fetchComments: true },
            mod: {
                lookupProfile: vi.fn(async () => ({ profile: { id: 'P' }, posts: [post(1), post(2)] })),
                fetchComments,
            },
        });
        await h.run('profile');
        expect(h.pushed.some((r) => r.id === 'c')).toBe(true);
    });
});

describe('runMode: comments (Mode C)', () => {
    it('fetches comments for postUrls WITHOUT needing fetchComments=true (regression)', async () => {
        const h = harness({ input: { postUrls: ['https://x/p/1/', 'https://x/p/2/'] } });
        await h.run('comments');
        expect(h.mod.fetchComments).toHaveBeenCalledTimes(2);
        expect(h.pushed).toHaveLength(4);
        expect(h.budget.counts.comments).toBe(4);
    });

    it('uses the post URL as sourceInput', async () => {
        const h = harness({ input: { postUrls: ['https://x/p/1/'] } });
        await h.run('comments');
        expect(h.mod.fetchComments).toHaveBeenCalledWith(
            expect.objectContaining({ postUrl: 'https://x/p/1/', sourceInput: 'https://x/p/1/' }),
        );
    });

    it('respects the item cap mid-post and stops fetching further URLs', async () => {
        const h = harness({ cap: 3, input: { postUrls: ['https://x/p/1/', 'https://x/p/2/', 'https://x/p/3/'] } });
        await h.run('comments');
        expect(h.pushed).toHaveLength(3);
        expect(h.mod.fetchComments).toHaveBeenCalledTimes(2);
    });

    it('stops at the first rate limit instead of hitting the remaining URLs', async () => {
        const fetchComments = vi.fn().mockRejectedValue(new RateLimitError('instagram', 'comments', 'blocked'));
        const h = harness({ input: { postUrls: ['a', 'b', 'c'] }, mod: { fetchComments } });
        await h.run('comments');
        expect(fetchComments).toHaveBeenCalledTimes(1);
        expect(h.rateLimitErrors).toHaveLength(1);
    });

    it('an empty postUrls list writes nothing', async () => {
        const h = harness({ input: { postUrls: [] } });
        await h.run('comments');
        expect(h.pushed).toEqual([]);
    });
});

describe('runMode: search (Mode B)', () => {
    it('passes query options through with defaults and writes results as posts', async () => {
        const searchPosts = vi.fn(async () => [{ id: 's1', postUrl: 'u1' }]);
        const h = harness({
            input: { searchQueries: [{ query: 'etf investing' }, { query: 'x', sortOrder: 'recent', maxResults: 3 }] },
            mod: { searchPosts },
        });
        await h.run('search');
        expect(searchPosts).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ query: 'etf investing', sortOrder: 'relevance', maxResults: 25, dateFrom: null }),
        );
        expect(searchPosts).toHaveBeenNthCalledWith(2, expect.objectContaining({ sortOrder: 'recent', maxResults: 3 }));
        expect(h.budget.counts.posts).toBe(2);
    });

    it('a platform whose search is not implemented does not crash the run (error is logged per query)', async () => {
        const searchPosts = vi.fn().mockRejectedValue(new Error('not yet implemented'));
        const h = harness({ input: { searchQueries: [{ query: 'a' }, { query: 'b' }] }, mod: { searchPosts } });
        await expect(h.run('search')).resolves.toBeUndefined();
        expect(searchPosts).toHaveBeenCalledTimes(2);
        // one error row per query instead of a silent empty dataset
        expect(h.pushed.map((r) => [r.recordType, r.sourceInput, r.status])).toEqual([
            ['post', 'a', 'error'],
            ['post', 'b', 'error'],
        ]);
        expect(h.pushed[0].statusDetail).toMatch(/Search failed: not yet implemented/);
    });
});

describe('runMode: search with author profiles', () => {
    const hitProfile = (username) => ({
        recordType: 'profile',
        username,
        status: 'found',
        statusDetail: 'Taken from the search result (no separate profile page load)',
        bio: 'hit bio',
        followerCount: 5,
    });
    const searchResult = () => ({
        posts: [
            { recordType: 'post', username: 'a', postUrl: 'ua', bio: 'hit bio', externalLinks: [], followerCount: 5 },
            { recordType: 'post', username: 'b', postUrl: 'ub', bio: null, externalLinks: [], followerCount: 7 },
        ],
        profiles: [hitProfile('a'), hitProfile('b')],
    });

    it('reads each author profile page, writes profiles first, and gives posts the full author facts', async () => {
        const lookupProfile = vi.fn(async ({ username }) => ({
            profile: {
                recordType: 'profile',
                username,
                status: 'found',
                statusDetail: null,
                bio: `full bio ${username}`,
                externalLinks: [`https://${username}.example`],
                followerCount: 100,
            },
            posts: [],
        }));
        const h = harness({
            input: { searchQueries: [{ query: 'q' }] },
            mod: { searchPosts: vi.fn(async () => searchResult()), lookupProfile },
        });
        await h.run('search');
        expect(lookupProfile).toHaveBeenCalledTimes(2);
        expect(lookupProfile).toHaveBeenCalledWith(expect.objectContaining({ username: 'a', maxRecentPosts: 0 }));
        expect(h.pushed.map((r) => `${r.recordType}:${r.username}`)).toEqual([
            'profile:a',
            'profile:b',
            'post:a',
            'post:b',
        ]);
        const bPost = h.pushed.find((r) => r.recordType === 'post' && r.username === 'b');
        expect(bPost).toMatchObject({ bio: 'full bio b', externalLinks: ['https://b.example'], followerCount: 100 });
    });

    it('keeps the search-hit profile (and says why) when the profile page lookup does not give "found"', async () => {
        const lookupProfile = vi.fn(async ({ username }) => ({
            profile: { recordType: 'profile', username, status: 'blocked' },
            posts: [],
        }));
        const h = harness({
            input: { searchQueries: [{ query: 'q' }] },
            mod: { searchPosts: vi.fn(async () => searchResult()), lookupProfile },
        });
        await h.run('search');
        const p = h.pushed.find((r) => r.recordType === 'profile');
        expect(p.bio).toBe('hit bio');
        expect(p.statusDetail).toMatch(/Taken from the search result.*status "blocked"/);
        // post keeps its own hit-derived facts
        expect(h.pushed.find((r) => r.recordType === 'post' && r.username === 'a').bio).toBe('hit bio');
    });

    it('a failing profile lookup is noted on the hit profile, not fatal', async () => {
        const lookupProfile = vi.fn().mockRejectedValue(new Error('boom'));
        const h = harness({
            input: { searchQueries: [{ query: 'q' }] },
            mod: { searchPosts: vi.fn(async () => searchResult()), lookupProfile },
        });
        await h.run('search');
        expect(h.budget.counts).toMatchObject({ profiles: 2, posts: 2 });
        expect(h.pushed[0].statusDetail).toMatch(/Profile page lookup failed: boom/);
    });

    it('a rate limit during author enrichment stops the run', async () => {
        const lookupProfile = vi.fn().mockRejectedValue(new RateLimitError('tiktok', 'profile', 'x'));
        const h = harness({
            input: { searchQueries: [{ query: 'q' }, { query: 'r' }] },
            mod: { searchPosts: vi.fn(async () => searchResult()), lookupProfile },
        });
        await h.run('search');
        expect(h.rateLimitErrors).toHaveLength(1);
        expect(lookupProfile).toHaveBeenCalledTimes(1);
        expect(h.pushed).toEqual([]);
    });

    it('enrichSearchAuthors=false writes the hit profiles without loading any profile page', async () => {
        const lookupProfile = vi.fn();
        const h = harness({
            input: { searchQueries: [{ query: 'q' }], enrichSearchAuthors: false },
            mod: { searchPosts: vi.fn(async () => searchResult()), lookupProfile },
        });
        await h.run('search');
        expect(lookupProfile).not.toHaveBeenCalled();
        expect(h.budget.counts).toMatchObject({ profiles: 2, posts: 2 });
    });

    it('passes a shouldContinue callback that turns false once the run is stopped', async () => {
        let cb;
        const h = harness({
            input: { searchQueries: [{ query: 'q' }] },
            mod: {
                searchPosts: vi.fn(async ({ shouldContinue }) => {
                    cb = shouldContinue;
                    return [];
                }),
            },
        });
        await h.run('search');
        expect(cb()).toBe(true);
        h.budget.stop('max_proxy_megabytes');
        expect(cb()).toBe(false);
    });
});

describe('runMode: posts by URL', () => {
    it('reads each URL, writes the post, and attaches comments when asked', async () => {
        const fetchPost = vi.fn(async ({ postUrl }) => ({ recordType: 'post', postUrl, status: 'found' }));
        const h = harness({ input: { postUrls: ['u1', 'u2'], fetchComments: true }, mod: { fetchPost } });
        await h.run('posts');
        expect(h.budget.counts).toMatchObject({ posts: 2, comments: 4 });
        expect(h.pushed[0].recordType).toBe('post');
    });

    it('a platform without fetchPost gets an error row per URL, not a crash', async () => {
        const h = harness({ input: { postUrls: ['u1'], platform: 'facebook' } });
        await h.run('posts');
        expect(h.pushed[0]).toMatchObject({ recordType: 'post', status: 'error', postUrl: 'u1' });
        expect(h.pushed[0].statusDetail).toMatch(/not supported for facebook/);
    });

    it('does not fetch comments for a post that was not found/blocked', async () => {
        const fetchPost = vi.fn(async ({ postUrl }) => ({ recordType: 'post', postUrl, status: 'blocked' }));
        const h = harness({ input: { postUrls: ['u1'], fetchComments: true }, mod: { fetchPost } });
        await h.run('posts');
        expect(h.mod.fetchComments).not.toHaveBeenCalled();
    });

    it('a rate limit stops the run', async () => {
        const fetchPost = vi.fn().mockRejectedValue(new RateLimitError('tiktok', 'post', 'x'));
        const h = harness({ input: { postUrls: ['u1', 'u2'] }, mod: { fetchPost } });
        await h.run('posts');
        expect(fetchPost).toHaveBeenCalledTimes(1);
        expect(h.rateLimitErrors).toHaveLength(1);
    });
});

describe('runMode: a platform throttle reported together with rows', () => {
    it('writes the profile and post rows first, records the rate limit, then stops before the next username', async () => {
        const rateLimit = new RateLimitError('tiktok', 'creator embed', 'overload-protect');
        const lookupProfile = vi.fn(async () => ({
            profile: { recordType: 'profile', status: 'blocked' },
            posts: [{ recordType: 'post', status: 'blocked', postUrl: null }],
            rateLimit,
        }));
        const h = harness({ input: { usernames: ['a', 'b'] }, mod: { lookupProfile } });
        await h.run('profile');
        expect(h.pushed.map((r) => r.recordType)).toEqual(['profile', 'post']);
        expect(h.rateLimitErrors).toHaveLength(1);
        expect(lookupProfile).toHaveBeenCalledTimes(1);
    });
});

describe('runMode: rows without a URL never trigger a comment fetch', () => {
    it('a blocked post row (no postUrl) from a profile lookup is written but not commented on', async () => {
        const h = harness({
            input: { usernames: ['a'], fetchComments: true },
            mod: {
                lookupProfile: vi.fn(async () => ({
                    profile: { id: 'P' },
                    posts: [{ postUrl: null, status: 'blocked' }],
                })),
            },
        });
        await h.run('profile');
        expect(h.mod.fetchComments).not.toHaveBeenCalled();
        expect(h.budget.counts.posts).toBe(1);
    });
});

describe('runMode: expand (discovery from seeds)', () => {
    const seedPosts = [
        {
            recordType: 'post',
            status: 'found',
            postUrl: 'https://x/p/1/',
            caption: 'collab with @newfriend and @known_one',
        },
        { recordType: 'post', status: 'found', postUrl: 'https://x/p/2/', caption: 'no mentions here' },
    ];
    const comment = (u, text = 'nice') => ({
        recordType: 'comment',
        status: 'found',
        commenterUsername: u,
        commentText: text,
    });
    const profileFor = (username, over = {}) => ({
        recordType: 'profile',
        status: 'found',
        username,
        followerCount: 50_000,
        contactEmails: ['a@b.co'],
        bio: 'hello',
        externalLinks: [],
        ...over,
    });
    function expandHarness(input, over = {}) {
        const lookupProfile = vi.fn(async ({ username }) =>
            username === 'seedone'
                ? { profile: profileFor('seedone'), posts: seedPosts }
                : { profile: profileFor(username), posts: [] },
        );
        const fetchComments = vi.fn(async ({ postUrl }) =>
            postUrl.endsWith('/1/')
                ? [
                      comment('newfriend'),
                      comment('commenter_a', 'love it @tagged_by_comment'),
                      comment('seedone', 'thanks!'),
                  ]
                : [comment('commenter_a')],
        );
        return harness({ input: { usernames: ['SeedOne'], ...input }, mod: { lookupProfile, fetchComments, ...over } });
    }

    it('collects mentions and commenters, drops the seed and known accounts, ranks by sightings, then looks each up', async () => {
        const h = expandHarness({ excludeUsernames: ['known_one'], maxRecentPosts: 2 });
        await h.run('expand');
        const rows = h.pushed.filter((r) => r.recordType === 'profile');
        // newfriend and commenter_a are each seen twice; newfriend was also deliberately mentioned, so it ranks first
        expect(rows.map((r) => r.username)).toEqual(['newfriend', 'commenter_a', 'tagged_by_comment']);
        expect(rows[0]).toMatchObject({
            discoveredFrom: ['seedone'],
            discoverySignals: ['commenter', 'mention'],
            timesSeen: 2,
        });
        expect(rows[1].discoverySignals).toEqual(['commenter']);
        expect(rows[1].discoveryExamples).toEqual(['https://x/p/1/', 'https://x/p/2/']);
        expect(rows[1].sourceInput).toBe('seedone');
        // candidate lookups skip posts
        expect(h.mod.lookupProfile).toHaveBeenCalledWith(
            expect.objectContaining({ username: 'newfriend', maxRecentPosts: 0 }),
        );
    });

    it('screening flags each candidate; onlyPassing leaves out found profiles that fail (never blocked ones)', async () => {
        const lookupProfile = vi.fn(async ({ username }) => {
            if (username === 'seedone') return { profile: profileFor('seedone'), posts: seedPosts };
            if (username === 'newfriend')
                return { profile: profileFor(username, { followerCount: 900_000 }), posts: [] };
            if (username === 'commenter_a')
                return { profile: { recordType: 'profile', status: 'blocked', username }, posts: [] };
            return { profile: profileFor(username), posts: [] };
        });
        const h = expandHarness(
            {
                excludeUsernames: ['known_one'],
                maxRecentPosts: 2,
                maxFollowers: 150_000,
                requireContactEmail: true,
                onlyPassing: true,
            },
            { lookupProfile },
        );
        await h.run('expand');
        const rows = h.pushed.filter((r) => r.recordType === 'profile');
        expect(rows.map((r) => [r.username, r.passesFilters])).toEqual([
            ['commenter_a', false], // blocked: still written, marked as not passing
            ['tagged_by_comment', true],
        ]);
    });

    it('maxCandidates caps the number of profile lookups', async () => {
        const h = expandHarness({ maxCandidates: 1, maxRecentPosts: 2 });
        await h.run('expand');
        // 1 seed lookup + 1 candidate lookup
        expect(h.mod.lookupProfile).toHaveBeenCalledTimes(2);
    });

    it('a seed that cannot be read is written as a row with the reason and yields no candidates', async () => {
        const h = expandHarness(
            {},
            {
                lookupProfile: vi.fn(async () => ({
                    profile: { recordType: 'profile', status: 'blocked', username: 'seedone' },
                    posts: [],
                })),
            },
        );
        await h.run('expand');
        expect(h.pushed).toHaveLength(1);
        expect(h.pushed[0].statusDetail).toMatch(/Seed could not be read \(blocked\)/);
    });

    it('unavailable comments do not stop discovery: mentions from captions still produce candidates', async () => {
        const h = expandHarness({ maxRecentPosts: 2 }, { fetchComments: vi.fn().mockRejectedValue(new Error('boom')) });
        await h.run('expand');
        expect(h.pushed.filter((r) => r.recordType === 'profile').map((r) => r.username)).toEqual([
            'known_one',
            'newfriend',
        ]);
    });

    it('a rate limit while reading a seed stops the run and writes what was found so far', async () => {
        const lookupProfile = vi.fn().mockRejectedValue(new RateLimitError('instagram', 'profile', 'x'));
        const h = expandHarness({}, { lookupProfile });
        await h.run('expand');
        expect(h.rateLimitErrors).toHaveLength(1);
        expect(h.pushed).toEqual([]);
        expect(lookupProfile).toHaveBeenCalledTimes(1);
    });
});

describe('runMode: profile mode screening', () => {
    it('adds the verdict to each profile row when criteria are given, and null when not', async () => {
        const lookupProfile = vi.fn(async ({ username }) => ({
            profile: { recordType: 'profile', status: 'found', username, followerCount: 500_000, contactEmails: [] },
            posts: [],
        }));
        const withCriteria = harness({ input: { usernames: ['a'], maxFollowers: 150_000 }, mod: { lookupProfile } });
        await withCriteria.run('profile');
        expect(withCriteria.pushed[0]).toMatchObject({
            passesFilters: false,
            filterFailures: ['followers 500000 above 150000'],
        });
        const without = harness({ input: { usernames: ['a'] }, mod: { lookupProfile } });
        await without.run('profile');
        expect(without.pushed[0]).toMatchObject({ passesFilters: null, filterFailures: [] });
    });
});

describe('runMode: validation', () => {
    it('throws on an unknown mode', async () => {
        const h = harness();
        await expect(h.run('banana')).rejects.toThrow(/Unknown mode "banana"/);
    });
});
