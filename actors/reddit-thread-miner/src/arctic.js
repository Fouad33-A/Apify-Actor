import { gotScraping } from 'got-scraping';

const API = 'https://arctic-shift.photon-reddit.com/api/comments/search';

export function redditThreadId(value) {
    const s = String(value ?? '');
    const match = s.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i);
    return (match?.[1] ?? s.replace(/^t3_/, '')).toLowerCase();
}


const POSTS_API = 'https://arctic-shift.photon-reddit.com/api/posts/search';
const errorDetail = (body) => {
    try { const data = JSON.parse(String(body ?? '')); return String(data.detail ?? data.message ?? data.error ?? '').slice(0, 400); }
    catch { return String(body ?? '').replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 400); }
};

export async function discoverArcticThreads({
    subreddit, keywords = [], maxThreads = 100, dateFromMs = null, dateToMs = null,
    fetch = fetchJson, beforeRequest = () => true, shouldStop = () => false,
} = {}) {
    const found = new Map();
    const attempts = [];
    let rateLimited = false;
    for (const keyword of keywords.length ? keywords : ['']) {
        if (shouldStop() || found.size >= maxThreads) break;
        const params = new URLSearchParams({
            subreddit, sort: 'desc', limit: String(Math.min(100, Math.max(1, maxThreads))),
        });
        if (keyword) params.set('query', keyword);
        if (dateFromMs != null) params.set('after', new Date(dateFromMs).toISOString().slice(0, 10));
        if (dateToMs != null) params.set('before', new Date(dateToMs + 1000).toISOString().slice(0, 10));
        if (!beforeRequest()) break;
        let res;
        try { res = await fetch(`${POSTS_API}?${params}`); }
        catch (error) { attempts.push({ keyword, status: 'error', detail: String(error?.message ?? error) }); continue; }
        attempts.push({ keyword, status: res.status, ...(res.status !== 200 ? { detail: errorDetail(res.body) } : {}) });
        if (res.status === 429) { rateLimited = true; break; }
        if (res.status === 422 && !shouldStop()) {
            // One bounded retry with a smaller page. Preserve date filters; never silently narrow the user's requested range.
            params.set('limit', String(Math.min(10, Number(params.get('limit')))));
            if (beforeRequest()) {
                try {
                    res = await fetch(`${POSTS_API}?${params}`);
                    attempts.push({ keyword, status: res.status, retry: 'smaller_limit', ...(res.status !== 200 ? { detail: errorDetail(res.body) } : {}) });
                } catch (error) {
                    attempts.push({ keyword, status: 'error', retry: 'smaller_limit', detail: String(error?.message ?? error) });
                    continue;
                }
            } else break;
        }
        if (res.status === 429) { rateLimited = true; break; }
        if (res.status !== 200) continue;
        let parsed;
        try { parsed = JSON.parse(res.body); } catch { attempts.at(-1).detail = 'invalid_json'; continue; }
        const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];
        for (const post of rows) {
            const id = String(post?.id ?? '').replace(/^t3_/, '');
            const timestamp = Number(post?.created_utc) * 1000;
            if (!id || !Number.isFinite(timestamp) || timestamp <= 0) continue;
            if (dateFromMs != null && timestamp < dateFromMs) continue;
            if (dateToMs != null && timestamp > dateToMs) continue;
            if (String(post.subreddit ?? '').toLowerCase() !== String(subreddit).toLowerCase()) continue;
            const key = `t3_${id}`;
            if (found.has(key)) {
                if (keyword && !found.get(key).matchedKeywords.includes(keyword)) found.get(key).matchedKeywords.push(keyword);
                continue;
            }
            if (found.size >= maxThreads) break;
            found.set(key, {
                id: key, title: String(post.title ?? ''), text: String(post.selftext ?? '').slice(0, 5000),
                url: `https://www.reddit.com/r/${subreddit}/comments/${id}/`,
                author: post.author && post.author !== '[deleted]' ? post.author : null,
                updated: new Date(timestamp).toISOString(),
                score: typeof post.score === 'number' ? post.score : null,
                numComments: typeof post.num_comments === 'number' ? post.num_comments : null,
                matchedKeywords: keyword ? [keyword] : [],
            });
        }
        attempts.at(-1).found = rows.length;
    }
    return { threads: [...found.values()], attempts, rateLimited };
}

export async function fetchArcticComments(threadUrlOrId, { limit = 20, fetch = fetchJson, beforeRequest = () => true } = {}) {
    const threadId = redditThreadId(threadUrlOrId);
    if (!threadId) return { status: 'no_thread_id', comments: [] };

    // Ask Arctic Shift for more than the requested output so we can rank locally by
    // the archived Reddit score, then apply the user's maxCommentsPerThread limit.
    const size = Math.min(100, Math.max(limit * 5, 25));
    const url = `${API}?link_id=${encodeURIComponent(`t3_${threadId}`)}&limit=${size}`;

    if (!beforeRequest()) return { status: 'limit_reached', comments: [] };
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
