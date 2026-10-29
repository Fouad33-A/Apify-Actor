import { describe, expect, it } from 'vitest';

import { channelMetrics, median } from '../src/metrics.js';

const DAY = 86_400_000;
const now = Date.parse('2026-10-29T12:00:00Z');
const post = (id, daysAgo, views, extra = {}) => ({
    id,
    date: new Date(now - daysAgo * DAY).toISOString(),
    views,
    forwarded: false,
    mentions: [],
    ...extra,
});

describe('median', () => {
    it('handles odd, even and empty', () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([1, 2, 3, 4])).toBe(2.5);
        expect(median([])).toBeNull();
    });
});

describe('channelMetrics', () => {
    it('counts posts per week over the window when the sample reaches back that far', () => {
        const posts = [post(10, 1, 1000), post(9, 5, 900), post(8, 12, 1100), post(7, 20, 800), post(6, 40, 700)];
        const m = channelMetrics(posts, { members: 10_000, windowDays: 30, now });
        // 4 posts in 30 days = 0.93 / week
        expect(m.postsPerWeek).toBe(0.93);
        expect(m.frequencyBasis).toBe('last 30 days');
        expect(m.medianViews).toBe(900);
        expect(m.medianViewsPctOfMembers).toBe(9);
    });
    it('uses the span of the sample and says so when the limit was reached inside the window', () => {
        const posts = [post(5, 1, 100), post(4, 2, 100), post(3, 3, 100), post(2, 4, 100)];
        const m = channelMetrics(posts, { windowDays: 30, now });
        expect(m.postsPerWeek).toBe(7);
        expect(m.frequencyBasis).toMatch(/^sample span/);
    });
    it('treats a channel with no older posts as covering the window', () => {
        const posts = [post(3, 1, 10), post(2, 2, 10), post(1, 3, 10)];
        const m = channelMetrics(posts, { windowDays: 30, exhausted: true, now });
        expect(m.postsPerWeek).toBe(0.7);
        expect(m.frequencyBasis).toBe('last 30 days');
    });
    it('leaves fresh posts out of the views and keeps figures null below 3 posts', () => {
        const fresh = [post(3, 0.1, 5), post(2, 2, 1000), post(1, 3, 2000)];
        const m = channelMetrics(fresh, { windowDays: 30, now });
        expect(m.viewsPostsUsed).toBe(2);
        expect(m.medianViews).toBeNull();
        expect(m.postsPerWeek).not.toBeNull();
        expect(channelMetrics([post(1, 1, 5), post(2, 2, 6)], { now }).postsPerWeek).toBeNull();
    });
    it('aggregates mentions without the channel itself and counts forwarded posts', () => {
        const posts = [
            post(3, 1, 1, { mentions: ['friend', 'self'], forwarded: true }),
            post(2, 2, 1, { mentions: ['friend'] }),
            post(1, 3, 1, { mentions: ['other'] }),
        ];
        const m = channelMetrics(posts, { now, self: 'self' });
        expect(m.mentionedAccounts).toEqual([
            { username: 'friend', postsMentioning: 2 },
            { username: 'other', postsMentioning: 1 },
        ]);
        expect(m.forwardedPostsPct).toBe(33.3);
    });
    it('returns empty facts for no posts', () => {
        const m = channelMetrics([], { now });
        expect(m).toMatchObject({ postsSampled: 0, postsPerWeek: null, medianViews: null, daysSinceLastPost: null });
    });
});
