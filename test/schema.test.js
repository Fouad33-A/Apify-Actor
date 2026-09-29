import { describe, expect, it } from 'vitest';

import {
    extractEmails,
    makeCommentRow,
    makePostRow,
    makeProfileRow,
    makeRunSummary,
    parseAbbrevCount,
} from '../src/schema.js';

describe('row shapes', () => {
    it('profile row: unknown fields are explicit null / [] - never omitted, never guessed', () => {
        const row = makeProfileRow({ platform: 'instagram', sourceInput: 'nasa', status: 'found' });
        expect(row).toMatchObject({
            recordType: 'profile',
            platform: 'instagram',
            sourceInput: 'nasa',
            status: 'found',
            username: null,
            displayName: null,
            bio: null,
            followerCount: null,
            followingCount: null,
            postCount: null,
            totalLikes: null,
            verified: null,
            accountCreatedDate: null,
            externalLinks: [],
            statusDetail: null,
        });
    });

    it('keeps a real 0 (not coerced to null) and a real false', () => {
        const row = makeProfileRow({
            platform: 'instagram',
            sourceInput: 'x',
            status: 'found',
            followerCount: 0,
            postCount: 0,
            verified: false,
        });
        expect(row.followerCount).toBe(0);
        expect(row.postCount).toBe(0);
        expect(row.verified).toBe(false);
    });

    it('post row: metrics default to null and status defaults to found', () => {
        const row = makePostRow({ platform: 'instagram', sourceInput: 'nasa', postUrl: 'https://x/p/1/' });
        expect(row).toMatchObject({
            recordType: 'post',
            likeCount: null,
            commentCount: null,
            shareCount: null,
            viewCount: null,
            isSponsored: null,
            publishDate: null,
            status: 'found',
        });
    });

    it('comment row: isReply defaults to false, everything else unknown is null', () => {
        const row = makeCommentRow({ platform: 'instagram', sourceInput: 'u', postUrl: 'https://x/p/1/' });
        expect(row).toMatchObject({
            recordType: 'comment',
            commenterUsername: null,
            commentText: null,
            likeCount: null,
            commentDate: null,
            isReply: false,
            status: 'found',
        });
    });

    it('every row carries an ISO scrapedAt timestamp', () => {
        for (const row of [
            makeProfileRow({ platform: 'facebook', sourceInput: 'a', status: 'found' }),
            makePostRow({ platform: 'facebook', sourceInput: 'a' }),
            makeCommentRow({ platform: 'facebook', sourceInput: 'a', postUrl: 'u' }),
        ]) {
            expect(new Date(row.scrapedAt).toISOString()).toBe(row.scrapedAt);
        }
    });

    it('profile status is NOT defaulted - a caller that forgets it produces undefined, so pass it explicitly', () => {
        expect(makeProfileRow({ platform: 'instagram', sourceInput: 'x' }).status).toBeUndefined();
    });

    it('makeRunSummary maps its inputs to the documented summary keys', () => {
        const s = makeRunSummary({
            mode: 'profile',
            platform: 'instagram',
            startedAt: '2026-09-29T00:00:00.000Z',
            counts: { total: 1 },
            budget: { maxItemsPerRun: 5 },
            errors: [],
        });
        expect(Object.keys(s).sort()).toEqual(
            ['budget', 'finishedAt', 'itemCounts', 'mode', 'platform', 'rateLimitErrors', 'startedAt'].sort(),
        );
        expect(s.itemCounts).toEqual({ total: 1 });
        expect(s.rateLimitErrors).toEqual([]);
    });
});

describe('parseAbbrevCount', () => {
    it.each([
        ['104,333,810', 104_333_810],
        ['104M', 104_000_000],
        ['1.2K', 1200],
        ['3.5B', 3_500_000_000],
        ['4,937', 4937],
        ['0', 0],
        [' 12 K ', 12_000],
    ])('%s -> %s', (input, expected) => {
        expect(parseAbbrevCount(input)).toBe(expected);
    });

    it.each([[null], [undefined], [''], ['abc'], ['12X']])('%j -> null', (input) => {
        expect(parseAbbrevCount(input)).toBeNull();
    });
});

describe('extractEmails', () => {
    it('finds emails in public text, lower-cased and de-duplicated', () => {
        expect(
            extractEmails('Contact: Public-Inquiries@HQ.nasa.gov or public-inquiries@hq.nasa.gov, team@example.org.'),
        ).toEqual(['public-inquiries@hq.nasa.gov', 'team@example.org']);
    });

    it.each([[null], [undefined], [''], ['no email here'], ['almost@nodot']])('%j -> []', (input) => {
        expect(extractEmails(input)).toEqual([]);
    });
});

describe('contactEmails on profile rows', () => {
    it('defaults to an empty list and keeps what is given', () => {
        expect(makeProfileRow({ platform: 'facebook', sourceInput: 'x', status: 'found' }).contactEmails).toEqual([]);
        expect(
            makeProfileRow({ platform: 'facebook', sourceInput: 'x', status: 'found', contactEmails: ['a@b.co'] })
                .contactEmails,
        ).toEqual(['a@b.co']);
    });
});
