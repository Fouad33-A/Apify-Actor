import { it, expect } from 'vitest';
import { candidatesFromCreativeHtml, discoverFromCreativeCenter } from '../src/creative-center.js';

it('extracts unique TikTok handles from public links', () => {
    const html = '<a href="https://www.tiktok.com/@example/video/123">a</a><a href="https://www.tiktok.com/@example">b</a>';
    expect(candidatesFromCreativeHtml(html).map((x) => x.handle)).toEqual(['example']);
});
it('fails closed on unavailable public pages', async () => {
    const result = await discoverFromCreativeCenter({ pages: ['https://example.org'], fetchPage: async () => { throw new Error('unavailable'); } });
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics[0].status).toBe('unavailable');
});
