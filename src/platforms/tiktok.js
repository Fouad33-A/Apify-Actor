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
import { extractEmails, makeCommentRow, makePostRow, makeProfileRow, parseAbbrevCount } from '../schema.js';

const DOMAIN = 'www.tiktok.com';

// How long to wait for the page's own data calls. Exported so tests can shorten them.
export const timing = {
    listWaitMs: 15_000,
    commentWaitMs: 10_000,
    commentRetryWaitMs: 8000,
    nextPageWaitMs: 8000,
    embedWaitMs: 10_000,
};

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

// ---------- TikTok's public creator embed (/embed/@user) ----------
//
// TikTok publishes an embed page for every public creator (the same one third-party sites embed). Logged out,
// it shows the creator's counts, bio and their latest videos as links with one count each (verified live on
// 2026-09-30). It is served to normal visitors, needs no login and no signing.

// Pure: the visible header text of the embed page -> counts (rounded, as displayed) and bio.
export function parseCreatorEmbedText(text) {
    const lines = String(text ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    const at = (label) => lines.findIndex((l) => l.toLowerCase() === label);
    const following = at('following');
    const followers = at('followers');
    const likes = at('likes');
    if (following < 1 || followers < 1 || likes < 1) return null;
    const next = lines[likes + 1];
    const looksLikeCount = (l) => /^[\d.,]+\s?[KMB]?$/i.test(l);
    return {
        username: lines[0].replace(/^@/, ''),
        followingCount: parseAbbrevCount(lines[following - 1]),
        followerCount: parseAbbrevCount(lines[followers - 1]),
        totalLikes: parseAbbrevCount(lines[likes - 1]),
        bio: next && !looksLikeCount(next) && !/^see more$/i.test(next) ? next : null,
    };
}

// Pure: a video id is a snowflake whose upper bits are the creation time in seconds.
export function videoIdToCreateTime(id) {
    try {
        return Number(BigInt(id) / 4_294_967_296n);
    } catch {
        return null;
    }
}

// Pure: anchors [{ href, text }] -> distinct videos, newest first.
export function parseEmbedVideos(anchors) {
    const seen = new Set();
    const out = [];
    for (const a of anchors ?? []) {
        let url;
        try {
            url = new URL(a.href);
        } catch {
            continue;
        }
        const m = url.pathname.match(/^\/@([^/]+)\/(video|photo)\/(\d+)$/);
        if (!m || seen.has(m[3])) continue;
        seen.add(m[3]);
        out.push({
            id: m[3],
            username: m[1],
            postUrl: `https://${DOMAIN}/@${m[1]}/${m[2]}/${m[3]}`,
            embedCountText: a.text || null,
            createTime: videoIdToCreateTime(m[3]),
        });
    }
    return out.sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0));
}

// Runs in the page.
export function domExtractCreatorEmbed() {
    return {
        text: document.body ? document.body.innerText : '',
        anchors: [...document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]')].map((a) => ({
            href: a.href,
            text: (a.innerText || '').trim(),
        })),
    };
}

// Loads the embed page; returns { header, videos } or null when it is not available. The video links render a
// moment after the page loads, so wait for them (not a fixed delay). If none appear, a DIAG_embed_<user> record
// keeps what was seen.
async function loadCreatorEmbed(page, username) {
    let failure = null;
    try {
        await page.goto(`https://${DOMAIN}/embed/@${encodeURIComponent(username)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 45_000,
        });
        await page
            .waitForSelector('a[href*="/video/"], a[href*="/photo/"]', { timeout: timing.embedWaitMs })
            .catch(() => {
                // no video links yet: read whatever the page shows
            });
        await assertNotRateLimited(page, 'tiktok', 'creator embed');
        const { text, anchors } = await page.evaluate(domExtractCreatorEmbed);
        const result = { header: parseCreatorEmbedText(text), videos: parseEmbedVideos(anchors) };
        if (!result.videos.length) {
            await saveDiagnostics(page, await page.content(), `embed_${username}`, {
                anchors: anchors.length,
                headerParsed: Boolean(result.header),
            });
        }
        return result;
    } catch (err) {
        if (err?.name === 'RateLimitError') throw err;
        failure = String(err?.message ?? err).split('\n')[0];
    }
    try {
        await saveDiagnostics(page, '', `embed_${username}`, { error: failure });
    } catch {
        // diagnostics are best effort
    }
    return null; // the embed is an extra route: absence is handled by the caller
}

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
        // The main profile page was withheld: the public creator embed still shows the header facts.
        const embed = await loadCreatorEmbed(page, username);
        if (embed?.header) {
            const h = embed.header;
            const profile = makeProfileRow({
                platform: 'tiktok',
                sourceInput,
                username: h.username || username,
                bio: h.bio,
                contactEmails: extractEmails(h.bio),
                followerCount: h.followerCount,
                followingCount: h.followingCount,
                totalLikes: h.totalLikes,
                status: 'found',
                statusDetail:
                    "The profile page was withheld; facts come from TikTok's public creator embed: counts are rounded as displayed (e.g. 1.9M), and display name, verified flag, links and account date are unavailable",
            });
            const posts =
                maxRecentPosts > 0
                    ? await postsFromEmbedVideos({ page, embed, profile, sourceInput, maxRecentPosts, shouldContinue })
                    : [];
            return { profile, posts };
        }
        return {
            profile: makeProfileRow({
                platform: 'tiktok',
                sourceInput,
                username,
                status: 'blocked',
                statusDetail: `TikTok page loaded${response && response.status() !== 200 ? ` (HTTP ${response.status()})` : ''} but the embedded profile data was missing or unrecognised (block, challenge, or a layout change) - see DIAG_profile record`,
            }),
            posts: [],
        };
    } finally {
        capture?.stop();
    }
}

// Recent posts, newest first.
// Route 1: the video-list call the profile page itself makes (already loaded, or about to be), if it carries data.
// Route 2: the public creator embed lists the latest videos; each is read from its own video page for exact
// stats. If neither yields a video, ONE `blocked` post row says so.
async function loadRecentPosts({ page, capture, profile, sourceInput, maxRecentPosts, shouldContinue }) {
    // TikTok answers the list call with an empty body to sessions it flags; wait only for the call itself.
    const answered = await capture.waitFor(() => true, Math.min(timing.listWaitMs, 5000));
    const hasData = answered && capture.hits.some((h) => parseItemList(h.data).items.length > 0);
    if (hasData) {
        const { items } = await collectPaged({
            page,
            capture,
            isListHit: isItemListHit,
            readHit: (h) => parseItemList(h.data, profile.username),
            want: maxRecentPosts,
            shouldContinue,
        });
        items.sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0));
        return items.slice(0, maxRecentPosts).map((item) => itemToPostRow(item, { sourceInput, profile }));
    }

    const embed = await loadCreatorEmbed(page, profile.username);
    if (embed?.videos.length) {
        return postsFromEmbedVideos({ page, embed, profile, sourceInput, maxRecentPosts, shouldContinue });
    }

    const listError = capture.hits.find((h) => isItemListHit(h) && h.data?.statusCode)?.data?.statusCode;
    return [
        makePostRow({
            platform: 'tiktok',
            sourceInput,
            username: profile.username,
            status: 'blocked',
            statusDetail: answered
                ? `TikTok returned an empty video list${listError ? ` (statusCode ${listError})` : ''} although the profile shows ${profile.postCount ?? 'some'} video(s), and the public creator embed listed none`
                : 'TikTok did not load the video list for a logged-out visitor (challenge, login wall, or a layout change), and the public creator embed listed none',
        }),
    ];
}

// Videos listed on the creator embed -> post rows with exact stats from each video's own page. If a video page
// is withheld, the row keeps what the embed showed (its one count) and says so.
async function postsFromEmbedVideos({ page, embed, profile, sourceInput, maxRecentPosts, shouldContinue }) {
    const rows = [];
    for (const video of embed.videos.slice(0, maxRecentPosts)) {
        if (!shouldContinue()) break;
        let verdict;
        try {
            verdict = await readVideoPage(page, video.postUrl);
        } catch (err) {
            if (err?.name === 'RateLimitError') throw err;
            verdict = { state: 'error' };
        }
        if (verdict.state === 'ok') {
            rows.push(itemToPostRow(verdict.item, { sourceInput, profile }));
        } else {
            rows.push(
                makePostRow({
                    platform: 'tiktok',
                    sourceInput,
                    username: profile.username,
                    displayName: profile.displayName,
                    bio: profile.bio,
                    externalLinks: profile.externalLinks,
                    followerCount: profile.followerCount,
                    followingCount: profile.followingCount,
                    verified: profile.verified,
                    postUrl: video.postUrl,
                    publishDate: video.createTime ? new Date(video.createTime * 1000).toISOString() : null,
                    viewCount: parseAbbrevCount(video.embedCountText),
                    status: 'found',
                    statusDetail:
                        'Listed on the creator embed, but the video page was withheld: only an approximate date (from the video id, within seconds) and the view count shown on the embed (rounded) are available',
                }),
            );
        }
    }
    return rows;
}

// ---------- one post by URL ----------

// Loads one video page and reads the data embedded in it: { state, item?, statusCode? }.
async function readVideoPage(page, postUrl) {
    const response = await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1500);
    await assertNotRateLimited(page, 'tiktok', 'post');
    const verdict = parseVideoDetail(await readRehydration(page));
    if (response?.status() === 404 && verdict.state !== 'ok') return { state: 'not_found' };
    return { ...verdict, httpStatus: response?.status() ?? null };
}

// Reads a single video's caption and counts from the data embedded in its own page. This works for any
// public video URL, independent of the profile's video list.
export async function fetchPost({ page, postUrl, sourceInput }) {
    const verdict = await readVideoPage(page, postUrl);
    if (verdict.state === 'ok') return itemToPostRow(verdict.item, { sourceInput });
    if (verdict.state === 'not_found')
        return makePostRow({ platform: 'tiktok', sourceInput, postUrl, status: 'not_found' });
    if (verdict.state === 'private')
        return makePostRow({ platform: 'tiktok', sourceInput, postUrl, status: 'private' });
    await saveDiagnostics(page, await page.content(), 'post_tiktok', { httpStatus: verdict.httpStatus ?? null });
    return makePostRow({
        platform: 'tiktok',
        sourceInput,
        postUrl,
        status: 'blocked',
        statusDetail:
            'TikTok page loaded but the embedded video data was missing or unrecognised (block, challenge, or a layout change) - see DIAG_post_tiktok',
    });
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
