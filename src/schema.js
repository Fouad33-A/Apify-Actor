// Shared output row shapes. One flat dataset, one consistent field set across
// platforms and modes, distinguished by `recordType`. Every field the
// requirements doc lists is present on every row of the relevant recordType;
// fields that don't apply are explicit null, never omitted, never guessed.
// See README.md "Must NOT do" for why nulls beat fabrication.

const BASE_FIELDS = {
    recordType: null, // "profile" | "post" | "comment"
    platform: null, // "tiktok" | "instagram" | "facebook"
    sourceInput: null, // the username or search query that produced this row
    scrapedAt: null, // ISO timestamp
};

export function makeProfileRow(fields) {
    return {
        ...BASE_FIELDS,
        recordType: 'profile',
        platform: fields.platform,
        sourceInput: fields.sourceInput,
        scrapedAt: new Date().toISOString(),

        username: fields.username ?? null,
        displayName: fields.displayName ?? null,
        bio: fields.bio ?? null, // full text, unescaped - never truncated
        externalLinks: fields.externalLinks ?? [],
        // e-mail addresses shown publicly: those the platform gave plus any written out in the bio text
        contactEmails: [...new Set([...(fields.contactEmails ?? []), ...extractEmails(fields.bio)])],
        followerCount: fields.followerCount ?? null,
        followingCount: fields.followingCount ?? null,
        postCount: fields.postCount ?? null,
        totalLikes: fields.totalLikes ?? null, // all-time, only if the platform exposes it
        verified: fields.verified ?? null,
        accountCreatedDate: fields.accountCreatedDate ?? null,

        // required explicit status - never silently drop a failed lookup
        // filled by discovery (expand) mode and by the optional screening criteria; null/[] otherwise
        discoveredFrom: fields.discoveredFrom ?? [], // the seed creators whose posts/comments led here
        discoverySignals: fields.discoverySignals ?? [], // "mention" and/or "commenter"
        timesSeen: fields.timesSeen ?? null,
        discoveryExamples: fields.discoveryExamples ?? [], // up to 3 post URLs where it was seen
        passesFilters: fields.passesFilters ?? null, // null = no screening criteria were given
        filterFailures: fields.filterFailures ?? [],
        screeningWarnings: fields.screeningWarnings ?? [], // checks that could not be completed (never a silent pass)
        bioLinkTargets: fields.bioLinkTargets ?? [], // destinations found behind link-in-bio pages (followed on request)
        // reach rule (computed on request, for profiles that passed the first screen): median of the latest posts
        postsSampled: fields.postsSampled ?? null,
        medianLikes: fields.medianLikes ?? null,
        medianComments: fields.medianComments ?? null,
        medianViews: fields.medianViews ?? null,
        likesPctOfFollowers: fields.likesPctOfFollowers ?? null,
        viewsPctOfFollowers: fields.viewsPctOfFollowers ?? null,
        reachPctOfFollowers: fields.reachPctOfFollowers ?? null,
        reachBasis: fields.reachBasis ?? null,

        status: fields.status, // "found" | "not_found" | "private"
        statusDetail: fields.statusDetail ?? null,
    };
}

export function makePostRow(fields) {
    return {
        ...BASE_FIELDS,
        recordType: 'post',
        platform: fields.platform,
        sourceInput: fields.sourceInput,
        scrapedAt: new Date().toISOString(),

        // author fields embedded on every post row (Mode B requirement: no
        // second call needed just to get a search hit's follower count; Mode A
        // uses the same shape for consistency).
        username: fields.username ?? null,
        displayName: fields.displayName ?? null,
        bio: fields.bio ?? null,
        externalLinks: fields.externalLinks ?? [],
        followerCount: fields.followerCount ?? null,
        followingCount: fields.followingCount ?? null,
        verified: fields.verified ?? null,

        postUrl: fields.postUrl ?? null,
        caption: fields.caption ?? null, // full text, unescaped
        publishDate: fields.publishDate ?? null,
        likeCount: fields.likeCount ?? null,
        commentCount: fields.commentCount ?? null,
        shareCount: fields.shareCount ?? null,
        viewCount: fields.viewCount ?? null, // null if the platform has no view/play metric
        isSponsored: fields.isSponsored ?? null,
        mentionedAccounts: fields.mentionedAccounts ?? [], // handles tagged/linked in the post, when the platform shows them

        status: fields.status ?? 'found',
        statusDetail: fields.statusDetail ?? null,
    };
}

export function makeCommentRow(fields) {
    return {
        ...BASE_FIELDS,
        recordType: 'comment',
        platform: fields.platform,
        sourceInput: fields.sourceInput,
        scrapedAt: new Date().toISOString(),

        postUrl: fields.postUrl,
        commenterUsername: fields.commenterUsername ?? null, // the @handle
        commenterDisplayName: fields.commenterDisplayName ?? null, // the name shown next to it
        commenterProfileUrl: fields.commenterProfileUrl ?? null, // link to the commenter's profile, when shown
        commentText: fields.commentText ?? null, // full text, unescaped
        likeCount: fields.likeCount ?? null,
        commentDate: fields.commentDate ?? null,
        isReply: fields.isReply ?? false,

        status: fields.status ?? 'found',
        statusDetail: fields.statusDetail ?? null,
    };
}

export function makeRunSummary({ mode, platform, startedAt, counts, budget, errors }) {
    return {
        mode,
        platform,
        startedAt,
        finishedAt: new Date().toISOString(),
        itemCounts: counts, // { profiles, posts, comments, total }
        budget, // { maxItemsPerRun, itemsWritten, stoppedOnCap }
        rateLimitErrors: errors, // list of { platform, endpoint, message, at }
    };
}

// "104,333,810" -> 104333810, "104M" -> 104000000 (rounded, as displayed), "1.2K" -> 1200, else null.
export function parseAbbrevCount(text) {
    if (text == null) return null;
    const m = String(text)
        .replace(/[,\s]/g, '')
        .match(/^([\d.]+)([KMB])?$/i);
    if (!m) return null;
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
    return Math.round(parseFloat(m[1]) * mult);
}

// Emails written out in public text (bio, contact block). Deduplicated, lower-cased; never guessed.
export function extractEmails(text) {
    if (!text) return [];
    const found = String(text).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) ?? [];
    return [...new Set(found.map((e) => e.toLowerCase().replace(/[.,;:]+$/, '')))];
}
