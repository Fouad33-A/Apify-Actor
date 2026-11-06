// Candidate source adapter: accepts independently collected public TikTok profile URLs or handles.
// No network calls, paid services, or assumed follower statistics. Screening remains authoritative.
const HANDLE = /^(?=.{2,24}$)(?=.*[a-z0-9])[a-z0-9._]+$/i;
export function normalizeCandidate(value) {
    const raw = typeof value === 'string' ? value : value?.url ?? value?.handle ?? '';
    const text = String(raw).trim();
    const match = text.match(/(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([^/?#]+)/i);
    const handle = (match ? match[1] : text.replace(/^@/, '')).toLowerCase();
    if (!HANDLE.test(handle) || handle.startsWith('.') || handle.endsWith('.') || handle.includes('..')) return null;
    return handle;
}
export function fromCandidateFeed(values, known = []) {
    const excluded = new Set(known.map(normalizeCandidate).filter(Boolean));
    const unique = new Set();
    for (const value of values ?? []) {
        const handle = normalizeCandidate(value);
        if (handle && !excluded.has(handle)) unique.add(handle);
    }
    return [...unique].map((handle) => ({
        handle, queries: ['candidate_feed'], timesSeen: 1,
        profileHit: true, snippets: [], hint: null, videoUrls: [],
    }));
}
