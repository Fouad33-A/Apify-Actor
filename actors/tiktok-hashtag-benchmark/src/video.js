// A public TikTok video page carries the video's own numbers in its embedded JSON (no login): plays, likes, comments,
// shares, date, country and language of the post, hashtags. Pure parsing here; the request is made in main.js.

const SCRIPT = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/;

export function parseVideoPage(html) {
    const m = SCRIPT.exec(String(html ?? ''));
    if (!m) return { status: 'no_data', detail: 'the page has no embedded video data' };
    let json;
    try {
        json = JSON.parse(m[1]);
    } catch {
        return { status: 'no_data', detail: 'the embedded video data could not be read' };
    }
    const detail = json?.__DEFAULT_SCOPE__?.['webapp.video-detail'];
    const item = detail?.itemInfo?.itemStruct;
    if (!item)
        return {
            status: 'unavailable',
            detail: `TikTok returned no video (status ${detail?.statusCode ?? 'unknown'}${detail?.statusMsg ? `: ${detail.statusMsg}` : ''})`,
        };
    const s = item.stats ?? {};
    const tags = [
        ...new Set(
            [...(item.textExtra ?? []).map((t) => t.hashtagName), ...(item.challenges ?? []).map((c) => c.title)]
                .filter(Boolean)
                .map((t) => String(t).toLowerCase()),
        ),
    ];
    return {
        status: 'ok',
        video: {
            videoId: String(item.id),
            author: item.author?.uniqueId ?? null,
            description: String(item.desc ?? '').slice(0, 300),
            createdAt: item.createTime ? new Date(Number(item.createTime) * 1000).toISOString() : null,
            views: Number(s.playCount ?? 0),
            likes: Number(s.diggCount ?? 0),
            comments: Number(s.commentCount ?? 0),
            shares: Number(s.shareCount ?? 0),
            saves: Number(s.collectCount ?? 0),
            durationSeconds: item.video?.duration ?? null,
            region: item.locationCreated ?? null,
            language: item.textLanguage ?? null,
            hashtags: tags,
        },
    };
}

const WORD = '[A-Za-z0-9._]{2,24}';
// video addresses in a result page (plain or percent-encoded)
export function videoUrlsIn(html) {
    const text = String(html ?? '')
        .replace(/%2F/gi, '/')
        .replace(/%40/gi, '@');
    const found = new Map();
    for (const m of text.matchAll(new RegExp(`tiktok\\.com/@(${WORD})/video/(\\d{8,25})`, 'g'))) {
        found.set(m[2], `https://www.tiktok.com/@${m[1].toLowerCase()}/video/${m[2]}`);
    }
    return [...found.values()];
}

// A TikTok video id starts with the post time: the id's upper 32 bits are the unix time in seconds.
export function postedAtFromId(videoId) {
    try {
        const ms = Number(BigInt(videoId) >> 32n) * 1000;
        return ms > Date.UTC(2016, 0, 1) && ms < Date.now() + 86_400_000 ? ms : null;
    } catch {
        return null;
    }
}

// creator handles named anywhere in a result page (profile or video addresses)
export function handlesIn(html) {
    const text = String(html ?? '')
        .replace(/%2F/gi, '/')
        .replace(/%40/gi, '@');
    const found = new Set();
    for (const m of text.matchAll(new RegExp(`tiktok\\.com/@(${WORD})`, 'g'))) found.add(m[1].toLowerCase());
    return [...found];
}
