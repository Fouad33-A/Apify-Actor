import { describe, expect, it } from "vitest";

import { checkHttpStatusForRateLimit, checkPageForRateLimit, RateLimitError } from "../src/errors.js";

describe("checkHttpStatusForRateLimit", () => {
  it("throws RateLimitError on 429", () => {
    expect(() => checkHttpStatusForRateLimit("instagram", "profile", 429)).toThrow(RateLimitError);
  });

  it.each([200, 301, 403, 404, 500, undefined])("does not throw for status %s", (status) => {
    expect(() => checkHttpStatusForRateLimit("instagram", "profile", status)).not.toThrow();
  });
});

describe("checkPageForRateLimit", () => {
  it.each([
    ["instagram", "Please wait a few minutes before you try again."],
    ["instagram", "Try Again Later"],
    ["facebook", "You've been temporarily blocked"],
    ["facebook", "We detected unusual activity"],
    ["tiktok", "Verify to continue"],
    ["tiktok", "Please solve the CAPTCHA"],
  ])("%s: flags %j", (platform, text) => {
    expect(() => checkPageForRateLimit(platform, "profile", `<html>${text}</html>`)).toThrow(RateLimitError);
  });

  it("does not flag an ordinary page", () => {
    expect(() => checkPageForRateLimit("instagram", "profile", "<html>NASA 104M followers</html>")).not.toThrow();
  });

  it("markers are per platform: a TikTok marker does not trip Instagram", () => {
    expect(() => checkPageForRateLimit("instagram", "profile", "Verify to continue")).not.toThrow();
  });

  it("an unknown platform never throws", () => {
    expect(() => checkPageForRateLimit("myspace", "profile", "captcha rate limit")).not.toThrow();
  });

  it("the thrown error carries platform, endpoint and the matched marker", () => {
    let err;
    try {
      checkPageForRateLimit("facebook", "profile", "try again later");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.platform).toBe("facebook");
    expect(err.endpoint).toBe("profile");
    expect(err.message).toMatch(/facebook.*profile/);
    expect(err.detail).toMatch(/try again later/i);
  });
});

describe("RateLimitError.toRecord", () => {
  it("returns the shape written to the run summary", () => {
    const rec = new RateLimitError("tiktok", "comments", "HTTP 429").toRecord();
    expect(Object.keys(rec).sort()).toEqual(["at", "endpoint", "message", "platform"]);
    expect(Number.isNaN(Date.parse(rec.at))).toBe(false);
  });
});
