// TikTok: profile lookup (Mode A) with recent videos, comments (Mode C) and keyword search (Mode B).
//
// Live probe (2026-09-29, residential proxy, no login, no cookies): https://www.tiktok.com/@nasa
// returns HTTP 200 with the profile visible (name, following, followers, likes, bio) and an
// embedded <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"> JSON block. Profile facts are read
// from that block (exact counts) - it is the page's own data, not a private API.
//
// Videos, comments and search results are read from the JSON the page itself loads for a logged-out visitor
// (/api/post/item_list, /api/comment/list, /api/search/...), captured with src/capture.js. Nothing is forged,
// signed or logged in. If TikTok withholds that data (challenge, login wall) the rows say `blocked`.
// Note the page HTML contains the word "captcha" inside script manifests, so rate-limit detection must look
// at visible text only (see errors.assertNotRateLimited).

import { captureJson } from '../capture.js';
import { saveDiagnostics } from '../diagnostics.js';
import { assertNotRateLimited } from '../errors.js';
import { extractEmails, makeCommentRow, makePostRow, makeProfileRow } from '../schema.js';

const DOMAIN = 'www.tiktok.com';

// How long to wait for the page's own data calls. Exported so tests can shorten them.
export const timing = { listWaitMs: 15_000, commentWaitMs: 10_000, commentRetryWaitMs: 8000, nextPageWaitMs: 8000 };

export function normalizeTiktokUsername(input) {
    return String(input)
        .trim()
        .replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '')
        .replace(/^@/, '')
        .split(/[/?#]/)[0];
}

// Pure: turns the parsed __UNIVERSAL_DATA_FOR_REHYDRATION__ object into profile facts.
export function parseUserDetail(root) {
    // eslint-disable-next-line no-underscore-dangle -- TikTok's own key name
    const detail = root?.__DEFAULT_SCOPE__?.['webapp.user-detail'];
    if (!detail) return { state: 'unrecognised' };
    const user = detail.userInfo?.user;
    // `stats` holds rounded counts (1900000); `statsV2` holds the exact ones as strings ("1871927").
    const rounded = detail.userInfo?.stats ?? {};
    const exact = detail.userInfo?.statsV2 ?? {};
    const count = (key) => {
        const n = Number(exact[key]);
        return exact[key] !== undefined && exact[key] !== '' && Number.isFinite(n) ? n : (rounded[key] ?? null);
    };
    if (!user) {
        // TikTok reports an unknown account as statusCode 10221.
        return detail.statusCode === 10221
            ? { state: 'not_found' }
            : { state: 'unrecognised', statusCode: detail.statusCode };
    }
    return {
        state: user.privateAccount ? 'private' : 'ok',
        username: user.uniqueId ?? null,
        displayName: user.nickname ?? null,
        bio: user.signature ? user.signature : null,
        verified: typeof user.verified === 'boolean' ? user.verified : null,
        externalLinks: user.bioLink?.link ? [user.bioLink.link] : [],
        contactEmails: extractEmails(user.signature),
        followerCount: count('followerCount'),
        followingCount: count('followingCount'),
        postCount: count('videoCount'),
        totalLikes: count('heartCount'),
        accountCreatedDate: user.createTime ? new Date(user.createTime * 1000).toISOString() : null,
    };
}

// ---------- pure parsers for the JSON TikTok's own pages load ----------

const toNumber = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
// Exact counts (statsV2, strings) win over the rounded ones (stats) when both exist.
const pick = (exact, rounded, key) => toNumber(exact?.[key]) ?? toNumber(rounded?.[key]);
const iso = (seconds) => {
    const n = toNumber(seconds);
    return n ? new Date(n * 1000).toISOString() : null;
};

function sponsoredFlag(item) {
    if (item.isAd === true || item.commerceInfo?.adAuthorization === true) return true;
    return item.isAd === false ? false : null;
}

// One video/photo post as TikTok describes it (item_list entries, search hits, video-detail itemStruct).
export function parseItem(item, fallbackUsername = null) {
    if (!item || typeof item !== 'object' || !item.id) return null;
    const author = typeof item.author === 'object' && item.author ? item.author : {};
    const username = author.uniqueId ?? (typeof item.author === 'string' ? item.author : null) ?? fallbackUsername;
    const kind = item.imagePost ? 'photo' : 'video';
    const authorStats = item.authorStatsV2 ?? item.authorStats ?? null;
    return {
        id: String(item.id),
        username,
        displayName: author.nickname ?? null,
        bio: author.signature ? author.signature : null,
        verified: typeof author.verified === 'boolean' ? author.verified : null,
        followerCount: authorStats ? toNumber(authorStats.followerCount) : null,
        followingCount: authorStats ? toNumber(authorStats.followingCount) : null,
        postUrl: username ? `https://${DOMAIN}/@${username}/${kind}/${item.id}` : null,
        caption: item.desc ? item.desc : null,
        createTime: toNumber(item.createTime),
        publishDate: iso(item.createTime),
        likeCount: pick(item.statsV2, item.stats, 'diggCount'),
        commentCount: pick(item.statsV2, item.stats, 'commentCount'),
        shareCount: pick(item.statsV2, item.stats, 'shareCount'),
        viewCount: pick(item.statsV2, item.stats, 'playCount'),
        isSponsored: sponsoredFlag(item),
    };
}

// /api/post/item_list response -> { items, hasMore }. items keep TikTok's own order.
export function parseItemList(data, fallbackUsername = null) {
    const items = (Array.isArray(data?.itemList) ? data.itemList : [])
        .map((i) => parseItem(i, fallbackUsername))
        .filter(Boolean);
    return { items, hasMore: Boolean(data?.hasMore) };
}

// /api/search/... responses come as { item_list: [...] } or { data: [{ type, item }] }.
export function parseSearchResponse(data) {
    let raw = [];
    if (Array.isArray(data?.item_list)) raw = data.item_list;
    else if (Array.isArray(data?.itemList)) raw = data.itemList;
    else if (Array.isArray(data?.data)) raw = data.data.map((d) => d?.item).filter(Boolean);
    return {
        items: raw.map((i) => parseItem(i)).filter(Boolean),
        hasMore: Boolean(data?.has_more ?? data?.hasMore),
    };
}

// The video page's embedded data: webapp.video-detail -> the video, or a not-found/private verdict.
export function parseVideoDetail(root) {
    // eslint-disable-next-line no-underscore-dangle -- TikTok's own key name
    const detail = root?.__DEFAULT_SCOPE__?.['webapp.video-detail'];
    if (!detail) return { state: 'unrecognised' };
    const struct = detail.itemInfo?.itemStruct;
    if (struct?.id) return { state: 'ok', item: parseItem(struct) };
    if (detail.statusCode === 10204) return { state: 'not_found' };
    if (detail.statusCode === 10222) return { state: 'private' };
    return { state: 'unrecognised', statusCode: detail.statusCode };
}

// /api/comment/list response -> { comments, hasMore, total }. Replies nested under a comment are kept.
export function parseCommentList(data) {
    const toComment = (c, isReplyHint) => {
        if (!c || typeof c !== 'object' || (c.text == null && c.cid == null)) return null;
        const replyTo = c.reply_id != null && String(c.reply_id) !== '0' && String(c.reply_id) !== '';
        return {
            id: c.cid != null ? String(c.cid) : null,
            commenterUsername: c.user?.unique_id ? c.user.unique_id : null,
            commenterDisplayName: c.user?.nickname ? c.user.nickname : null,
            commentText: c.text ?? null,
            likeCount: toNumber(c.digg_count),
            commentDate: iso(c.create_time),
            isReply: isReplyHint || replyTo,
        };
    };
    const comments = [];
    for (const c of Array.isArray(data?.comments) ? data.comments : []) {
        const top = toComment(c, false);
        if (!top) continue;
        comments.push(top);
        for (const r of Array.isArray(c.reply_comment) ? c.reply_comment : []) {
            const reply = toComment(r, true);
            if (reply) comments.push(reply);
        }
    }
    return { comments, hasMore: Number(data?.has_more) === 1 || data?.has_more === true, total: toNumber(data?.total) };
}

function itemToPostRow(item, { sourceInput, profile = {} }) {
    return makePostRow({
        platform: 'tiktok',
        sourceInput,
        username: item.username,
        displayName: profile.displayName ?? item.displayName,
        bio: profile.bio ?? item.bio,
        externalLinks: profile.externalLinks ?? [],
        followerCount: profile.followerCount ?? item.followerCount,
        followingCount: profile.followingCount ?? item.followingCount,
        verified: profile.verified ?? item.verified,
        postUrl: item.postUrl,
        caption: item.caption,
        publishDate: item.publishDate,
        likeCount: item.likeCount,
        commentCount: item.commentCount,
        shareCount: item.shareCount,
        viewCount: item.viewCount,
        isSponsored: item.isSponsored,
    });
}

// ---------- page helpers ----------

async function readRehydration(page) {
    const text = await page.evaluate(() => {
        const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        return el ? el.textContent : null;
    });
    try {
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}

async function scrollDown(page) {
    try {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.mouse.wheel(0, 3000);
    } catch {
        // page navigating or closed: the caller's wait will simply time out
    }
}

// Loads pages of a list by scrolling until enough items were captured, the list ends, or nothing new arrives.
// `readHit(hit)` -> { items, hasMore }.
async function collectPaged({
    page,
    capture,
    isListHit,
    readHit,
    want,
    shouldContinue,
    firstWaitMs = timing.listWaitMs,
}) {
    const byId = new Map();
    let seenHits = 0;
    let more = true;
    const absorb = () => {
        for (; seenHits < capture.hits.length; seenHits += 1) {
            const hit = capture.hits[seenHits];
            if (!isListHit(hit)) continue;
            const parsed = readHit(hit);
            more = parsed.hasMore;
            for (const item of parsed.items) if (!byId.has(item.id)) byId.set(item.id, item);
        }
    };
    const first = await capture.waitFor(isListHit, firstWaitMs);
    if (!first) return { items: [], gotResponse: false };
    absorb();
    const maxScrolls = Math.min(15, Math.ceil(want / 10) + 2);
    for (let i = 0; i < maxScrolls && byId.size < want && more && shouldContinue(); i += 1) {
        const before = capture.hits.length;
        await scrollDown(page);
        const next = await capture.waitFor(
            (h) => capture.hits.indexOf(h) >= before && isListHit(h),
            timing.nextPageWaitMs,
        );
        if (!next) break;
        absorb();
    }
    return { items: [...byId.values()], gotResponse: true };
}

const isItemListHit = (h) => Array.isArray(h.data?.itemList) || h.data?.statusCode !== undefined;
const isCommentHit = (h) => Array.isArray(h.data?.comments) || (h.data && 'comments' in h.data);

// ---------- profile + recent videos ----------

export async function lookupProfile({
    page,
    username: rawUsername,
    sourceInput,
    maxRecentPosts = 0,
    shouldContinue = () => true,
}) {
    const username = normalizeTiktokUsername(rawUsername);
    const capture = maxRecentPosts > 0 ? captureJson(page, ['/api/post/item_list']) : null;
    try {
        const response = await page.goto(`https://${DOMAIN}/@${encodeURIComponent(username)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
        });
        await page.waitForTimeout(2000);
        await assertNotRateLimited(page, 'tiktok', 'profile');

        const root = await readRehydration(page);
        const parsed = parseUserDetail(root);

        if (parsed.state === 'not_found' || response?.status() === 404) {
            return {
                profile: makeProfileRow({ platform: 'tiktok', sourceInput, username, status: 'not_found' }),
                posts: [],
            };
        }

        if (parsed.state === 'ok' || parsed.state === 'private') {
            const profile = makeProfileRow({
                platform: 'tiktok',
                sourceInput,
                username: parsed.username ?? username,
                displayName: parsed.displayName,
                bio: parsed.bio,
                externalLinks: parsed.externalLinks,
                contactEmails: parsed.contactEmails,
                followerCount: parsed.followerCount,
                followingCount: parsed.followingCount,
                postCount: parsed.postCount,
                totalLikes: parsed.totalLikes,
                verified: parsed.verified,
                accountCreatedDate: parsed.accountCreatedDate,
                status: parsed.state === 'private' ? 'private' : 'found',
                statusDetail: parsed.state === 'private' ? 'Private account: only public header facts returned' : null,
            });
            const posts =
                capture && parsed.state === 'ok' && parsed.postCount !== 0
                    ? await loadRecentPosts({ page, capture, profile, sourceInput, maxRecentPosts, shouldContinue })
                    : [];
            return { profile, posts };
        }

        const html = await page.content();
        await saveDiagnostics(page, html, `profile_${username}`, {
            httpStatus: response?.status() ?? null,
            statusCode: parsed.statusCode ?? null,
        });
        return {
            profile: makeProfileRow({
                platform: 'tiktok',
                sourceInput,
                username,
                status: 'blocked',
                statusDetail:
                    'TikTok page loaded but the embedded profile data was missing or unrecognised (block, challenge, or a layout change) - see DIAG_profile record',
            }),
            posts: [],
        };
    } finally {
        capture?.stop();
    }
}

// Recent posts, newest first (a pinned older video is sorted to where its date puts it). If the video list
// never loads a single `blocked` post row says so, instead of an empty result that looks like "no posts".
async function loadRecentPosts({ page, capture, profile, sourceInput, maxRecentPosts, shouldContinue }) {
    const { items, gotResponse } = await collectPaged({
        page,
        capture,
        isListHit: isItemListHit,
        readHit: (h) => parseItemList(h.data, profile.username),
        want: maxRecentPosts,
        shouldContinue,
    });
    if (!items.length) {
        await assertNotRateLimited(page, 'tiktok', 'profile videos');
        const listError = capture.hits.find((h) => isItemListHit(h) && h.data?.statusCode)?.data?.statusCode;
        return [
            makePostRow({
                platform: 'tiktok',
                sourceInput,
                username: profile.username,
                status: 'blocked',
                statusDetail: gotResponse
                    ? `TikTok returned an empty video list${listError ? ` (statusCode ${listError})` : ''} although the profile shows ${profile.postCount ?? 'some'} video(s)`
                    : 'TikTok did not load the video list for a logged-out visitor (challenge, login wall, or a layout change)',
            }),
        ];
    }
    items.sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0));
    return items.slice(0, maxRecentPosts).map((item) => itemToPostRow(item, { sourceInput, profile }));
}

// ---------- comments ----------

export async function fetchComments({
    page,
    postUrl,
    sourceInput,
    maxComments = 20,
    topLevelOnly = true,
    shouldContinue = () => true,
}) {
    const capture = captureJson(page, ['/api/comment/list']);
    try {
        const response = await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(1500);
        await assertNotRateLimited(page, 'tiktok', 'comments');

        const verdict = parseVideoDetail(await readRehydration(page));
        if (verdict.state === 'not_found' || response?.status() === 404) {
            return [
                makeCommentRow({
                    platform: 'tiktok',
                    sourceInput,
                    postUrl,
                    status: 'not_found',
                    statusDetail: 'Video not found',
                }),
            ];
        }
        if (verdict.state === 'private') {
            return [
                makeCommentRow({
                    platform: 'tiktok',
                    sourceInput,
                    postUrl,
                    status: 'private',
                    statusDetail: 'Video is private',
                }),
            ];
        }
        if (verdict.state === 'ok' && verdict.item.commentCount === 0) return [];

        // Comments load on their own on desktop layouts; otherwise open the comment panel once.
        let first = await capture.waitFor(isCommentHit, timing.commentWaitMs);
        if (!first) {
            try {
                await page.click('[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"]', { timeout: 3000 });
            } catch {
                // no comment icon: fall through to the honest "not loaded" row
            }
            first = await capture.waitFor(isCommentHit, timing.commentRetryWaitMs);
        }
        if (!first) {
            await assertNotRateLimited(page, 'tiktok', 'comments');
            return [
                makeCommentRow({
                    platform: 'tiktok',
                    sourceInput,
                    postUrl,
                    status: 'blocked',
                    statusDetail:
                        'TikTok did not load the comment list for a logged-out visitor (challenge, login wall, or a layout change)',
                }),
            ];
        }

        const { items } = await collectPaged({
            page,
            capture,
            isListHit: isCommentHit,
            readHit: (h) => {
                const { comments, hasMore } = parseCommentList(h.data);
                return { items: comments.map((c, i) => ({ ...c, id: c.id ?? `${h.url}#${i}` })), hasMore };
            },
            want: maxComments,
            shouldContinue,
        });
        return items
            .filter((c) => !(topLevelOnly && c.isReply))
            .slice(0, maxComments)
            .map((c) =>
                makeCommentRow({
                    platform: 'tiktok',
                    sourceInput,
                    postUrl,
                    commenterUsername: c.commenterUsername,
                    commenterDisplayName: c.commenterDisplayName,
                    commentText: c.commentText,
                    likeCount: c.likeCount,
                    commentDate: c.commentDate,
                    isReply: c.isReply,
                }),
            );
    } finally {
        capture.stop();
    }
}

// ---------- keyword search ----------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Client-side filter and sort within the results TikTok returned (TikTok's own order is "relevance").
export function filterAndSortHits(items, { sortOrder = 'relevance', dateFrom = null, dateTo = null } = {}) {
    const from = dateFrom ? Date.parse(DATE_ONLY.test(dateFrom) ? `${dateFrom}T00:00:00Z` : dateFrom) : null;
    const to = dateTo ? Date.parse(DATE_ONLY.test(dateTo) ? `${dateTo}T23:59:59.999Z` : dateTo) : null;
    let out = items.filter((i) => {
        if (from == null && to == null) return true;
        if (i.createTime == null) return false; // cannot prove it is inside the range: leave it out, never guess
        const t = i.createTime * 1000;
        return (from == null || t >= from) && (to == null || t <= to);
    });
    if (sortOrder === 'recent') out = [...out].sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0));
    else if (sortOrder === 'liked') out = [...out].sort((a, b) => (b.likeCount ?? -1) - (a.likeCount ?? -1));
    return out;
}

// Profile facts as shown on the search hit itself (used when the profile page is not loaded separately).
function hitToProfileRow(item, sourceInput) {
    return makeProfileRow({
        platform: 'tiktok',
        sourceInput,
        username: item.username,
        displayName: item.displayName,
        bio: item.bio,
        contactEmails: extractEmails(item.bio),
        followerCount: item.followerCount,
        followingCount: item.followingCount,
        verified: item.verified,
        status: 'found',
        statusDetail:
            'Taken from the search result (no separate profile page load): fields TikTok did not show are null',
    });
}

export async function searchPosts({
    page,
    query,
    sortOrder = 'relevance',
    maxResults = 25,
    dateFrom = null,
    dateTo = null,
    sourceInput,
    shouldContinue = () => true,
}) {
    const capture = captureJson(page, ['/api/search/']);
    try {
        await page.goto(`https://${DOMAIN}/search/video?q=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
        });
        await page.waitForTimeout(2000);
        await assertNotRateLimited(page, 'tiktok', 'search');

        const { items, gotResponse } = await collectPaged({
            page,
            capture,
            isListHit: (h) => h.data && (Array.isArray(h.data.item_list) || Array.isArray(h.data.data)),
            readHit: (h) => parseSearchResponse(h.data),
            want: Math.max(maxResults * 2, maxResults + 10), // headroom for the date filter
            shouldContinue,
        });
        if (!gotResponse) {
            await saveDiagnostics(page, await page.content(), 'search_tiktok', { query });
            throw new Error(
                'TikTok search returned no result data for a logged-out visitor (login wall, challenge, or a layout change) - see DIAG_search_tiktok',
            );
        }
        const chosen = filterAndSortHits(items, { sortOrder, dateFrom, dateTo }).slice(0, maxResults);
        const posts = chosen.map((item) => itemToPostRow(item, { sourceInput }));
        const seen = new Set();
        const profiles = [];
        for (const item of chosen) {
            if (!item.username || seen.has(item.username)) continue;
            seen.add(item.username);
            profiles.push(hitToProfileRow(item, sourceInput));
        }
        return { posts, profiles };
    } finally {
        capture.stop();
    }
}
