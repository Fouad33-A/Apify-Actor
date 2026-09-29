import { describe, expect, it, vi } from 'vitest';

import { BudgetTracker } from '../src/budget.js';
import { RateLimitError } from '../src/errors.js';
import { runMode } from '../src/run.js';

vi.mock('apify', () => ({
    log: { warning: vi.fn(), exception: vi.fn(), info: vi.fn() },
}));

const post = (n) => ({ postUrl: `https://x/p/${n}/` });

function harness({ input = {}, cap = 1000, mod = {} } = {}) {
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
        expect(h.pushed.map((r) => r.id)).toEqual(['B']);
        expect(h.rateLimitErrors).toEqual([]);
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
        expect(h.pushed).toEqual([]);
    });
});

describe('runMode: validation', () => {
    it('throws on an unknown mode', async () => {
        const h = harness();
        await expect(h.run('banana')).rejects.toThrow(/Unknown mode "banana"/);
    });
});
