/** Normalises rows from the reference TikTok Actor into our output contract (field names follow the brief). */
export const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

export function mapVideo(r: any, scrapedAt: string) {
    const a = r.authorMeta ?? {};
    const hashtags = Array.isArray(r.hashtags) ? r.hashtags.map((h: any) => (typeof h === 'string' ? h : h?.name)).filter(Boolean) : [];
    return {
        type: 'video' as const,
        id: str(r.id),
        webVideoUrl: str(r.webVideoUrl),
        text: r.text ?? '',
        createTimeISO: str(r.createTimeISO),
        playCount: num(r.playCount),
        diggCount: num(r.diggCount),
        commentCount: num(r.commentCount),
        collectCount: num(r.collectCount),
        shareCount: num(r.shareCount),
        repostCount: num(r.repostCount),
        isPinned: Boolean(r.isPinned),
        hashtags,
        textLanguage: str(r.textLanguage),
        duration: num(r.videoMeta?.duration),
        music: r.musicMeta ? { title: str(r.musicMeta.musicName), authorName: str(r.musicMeta.musicAuthor), original: r.musicMeta.musicOriginal ?? null } : null,
        authorMeta: { name: str(a.name), nickName: str(a.nickName), fans: num(a.fans), following: num(a.following), heart: num(a.heart) },
        scrapedAt,
    };
}

export function mapProfile(r: any, scrapedAt: string) {
    const a = r.authorMeta ?? {};
    return {
        type: 'profile' as const,
        name: str(a.name),
        nickName: str(a.nickName),
        verified: Boolean(a.verified),
        privateAccount: Boolean(a.privateAccount),
        signature: a.signature ?? '',
        fans: num(a.fans),
        following: num(a.following),
        heart: num(a.heart),
        video: num(a.video),
        scrapedAt,
    };
}

export const handleOf = (input: string): string =>
    String(input).trim().replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '').toLowerCase();