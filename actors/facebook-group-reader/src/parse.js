// What a public Facebook group page shows to a visitor who is not logged in. No login, cookie or token is used. When
// Facebook answers with its login page the result is "login_wall" and nothing is read. The page structure is not
// documented and changes often, so the post reader is a best effort: it looks for Facebook's own embedded JSON for
// message text, creation time and counts. Pure functions.
import * as cheerio from 'cheerio';

export function normalizeGroup(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return { error: 'empty' };
    const m =
        /^(?:https?:\/\/)?(?:www\.|m\.|mbasic\.|web\.)?facebook\.com\/groups\/([A-Za-z0-9._-]+)\/?/i.exec(raw) ??
        /^([A-Za-z0-9._-]{3,})$/.exec(raw);
    if (!m) return { error: 'not_a_group_address' };
    const id = m[1];
    if (['feed', 'discover', 'joins', 'create', 'search'].includes(id.toLowerCase()))
        return { error: 'not_a_group_address' };
    return { id, url: `https://www.facebook.com/groups/${id}` };
}

export function isLoginWall({ finalUrl = '', html = '' }) {
    if (/facebook\.com\/(login|checkpoint)/i.test(finalUrl)) return true;
    const title = cheerio.load(String(html))('title').first().text().trim();
    return /^(log in|log into facebook|facebook – log in)/i.test(title) && !/og:title/.test(html);
}

const num = (s) => {
    const m = /([\d][\d.,]*)\s*([KMB])?/i.exec(String(s ?? ''));
    if (!m) return null;
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
    return Math.round(parseFloat(m[1].replace(/,/g, '')) * mult);
};

export function parseGroupMeta(html) {
    const $ = cheerio.load(String(html ?? ''));
    const og = (p) => $(`meta[property="og:${p}"]`).attr('content') ?? null;
    const name = og('title') ?? ($('title').first().text().trim() || null);
    const description = og('description');
    const hay = `${description ?? ''} ${$('body').text().slice(0, 20_000)}`;
    const mm = /([\d][\d.,]*\s*[KMB]?)\s+(?:members|member)\b/i.exec(hay);
    const privacy = /\bpublic group\b/i.test(hay) ? 'public' : /\bprivate group\b/i.test(hay) ? 'private' : null;
    return { name, description, memberCount: mm ? num(mm[1]) : null, privacy };
}

function* walk(node, depth = 0) {
    if (depth > 40) return;
    if (Array.isArray(node)) for (const n of node) yield* walk(n, depth + 1);
    else if (node && typeof node === 'object') {
        yield node;
        for (const v of Object.values(node)) yield* walk(v, depth + 1);
    }
}

// posts from the JSON blobs embedded in the page: an object with message.text and a creation time
export function parsePosts(html, { includeAuthors = false } = {}) {
    const $ = cheerio.load(String(html ?? ''));
    const posts = new Map();
    $('script[type="application/json"]').each((_, el) => {
        let json;
        try {
            json = JSON.parse($(el).contents().text());
        } catch {
            return;
        }
        for (const node of walk(json)) {
            const text = node?.message?.text;
            const created = node?.creation_time ?? node?.creationTime ?? node?.created_time;
            if (typeof text !== 'string' || !text.trim() || !created) continue;
            const fb = node.feedback ?? node.comet_sections?.feedback ?? {};
            const url = node.url ?? node.wwwURL ?? node.permalink_url ?? null;
            const key = String(node.post_id ?? node.id ?? url ?? text.slice(0, 60));
            if (posts.has(key)) continue;
            posts.set(key, {
                postId: node.post_id ?? node.id ?? null,
                url,
                text: text.trim().slice(0, 5000),
                createdAt: new Date(Number(created) > 1e12 ? Number(created) : Number(created) * 1000).toISOString(),
                reactions: fb.reaction_count?.count ?? fb.i18n_reaction_count ?? null,
                comments:
                    fb.comment_count?.total_count ??
                    fb.comments_count_summary_renderer?.feedback?.comment_count?.total_count ??
                    null,
                shares: fb.share_count?.count ?? null,
                ...(includeAuthors ? { author: node.actors?.[0]?.name ?? node.author?.name ?? null } : {}),
            });
        }
    });
    return [...posts.values()];
}
