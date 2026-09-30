import { describe, expect, it } from 'vitest';

import { parseCookieHeader, resolveSessionCookies } from '../src/cookies.js';

describe('parseCookieHeader', () => {
    it('parses name=value pairs into Playwright cookie objects', () => {
        expect(parseCookieHeader('sessionid=abc; csrftoken=xyz', 'www.instagram.com')).toEqual([
            { name: 'sessionid', value: 'abc', domain: 'www.instagram.com', path: '/' },
            { name: 'csrftoken', value: 'xyz', domain: 'www.instagram.com', path: '/' },
        ]);
    });

    it.each([undefined, null, '', '   '])('returns [] for %j', (input) => {
        expect(parseCookieHeader(input, '.facebook.com')).toEqual([]);
    });

    it("keeps '=' inside a value (base64 / URL-encoded tokens)", () => {
        const [c] = parseCookieHeader('token=abc==def=', '.facebook.com');
        expect(c.value).toBe('abc==def=');
    });

    it("trims whitespace and skips empty segments and pairs without '='", () => {
        const cookies = parseCookieHeader(' a = 1 ;; junk ; b=2 ; ', '.facebook.com');
        expect(cookies.map((c) => [c.name, c.value])).toEqual([
            ['a', '1'],
            ['b', '2'],
        ]);
    });

    it('skips a pair with an empty name', () => {
        expect(parseCookieHeader('=oops; ok=1', '.facebook.com').map((c) => c.name)).toEqual(['ok']);
    });

    it("tolerates a leading 'Cookie:' prefix as copied from DevTools request headers", () => {
        const cookies = parseCookieHeader('Cookie: sessionid=abc; csrftoken=xyz', 'www.instagram.com');
        expect(cookies.map((c) => c.name)).toEqual(['sessionid', 'csrftoken']);
    });
});

describe('resolveSessionCookies', () => {
    it('the input wins', () => {
        expect(
            resolveSessionCookies({ input: 'a=1', env: { SESSION_COOKIES_TIKTOK: 'b=2' }, platform: 'tiktok' }),
        ).toEqual({
            header: 'a=1',
            source: 'input',
        });
    });
    it('falls back to the platform environment variable', () => {
        expect(
            resolveSessionCookies({ input: '', env: { SESSION_COOKIES_TIKTOK: 'b=2' }, platform: 'tiktok' }),
        ).toEqual({
            header: 'b=2',
            source: 'environment',
        });
    });
    it("does not use another platform's variable, and returns nothing when none is set", () => {
        expect(resolveSessionCookies({ env: { SESSION_COOKIES_INSTAGRAM: 'x=1' }, platform: 'tiktok' })).toEqual({
            header: '',
            source: null,
        });
        expect(
            resolveSessionCookies({ input: '  ', env: { SESSION_COOKIES_TIKTOK: '  ' }, platform: 'tiktok' }).source,
        ).toBeNull();
    });
});
