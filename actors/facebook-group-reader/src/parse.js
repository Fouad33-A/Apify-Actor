// Parse only data Facebook itself embeds in public logged-out group HTML.
// No Facebook authentication, account cookies, access tokens, private API calls, or CAPTCHA handling.
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
    let privacy = /\bpublic group\b/i.test(hay) ? 'public' : /\bprivate group\b/i.test(hay) ? 'private' : null;
    if (!privacy && /Anyone can see who(?:'|’)s in the group and what they post\./i.test(String(html)))
        privacy = 'public';
    return { name, description, memberCount: mm ? num(mm[1]) : null, privacy };
}

function* walk(root) {
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        yield node;
        if (Array.isArray(node)) {
            for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        } else {
            for (const value of Object.values(node)) stack.push(value);
        }
    }
}

const validPostUrl = (value) =>
    typeof value === 'string' && /facebook\.com\/groups\/[^/]+\/(?:posts|permalink)\/\d+/i.test(value);
const legacyIdFromUrl = (value) => /\/(?:posts|permalink)\/(\d+)/i.exec(String(value ?? ''))?.[1] ?? null;
const isoFromUnix = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
};

function firstNumber(...values) {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    }
    return null;
}

function textFromNode(node) {
    if (typeof node?.message?.text === 'string' && node.message.text.trim()) return node.message.text.trim();
    if (typeof node?.text === 'string' && node.text.trim() && node?.__typename === 'Message') return node.text.trim();

    // Current logged-out Comet group feed uses a rich_message array rather than message.text.
    // Keep block order and join only textual composed-message blocks belonging to this story fragment.
    if (Array.isArray(node?.rich_message)) {
        const blocks = node.rich_message
            .map((block) => (typeof block?.text === 'string' ? block.text.trim() : ''))
            .filter(Boolean);
        if (blocks.length) return blocks.join('\n');
    }

    const rich = node?.comet_sections?.content?.story?.comet_sections?.message?.rich_message;
    if (Array.isArray(rich)) {
        const blocks = rich.map((block) => (typeof block?.text === 'string' ? block.text.trim() : '')).filter(Boolean);
        if (blocks.length) return blocks.join('\n');
    }
    return null;
}

function mergeRecord(target, node) {
    const message = textFromNode(node);
    const url =
        [
            node?.permalink_url,
            node?.url,
            node?.wwwURL,
            node?.comet_sections?.content?.story?.comet_sections?.message?.story?.url,
        ].find(validPostUrl) ?? null;
    const legacyId = String(node?.post_id ?? legacyIdFromUrl(url) ?? '') || null;
    const nestedStoryId = node?.comet_sections?.content?.story?.comet_sections?.message?.story?.id;
    const storyId =
        typeof node?.id === 'string' && node.id.startsWith('Uzpf')
            ? node.id
            : typeof nestedStoryId === 'string' && nestedStoryId.startsWith('Uzpf')
              ? nestedStoryId
              : null;
    const feedbackId =
        typeof node?.feedback?.id === 'string'
            ? node.feedback.id
            : typeof node?.feedback_id === 'string'
              ? node.feedback_id
              : null;
    const createdAt = isoFromUnix(node?.creation_time ?? node?.creationTime ?? node?.created_time);
    const actor = node?.actors?.[0] ?? node?.feedback?.owning_profile ?? node?.author ?? null;
    const fb = node?.feedback ?? {};
    const reactions = firstNumber(
        fb?.reaction_count?.count,
        fb?.unified_reactors?.count,
        fb?.reactors?.count,
        fb?.reaction_count_reduced,
        node?.reaction_count?.count,
    );
    const comments = firstNumber(
        fb?.comment_rendering_instance?.comments?.total_count,
        fb?.comments_count_summary_renderer?.feedback?.comment_rendering_instance?.comments?.total_count,
        fb?.comments_count_summary_renderer?.feedback?.cross_universe_feedback_info?.aggregated_comment_count,
        fb?.comment_count?.total_count,
        node?.comment_rendering_instance?.comments?.total_count,
    );
    const shares = firstNumber(fb?.share_count?.count, node?.share_count?.count);

    if (message && (!target.text || message.length > target.text.length)) target.text = message;
    if (url && !target.url) target.url = url;
    if (legacyId && !target.postId) target.postId = legacyId;
    if (storyId && !target.storyId) target.storyId = storyId;
    if (feedbackId && !target.feedbackId) target.feedbackId = feedbackId;
    if (createdAt && !target.createdAt) target.createdAt = createdAt;
    if (actor?.name && !target.author) target.author = actor.name;
    if (actor?.id && !target.authorId) target.authorId = actor.id;
    if (reactions != null) target.reactions = reactions;
    if (comments != null) target.comments = comments;
    if (shares != null) target.shares = shares;
}

// Facebook's public group HTML streams a story in several Relay JSON fragments. Message, creation time,
// permalink and engagement can live in different nested objects. We join public fragments by Story id,
// legacy post id and feedback id, and intentionally ignore Highlight/Featured-only scripts.
export function parsePosts(html, { includeAuthors = false } = {}) {
    const $ = cheerio.load(String(html ?? ''));
    const records = new Set();
    const aliases = new Map();

    const getRecord = (keys) => {
        for (const key of keys) {
            const existing = aliases.get(key);
            if (existing) return existing;
        }
        const record = {
            postId: null,
            storyId: null,
            feedbackId: null,
            url: null,
            text: null,
            createdAt: null,
            reactions: null,
            comments: null,
            shares: null,
            author: null,
            authorId: null,
        };
        records.add(record);
        return record;
    };

    $('script[type="application/json"]').each((_, el) => {
        const raw = $(el).contents().text();
        if (!/GroupsCometFeedRegularStories|group_feed/i.test(raw)) return;
        let json;
        try {
            json = JSON.parse(raw);
        } catch {
            return;
        }

        for (const node of walk(json)) {
            const nestedUrl = node?.comet_sections?.content?.story?.comet_sections?.message?.story?.url;
            const url = [node?.permalink_url, node?.url, node?.wwwURL, nestedUrl].find(validPostUrl) ?? null;
            const postId = node?.post_id != null ? String(node.post_id) : legacyIdFromUrl(url);
            const nestedStoryId = node?.comet_sections?.content?.story?.comet_sections?.message?.story?.id;
            const storyId =
                typeof node?.id === 'string' && node.id.startsWith('Uzpf')
                    ? node.id
                    : typeof nestedStoryId === 'string' && nestedStoryId.startsWith('Uzpf')
                      ? nestedStoryId
                      : null;
            const feedbackId = typeof node?.feedback?.id === 'string' ? node.feedback.id : null;
            if (!(postId || storyId || url)) continue;

            const keys = [postId && `p:${postId}`, storyId && `s:${storyId}`, feedbackId && `f:${feedbackId}`].filter(
                Boolean,
            );
            const record = getRecord(keys);
            for (const key of keys) aliases.set(key, record);
            mergeRecord(record, node);
        }
    });

    const out = [];
    const dedupe = new Set();
    for (const record of records) {
        if (!record.text || !record.createdAt || !(record.postId || record.url)) continue;
        const key = record.postId ?? record.url;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        out.push({
            postId: record.postId,
            url: record.url,
            text: record.text.slice(0, 5000),
            createdAt: record.createdAt,
            reactions: record.reactions,
            comments: record.comments,
            shares: record.shares,
            ...(includeAuthors ? { author: record.author, authorId: record.authorId } : {}),
        });
    }
    return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
