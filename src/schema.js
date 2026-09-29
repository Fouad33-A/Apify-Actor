// Shared output row shapes. One flat dataset, one consistent field set across
// platforms and modes, distinguished by `recordType`. Every field the
// requirements doc lists is present on every row of the relevant recordType;
// fields that don't apply are explicit null, never omitted, never guessed.
// See README.md "Must NOT do" for why nulls beat fabrication.

const BASE_FIELDS = {
  recordType: null,     // "profile" | "post" | "comment"
  platform: null,       // "tiktok" | "instagram" | "facebook"
  sourceInput: null,    // the username or search query that produced this row
  scrapedAt: null,      // ISO timestamp
};

export function makeProfileRow(fields) {
  return {
    ...BASE_FIELDS,
    recordType: "profile",
    platform: fields.platform,
    sourceInput: fields.sourceInput,
    scrapedAt: new Date().toISOString(),

    username: fields.username ?? null,
    displayName: fields.displayName ?? null,
    bio: fields.bio ?? null,               // full text, unescaped - never truncated
    externalLinks: fields.externalLinks ?? [],
    followerCount: fields.followerCount ?? null,
    followingCount: fields.followingCount ?? null,
    postCount: fields.postCount ?? null,
    totalLikes: fields.totalLikes ?? null, // all-time, only if the platform exposes it
    verified: fields.verified ?? null,
    accountCreatedDate: fields.accountCreatedDate ?? null,

    // required explicit status - never silently drop a failed lookup
    status: fields.status, // "found" | "not_found" | "private"
    statusDetail: fields.statusDetail ?? null,
  };
}

export function makePostRow(fields) {
  return {
    ...BASE_FIELDS,
    recordType: "post",
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
    caption: fields.caption ?? null,        // full text, unescaped
    publishDate: fields.publishDate ?? null,
    likeCount: fields.likeCount ?? null,
    commentCount: fields.commentCount ?? null,
    shareCount: fields.shareCount ?? null,
    viewCount: fields.viewCount ?? null,    // null if the platform has no view/play metric
    isSponsored: fields.isSponsored ?? null,

    status: fields.status ?? "found",
    statusDetail: fields.statusDetail ?? null,
  };
}

export function makeCommentRow(fields) {
  return {
    ...BASE_FIELDS,
    recordType: "comment",
    platform: fields.platform,
    sourceInput: fields.sourceInput,
    scrapedAt: new Date().toISOString(),

    postUrl: fields.postUrl,
    commenterUsername: fields.commenterUsername ?? null,
    commentText: fields.commentText ?? null, // full text, unescaped
    likeCount: fields.likeCount ?? null,
    commentDate: fields.commentDate ?? null,
    isReply: fields.isReply ?? false,

    status: fields.status ?? "found",
    statusDetail: fields.statusDetail ?? null,
  };
}

export function makeRunSummary({ mode, platform, startedAt, counts, budget, errors }) {
  return {
    mode,
    platform,
    startedAt,
    finishedAt: new Date().toISOString(),
    itemCounts: counts,       // { profiles, posts, comments, total }
    budget,                   // { maxItemsPerRun, itemsWritten, stoppedOnCap }
    rateLimitErrors: errors,  // list of { platform, endpoint, message, at }
  };
}
