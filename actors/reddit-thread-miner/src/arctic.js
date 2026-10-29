import { gotScraping } from 'got-scraping';

const API = 'https://arctic-shift.photon-reddit.com/api/comments/search';

export function redditThreadId(value) {
    const s = String(value ?? '');
    const match = s.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i);
    return (match?.[1] ?? s.replace(/^t3_/, '')).toLowerCase();
}

export async function fetchArcticComments(threadUrlOrId, { limit = 20, fetch = fetchJson } = {}) {
    const threadId = redditThreadId(threadUrlOrId);
    if (!threadId) return { status: 'no_thread_id', comments: [] };

    // Ask Arctic Shift for more than the requested output so we can rank locally by
    // the archived Reddit score, then apply the user's maxCommentsPerThread limit.
    const size = Math.min(100, Math.max(limit * 5, 25));
    const url = `${API}?link_id=${encodeURIComponent(`t3_${threadId}`)}&limit=${size}`;

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

    const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];
    const byId = new Map();
    for (const row of rows) {
        const id = String(row?.id ?? '').replace(/^t1_/, '');
        const body = String(row?.body ?? '').trim();
        if (!id || !body || /^\[(deleted|removed)\]$/i.test(body)) continue;
        const old = byId.get(id);
        if (!old || body.length > old.body.length) byId.set(id, { ...row, id, body });
    }

    const comments = [...byId.values()]
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (Number(a.created_utc) || 0) - (Number(b.created_utc) || 0))
        .slice(0, limit)
        .map((row) => ({
            id: row.id,
            author: row.author && row.author !== '[deleted]' ? row.author : null,
            createdAt: Number.isFinite(Number(row.created_utc)) ? new Date(Number(row.created_utc) * 1000).toISOString() : null,
            text: row.body.slice(0, 1500),
            score: Number.isFinite(Number(row.score)) ? Number(row.score) : null,
            url: `https://www.reddit.com/comments/${threadId}/_/${row.id}/`,
            source: 'arctic_shift_archive',
            rankBasis: 'archived_reddit_score',
        }));

    return { status: comments.length ? 'ok' : 'archive_no_comments', comments };
}

async function fetchJson(url) {
    const res = await gotScraping({
        url,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: {
            'user-agent': 'reddit-thread-miner/0.1 (public archive reader)',
            accept: 'application/json,text/plain,*/*',
        },
    });
    return { status: res.statusCode, body: res.body };
}
