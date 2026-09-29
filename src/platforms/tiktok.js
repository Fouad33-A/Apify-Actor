// TikTok: Mode A (profile lookup) only.
//
// Live probe (2026-09-29, residential proxy, no login, no cookies): https://www.tiktok.com/@nasa
// returns HTTP 200 with the profile visible (name, following, followers, likes, bio) and an
// embedded <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"> JSON block. Profile facts are read
// from that block (exact counts) - it is the page's own data, not a private API.
//
// Not built: recent videos, Mode B (search), Mode C (comments). Do not claim them until a live
// run confirms them. Note the page HTML contains the word "captcha" inside script manifests, so
// rate-limit detection must look at visible text only (see errors.assertNotRateLimited).

import { saveDiagnostics } from '../diagnostics.js';
import { assertNotRateLimited } from '../errors.js';
import { makeProfileRow } from '../schema.js';

const DOMAIN = 'www.tiktok.com';

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
    const stats = detail.userInfo?.stats ?? {};
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
        followerCount: stats.followerCount ?? null,
        followingCount: stats.followingCount ?? null,
        postCount: stats.videoCount ?? null,
        totalLikes: stats.heartCount ?? stats.heart ?? null,
        accountCreatedDate: user.createTime ? new Date(user.createTime * 1000).toISOString() : null,
    };
}

export async function lookupProfile({ page, username: rawUsername, sourceInput }) {
    const username = normalizeTiktokUsername(rawUsername);
    const response = await page.goto(`https://${DOMAIN}/@${encodeURIComponent(username)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
    });
    await page.waitForTimeout(2000);
    await assertNotRateLimited(page, 'tiktok', 'profile');

    const scriptText = await page.evaluate(() => {
        const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        return el ? el.textContent : null;
    });

    let root = null;
    try {
        root = scriptText ? JSON.parse(scriptText) : null;
    } catch {
        root = null;
    }
    const parsed = parseUserDetail(root);

    if (parsed.state === 'not_found' || response?.status() === 404) {
        return {
            profile: makeProfileRow({ platform: 'tiktok', sourceInput, username, status: 'not_found' }),
            posts: [],
        };
    }

    if (parsed.state === 'ok' || parsed.state === 'private') {
        return {
            profile: makeProfileRow({
                platform: 'tiktok',
                sourceInput,
                username: parsed.username ?? username,
                displayName: parsed.displayName,
                bio: parsed.bio,
                externalLinks: parsed.externalLinks,
                followerCount: parsed.followerCount,
                followingCount: parsed.followingCount,
                postCount: parsed.postCount,
                totalLikes: parsed.totalLikes,
                verified: parsed.verified,
                accountCreatedDate: parsed.accountCreatedDate,
                status: parsed.state === 'private' ? 'private' : 'found',
                statusDetail: parsed.state === 'private' ? 'Private account: only public header facts returned' : null,
            }),
            posts: [],
        };
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
}

export async function searchPosts() {
    throw new Error('TikTok Mode B (search) not yet implemented');
}

export async function fetchComments() {
    throw new Error('TikTok Mode C (comments) not yet implemented');
}
