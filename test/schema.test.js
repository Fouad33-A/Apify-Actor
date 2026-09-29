import { describe, expect, it } from "vitest";

import { makeCommentRow, makePostRow, makeProfileRow, makeRunSummary } from "../src/schema.js";

describe("row shapes", () => {
  it("profile row: unknown fields are explicit null / [] - never omitted, never guessed", () => {
    const row = makeProfileRow({ platform: "instagram", sourceInput: "nasa", status: "found" });
    expect(row).toMatchObject({
      recordType: "profile",
      platform: "instagram",
      sourceInput: "nasa",
      status: "found",
      username: null,
      displayName: null,
      bio: null,
      followerCount: null,
      followingCount: null,
      postCount: null,
      totalLikes: null,
      verified: null,
      accountCreatedDate: null,
      externalLinks: [],
      statusDetail: null,
    });
  });

  it("keeps a real 0 (not coerced to null) and a real false", () => {
    const row = makeProfileRow({
      platform: "instagram",
      sourceInput: "x",
      status: "found",
      followerCount: 0,
      postCount: 0,
      verified: false,
    });
    expect(row.followerCount).toBe(0);
    expect(row.postCount).toBe(0);
    expect(row.verified).toBe(false);
  });

  it("post row: metrics default to null and status defaults to found", () => {
    const row = makePostRow({ platform: "instagram", sourceInput: "nasa", postUrl: "https://x/p/1/" });
    expect(row).toMatchObject({
      recordType: "post",
      likeCount: null,
      commentCount: null,
      shareCount: null,
      viewCount: null,
      isSponsored: null,
      publishDate: null,
      status: "found",
    });
  });

  it("comment row: isReply defaults to false, everything else unknown is null", () => {
    const row = makeCommentRow({ platform: "instagram", sourceInput: "u", postUrl: "https://x/p/1/" });
    expect(row).toMatchObject({
      recordType: "comment",
      commenterUsername: null,
      commentText: null,
      likeCount: null,
      commentDate: null,
      isReply: false,
      status: "found",
    });
  });

  it("every row carries an ISO scrapedAt timestamp", () => {
    for (const row of [
      makeProfileRow({ platform: "facebook", sourceInput: "a", status: "found" }),
      makePostRow({ platform: "facebook", sourceInput: "a" }),
      makeCommentRow({ platform: "facebook", sourceInput: "a", postUrl: "u" }),
    ]) {
      expect(new Date(row.scrapedAt).toISOString()).toBe(row.scrapedAt);
    }
  });

  it("profile status is NOT defaulted - a caller that forgets it produces undefined, so pass it explicitly", () => {
    expect(makeProfileRow({ platform: "instagram", sourceInput: "x" }).status).toBeUndefined();
  });

  it("makeRunSummary maps its inputs to the documented summary keys", () => {
    const s = makeRunSummary({
      mode: "profile",
      platform: "instagram",
      startedAt: "2026-09-29T00:00:00.000Z",
      counts: { total: 1 },
      budget: { maxItemsPerRun: 5 },
      errors: [],
    });
    expect(Object.keys(s).sort()).toEqual(
      ["budget", "finishedAt", "itemCounts", "mode", "platform", "rateLimitErrors", "startedAt"].sort(),
    );
    expect(s.itemCounts).toEqual({ total: 1 });
    expect(s.rateLimitErrors).toEqual([]);
  });
});
