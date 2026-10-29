import { describe, expect, it } from 'vitest';

import { mentionedAccounts, normalizeChannel, parseCount, parsePreviewPage, parseProfileCard } from '../src/parse.js';
import { notFoundHtml, previewHtml, profileCardHtml } from './fixtures.js';

describe('parseCount', () => {
    it('reads Telegram number styles', () => {
        expect(parseCount('1.2K')).toBe(1200);
        expect(parseCount('3.4M')).toBe(3_400_000);
        expect(parseCount('12 345')).toBe(12_345);
        expect(parseCount('12,345')).toBe(12_345);
        expect(parseCount('957')).toBe(957);
        expect(parseCount('2B')).toBe(2_000_000_000);
    });
    it('returns null for text that is not a count', () => {
        expect(parseCount('')).toBeNull();
        expect(parseCount(null)).toBeNull();
        expect(parseCount('views')).toBeNull();
    });
});

describe('normalizeChannel', () => {
    it.each([
        ['durov', 'durov'],
        ['@durov', 'durov'],
        ['https://t.me/durov', 'durov'],
        ['https://t.me/s/durov', 'durov'],
        ['t.me/durov/123', 'durov'],
        ['https://telegram.me/durov?start=1', 'durov'],
    ])('%s -> %s', (input, username) => {
        expect(normalizeChannel(input)).toEqual({ username });
    });
    it('rejects invite links and junk', () => {
        expect(normalizeChannel('https://t.me/+AbCdEf123')).toEqual({ error: 'invite_link' });
        expect(normalizeChannel('https://t.me/joinchat/AAAA')).toEqual({ error: 'invite_link' });
        expect(normalizeChannel('ab')).toEqual({ error: 'invalid' });
        expect(normalizeChannel('')).toEqual({ error: 'invalid' });
        expect(normalizeChannel('not a name')).toEqual({ error: 'invalid' });
    });
});

describe('mentionedAccounts', () => {
    it('finds t.me links and @names, lower-cased, without Telegram feature addresses', () => {
        const found = mentionedAccounts('Join @Friend_One and https://t.me/Other_Channel now. mail me@x.com', [
            'https://t.me/third_chan',
            'https://t.me/joinchat/XXXX',
        ]);
        expect(found.sort()).toEqual(['friend_one', 'other_channel', 'third_chan']);
    });
});

describe('parsePreviewPage', () => {
    const html = previewHtml({
        subscribers: '12.3K',
        before: 100,
        posts: [
            { id: 101, date: '2026-10-20T10:00:00+00:00', views: '1.5K', text: 'Hello @Partner_Chan', reactions: 30 },
            {
                id: 102,
                date: '2026-10-21T10:00:00+00:00',
                views: '900',
                text: 'Deal',
                forwardedFrom: 'Other',
                photo: true,
            },
            { id: 103, date: '2026-10-22T10:00:00+00:00', text: 'No views here', reply: true },
        ],
    });
    const page = parsePreviewPage(html);

    it('reads the channel header', () => {
        expect(page.found).toBe(true);
        expect(page.title).toBe('Demo Channel');
        expect(page.username).toBe('demo');
        expect(page.members).toBe(12_300);
        expect(page.memberLabel).toBe('subscribers');
        expect(page.counters.photos).toBe(1200);
        expect(page.description).toBe('Daily news & offers');
        expect(page.nextBefore).toBe(100);
    });
    it('reads posts with views, dates, flags and mentions', () => {
        expect(page.posts).toHaveLength(3);
        const [a, b, c] = page.posts;
        expect(a).toMatchObject({ id: 101, views: 1500, reactions: 30, forwarded: false, mentions: ['partner_chan'] });
        expect(a.date).toBe('2026-10-20T10:00:00.000Z');
        expect(b).toMatchObject({
            id: 102,
            views: 900,
            forwarded: true,
            forwardedFrom: 'Other',
            mediaTypes: ['photo'],
        });
        expect(c).toMatchObject({ id: 103, views: null, isReply: true });
    });
    it('says found=false for a page without a channel', () => {
        expect(parsePreviewPage(profileCardHtml({})).found).toBe(false);
    });
});

describe('parseProfileCard', () => {
    it('reads subscribers of a channel without a preview', () => {
        expect(parseProfileCard(profileCardHtml({ extra: '5 400 subscribers' }))).toMatchObject({
            members: 5400,
            kind: 'channel',
        });
    });
    it('tells a group, a bot and a person apart', () => {
        expect(parseProfileCard(profileCardHtml({ extra: '1 200 members, 85 online' }))).toMatchObject({
            members: 1200,
            onlineMembers: 85,
            kind: 'group',
        });
        expect(parseProfileCard(profileCardHtml({ extra: '3 000 monthly users' })).kind).toBe('bot');
        expect(parseProfileCard(profileCardHtml({ extra: '@someone' })).kind).toBe('user');
    });
    it('has no kind for an unknown address', () => {
        const card = parseProfileCard(notFoundHtml());
        expect(card.kind).toBeNull();
        expect(card.members).toBeNull();
    });
});

describe('parseCount spaces', () => {
    it('accepts non-breaking and thin spaces as thousand separators', () => {
        expect(parseCount('12 345')).toBe(12_345);
        expect(parseCount('1 200')).toBe(1200);
    });
});
