import { describe, expect, it } from 'vitest';

import { toPlaywrightProxy } from '../src/proxy.js';

describe('toPlaywrightProxy', () => {
    it('splits embedded credentials into separate fields (Chromium ignores them in the URL)', () => {
        expect(toPlaywrightProxy('http://groups-RESIDENTIAL:pw123@proxy.apify.com:8000')).toEqual({
            server: 'http://proxy.apify.com:8000',
            username: 'groups-RESIDENTIAL',
            password: 'pw123',
        });
    });

    it('never leaves credentials in the server URL', () => {
        expect(toPlaywrightProxy('http://user:pass@proxy.apify.com:8000').server).not.toMatch(/user|pass|@/);
    });

    it('decodes percent-encoded credentials', () => {
        const p = toPlaywrightProxy('http://us%40er:p%3Ass%2F@proxy.apify.com:8000');
        expect(p.username).toBe('us@er');
        expect(p.password).toBe('p:ss/');
    });

    it('omits username/password when the URL has none', () => {
        expect(toPlaywrightProxy('http://proxy.example.com:3128')).toEqual({ server: 'http://proxy.example.com:3128' });
    });

    it('returns undefined when there is no proxy (proxy off)', () => {
        expect(toPlaywrightProxy(undefined)).toBeUndefined();
        expect(toPlaywrightProxy('')).toBeUndefined();
    });
});
