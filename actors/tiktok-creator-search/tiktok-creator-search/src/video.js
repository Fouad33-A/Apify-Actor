// A public TikTok video page names the country and language the video was posted with. Used to place a creator when
// the profile data has no country: the region of their latest video. Pure parsing; the request is made in main.js.
import { gotScraping } from 'got-scraping';

const SCRIPT = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/;

export function parseVideoPlace(html) {
    const m = SCRIPT.exec(String(html ?? ''));
    if (!m) return null;
    try {
        const item = JSON.parse(m[1])?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
        if (!item) return null;
        return {
            region: item.locationCreated ? String(item.locationCreated).toUpperCase() : null,
            language: item.textLanguage ?? null,
        };
    } catch {
        return null;
    }
}

export async function fetchVideoPlace(url) {
    const res = await gotScraping({
        url,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    return res.statusCode === 200 ? parseVideoPlace(res.body) : null;
}
