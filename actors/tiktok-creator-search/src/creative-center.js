// Experimental zero-subscription discovery from TikTok's public Creative Center pages.
// Public HTML only: no login, proxy, browser automation, or undocumented API endpoints.
// A page that omits profile URLs simply yields zero candidates; it never fabricates handles.
import { gotScraping } from 'got-scraping';
import { fromCandidateFeed } from './candidate-source.js';
import { tiktokUrlsInText } from './serp.js';

export const CREATIVE_CENTER_PAGES = [
    'https://ads.tiktok.com/creative/creativeCenter/trends',
    'https://ads.tiktok.com/creative/creativeCenter/trends/video?period=7',
    'https://ads.tiktok.com/creative/creativeCenter/trends/video?period=30',
];

export function candidatesFromCreativeHtml(html, known = []) {
    const urls = tiktokUrlsInText(html).filter((url) => /tiktok\.com\/@/i.test(url));
    return fromCandidateFeed(urls, known);
}

export async function discoverFromCreativeCenter({
    pages = CREATIVE_CENTER_PAGES,
    known = [],
    fetchPage = async (url) => {
        const response = await gotScraping({
            url,
            timeout: { request: 8000 },
            retry: { limit: 0 },
            throwHttpErrors: false,
        });
        if (response.statusCode !== 200) throw new Error('HTTP ' + response.statusCode);
        return response.body;
    },
} = {}) {
    const results = [];
    const diagnostics = [];
    const seen = new Set(known);
    for (const url of pages.slice(0, 3)) {
        try {
            const html = await fetchPage(url);
            const candidates = candidatesFromCreativeHtml(html, [...seen]);
            for (const candidate of candidates) {
                seen.add(candidate.handle);
                results.push(candidate);
            }
            diagnostics.push({ url, status: 'ok', handles: candidates.length });
        } catch (error) {
            diagnostics.push({ url, status: 'unavailable', detail: String(error?.message ?? error).slice(0, 120) });
        }
    }
    return { candidates: results, diagnostics };
}
