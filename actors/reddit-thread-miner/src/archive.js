import { gotScraping } from 'got-scraping';

const API = 'https://api.pullpush.io/reddit/search/comment/';

export function redditThreadId(urlOrId) {
    const s = String(urlOrId ?? '');
    const m = s.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i);
    return (m?.[1] ?? s.replace(/^t3_/, '')).toLowerCase();
}

export async function fetchArchivedComments(threadUrl, { limit = 20, fetch = fetchJson } = {}) {
    const threadId = redditThreadId(threadUrl);
    if (!threadId) return { status: 'no_thread_id', comments: [] };
    const size = Math.min(100, Math.max(limit * 4, limit, 20));
    const url = `${API}?link_id=${encodeURIComponent(threadId)}&size=${size}`;
    let res;
    try {
        res = await fetch(url);
    } catch (error) {
        return { status: 'archive_error', detail: String(error?.message ?? error), comments: [] };
    }
    if (res.status === 429) return { status: 'archive_rate_limited', comments: [] };
    if (res.status !== 200) return { status: 'archive_http_error', detail: `HTTP ${res.status}`, comments: [] };
    let parsed;
    try {
        parsed = JSON.parse(res.body);
    } catch {
        return { status: 'archive_unreadable', comments: [] };
    }
    const rows = Array.isArray(parsed?.data) ? parsed.data : [];
    const byId = new Map();
    for (const c of rows) {
        const body = String(c?.body ?? '').trim();
        if (!c?.id || !body || /^\[(deleted|removed)\]$/i.test(body)) continue;
        const old = byId.get(c.id);
        if (!old || body.length > old.body.length) byId.set(c.id, { ...c, body });
    }
    const comments = [...byId.values()]
        .sort(
            (a, b) =>
                (Number(b.score) || 0) - (Number(a.score) || 0) ||
                (Number(a.created_utc) || 0) - (Number(b.created_utc) || 0),
        )
        .slice(0, limit)
        .map((c) => ({
            id: c.id,
            author: c.author && c.author !== '[deleted]' ? c.author : null,
            createdAt: Number.isFinite(Number(c.created_utc))
                ? new Date(Number(c.created_utc) * 1000).toISOString()
                : null,
            text: c.body.slice(0, 1500),
            score: Number.isFinite(Number(c.score)) ? Number(c.score) : null,
            url: `https://www.reddit.com/comments/${threadId}/_/${c.id}/`,
            source: 'public_archive',
        }));
    return { status: comments.length ? 'ok' : 'archive_no_comments', comments };
}

async function fetchJson(url) {
    const res = await gotScraping({
        url,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: {
            'user-agent': 'Mozilla/5.0 (compatible; reddit-thread-miner/0.1; public archive reader)',
            accept: 'application/json,text/plain,*/*',
        },
    });
    return { status: res.statusCode, body: res.body };
}
