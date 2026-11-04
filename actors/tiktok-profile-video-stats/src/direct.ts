import { Actor, log } from 'apify';
import { HttpCrawler, Request } from 'crawlee';
import { num } from './map.js';

/** Direct mode: plain HTTP, no browser, no reference Actor. Reads the JSON that TikTok embeds in the page HTML
 *  (profile stats and a video's five counts). It cannot list a creator's videos; that list is loaded separately by the page. */

const SCRIPT_RE = /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/;

export function embeddedScope(html: string): any | null {
    const m = SCRIPT_RE.exec(html);
    if (!m) return null;
    try { return JSON.parse(m[1])['__DEFAULT_SCOPE__'] ?? null; } catch { return null; }
}

const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const iso = (s: unknown) => { const n = Number(s); return n > 0 ? new Date(n * 1000).toISOString() : null; };

export function profileFromEmbedded(userInfo: any, scrapedAt: string) {
    const u = userInfo?.user ?? {};
    const st = userInfo?.statsV2 ?? userInfo?.stats ?? {};
    const st2 = userInfo?.stats ?? {};
    return {
        type: 'profile' as const,
        name: str(u.uniqueId), nickName: str(u.nickname), verified: Boolean(u.verified),
        privateAccount: Boolean(u.privateAccount), signature: u.signature ?? '',
        fans: num(st.followerCount ?? st2.followerCount), following: num(st.followingCount ?? st2.followingCount),
        heart: num(st.heartCount ?? st2.heartCount), video: num(st.videoCount ?? st2.videoCount), scrapedAt,
    };
}

export function videoFromEmbedded(item: any, scrapedAt: string) {
    const s = item.stats ?? {};
    const a = item.author;
    const uid = typeof a === 'string' ? a : a?.uniqueId;
    return {
        type: 'video' as const,
        id: str(item.id),
        webVideoUrl: uid ? `https://www.tiktok.com/@${uid}/video/${item.id}` : null,
        text: item.desc ?? '', createTimeISO: iso(item.createTime),
        playCount: num(s.playCount), diggCount: num(s.diggCount), commentCount: num(s.commentCount),
        collectCount: num(s.collectCount), shareCount: num(s.shareCount), repostCount: num(item.statsV2?.repostCount),
        isPinned: Boolean(item.isPinnedItem),
        hashtags: (item.textExtra ?? []).filter((t: any) => t.hashtagName).map((t: any) => t.hashtagName),
        textLanguage: str(item.textLanguage), duration: num(item.video?.duration),
        music: item.music ? { title: str(item.music.title), authorName: str(item.music.authorName), original: item.music.original ?? null } : null,
        authorMeta: { name: uid ?? null, nickName: typeof a === 'object' ? str(a?.nickname) : null, fans: num(item.authorStats?.followerCount), following: num(item.authorStats?.followingCount), heart: num(item.authorStats?.heartCount) },
        scrapedAt,
    };
}

export interface DirectResult { profiles: Set<string>; videoIds: Set<string>; okUrls: Set<string>; failed: { input: string; code: string; message: string }[] }

export async function runDirect(handles: string[], videoUrls: string[], proxyConfiguration: any): Promise<DirectResult> {
    const result: DirectResult = { profiles: new Set(), videoIds: new Set(), okUrls: new Set(), failed: [] };
    const proxy = await Actor.createProxyConfiguration(proxyConfiguration);
    const crawler = new HttpCrawler({
        proxyConfiguration: proxy,
        useSessionPool: true,
        persistCookiesPerSession: true,
        sessionPoolOptions: { maxPoolSize: 20, sessionOptions: { maxUsageCount: 3 } },
        maxConcurrency: 2,
        maxRequestRetries: 3,
        requestHandlerTimeoutSecs: 60,
        additionalMimeTypes: ['text/html'],
        async requestHandler({ request, body, session }) {
            const html = typeof body === 'string' ? body : body.toString('utf8');
            const scope = embeddedScope(html);
            const scrapedAt = new Date().toISOString();
            const kind = request.userData.kind as 'profile' | 'video';
            if (kind === 'profile') {
                const detail = scope?.['webapp.user-detail'];
                if (!detail?.userInfo) { session?.retire(); throw new Error('Profile data missing from page (likely blocked)'); }
                const row = profileFromEmbedded(detail.userInfo, scrapedAt);
                result.profiles.add(request.userData.handle);
                if (row.privateAccount) { await Actor.pushData([{ ...row, type: 'error', input: request.userData.handle, errorCode: 'PROFILE_PRIVATE' }]); return; }
                await Actor.pushData([row]);
            } else {
                const vd = scope?.['webapp.video-detail'];
                const item = vd?.itemInfo?.itemStruct;
                if (!item) {
                    if (vd && vd.statusCode && vd.statusCode !== 0) { result.failed.push({ input: request.url, code: 'NOT_FOUND', message: `TikTok status ${vd.statusCode}` }); return; }
                    session?.retire(); throw new Error('Video data missing from page (likely blocked)');
                }
                result.okUrls.add(request.url);
                if (!result.videoIds.has(String(item.id))) {
                    result.videoIds.add(String(item.id));
                    await Actor.pushData([{ ...videoFromEmbedded(item, scrapedAt), inputUrl: request.url }]);
                }
            }
        },
        async failedRequestHandler({ request }, error) {
            result.failed.push({ input: request.userData.handle ?? request.url, code: 'BLOCKED', message: String(error).slice(0, 200) });
        },
    });
    const reqs = [
        ...handles.map((h) => new Request({ url: `https://www.tiktok.com/@${h}`, uniqueKey: 'p:' + h, userData: { kind: 'profile', handle: h } })),
        ...videoUrls.map((u) => new Request({ url: u, uniqueKey: 'v:' + u, userData: { kind: 'video' } })),
    ];
    await crawler.run(reqs);
    log.info(`Direct mode: ${result.profiles.size} profile(s), ${result.videoIds.size} video(s), ${result.failed.length} failed`);
    return result;
}