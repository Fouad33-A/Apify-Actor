// TikTok's public creator embed (https://www.tiktok.com/embed/@handle) lists a creator's recent videos with id, caption
// and play count, without a login. It is used to find recent videos that carry a hashtag from the creators the search
// found. Pure parsing here; requests are made in main.js.
import { gotScraping } from 'got-scraping';

import { postedAtFromId } from './video.js';

function* walk(node, depth = 0) {
    if (depth > 25) return;
    if (Array.isArray(node)) for (const n of node) yield* walk(n, depth + 1);
    else if (node && typeof node === 'object') {
        yield node;
        for (const v of Object.values(node)) yield* walk(v, depth + 1);
    }
}

export function parseEmbedPage(html) {
    const videos = new Map();
    for (const m of String(html ?? '').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
        const body = m[1].trim();
        if (!body.startsWith('{') && !body.startsWith('[')) continue;
        let json;
        try {
            json = JSON.parse(body);
        } catch {
            continue;
        }
        for (const o of walk(json)) {
            const id = o.id ?? o.awemeId ?? o.itemId;
            if (typeof id !== 'string' || !/^\d{15,25}$/.test(id)) continue;
            if (!('desc' in o || 'playCount' in o || 'stats' in o)) continue;
            videos.set(id, {
                id,
                description: String(o.desc ?? ''),
                views: Number(o.playCount ?? o.stats?.playCount ?? NaN),
                author: o.authorUniqueId ?? o.author?.uniqueId ?? null,
                postedAt: postedAtFromId(id),
            });
        }
    }
    return [...videos.values()];
}

export async function fetchEmbed(handle) {
    const res = await gotScraping({
        url: `https://www.tiktok.com/embed/@${handle}`,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    return { status: res.statusCode, html: res.body };
}

// recent videos of one creator that mention the hashtag
export function taggedRecent(videos, { tag, recentDays, now }) {
    const re = new RegExp(`#${tag}(?![\\w])`, 'i');
    return videos.filter(
        (v) => re.test(v.description) && (v.postedAt == null || now - v.postedAt <= recentDays * 86_400_000),
    );
}
