// Instagram extraction + flow tests. Fixtures are SYNTHETIC (see helpers/fixtures.js).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RateLimitError } from "../src/errors.js";
import {
  domExtractComments,
  domExtractPostMetrics,
  domExtractProfile,
  extractProfileJson,
  fetchComments,
  findUserNode,
  lookupProfile,
} from "../src/platforms/instagram.js";
import { launchBrowser, serve } from "./helpers/browser.js";
import { igComment, igGrid, igHeader, igPage, igPost } from "./helpers/fixtures.js";

const setValue = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("apify", () => ({
  Actor: { setValue },
  log: { info: vi.fn(), warning: vi.fn(), exception: vi.fn() },
}));

let browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(() => setValue.mockClear());

async function evaluate(html, fn, arg) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await page.evaluate(fn, arg);
  } finally {
    await page.close();
  }
}

describe("domExtractProfile (in-page)", () => {
  it("extracts every header field, preferring the exact count from the title attribute", async () => {
    const dom = await evaluate(igPage(igHeader()), domExtractProfile);
    expect(dom).toMatchObject({
      username: "nasa",
      fullName: "NASA",
      bio: "Exploring the universe\nand our home planet.",
      followerCount: 104_333_810, // exact, from title="104,333,810" - not 104,000,000 from "104M"
      followingCount: 70,
      postCount: 4000,
      verified: true,
      externalLinks: [],
      posts: [],
    });
  });

  it("falls back to the abbreviated text when there is no exact title attribute", async () => {
    const dom = await evaluate(igPage(igHeader({ followers: ["1.2M", null] })), domExtractProfile);
    expect(dom.followerCount).toBe(1_200_000);
  });

  it.each([
    ["12K", 12_000],
    ["3.5B", 3_500_000_000],
    ["1,234", 1234],
    ["0", 0],
  ])("parses follower text %s -> %s", async (shown, expected) => {
    const dom = await evaluate(igPage(igHeader({ followers: [shown, null] })), domExtractProfile);
    expect(dom.followerCount).toBe(expected);
  });

  it("verified is false (not null) when the badge is absent", async () => {
    const dom = await evaluate(igPage(igHeader({ verified: false })), domExtractProfile);
    expect(dom.verified).toBe(false);
  });

  it("fullName is null when the stats follow the username directly", async () => {
    const dom = await evaluate(igPage(igHeader({ fullName: null })), domExtractProfile);
    expect(dom.fullName).toBeNull();
  });

  it("bio is null when there is no bio text", async () => {
    const dom = await evaluate(igPage(igHeader({ bioLines: [] })), domExtractProfile);
    expect(dom.bio).toBeNull();
  });

  it("bio stops at the '... and N more' link line", async () => {
    const dom = await evaluate(
      igPage(igHeader({ bioLines: ["Line one"], moreLine: "nasa.gov and 2 more" })),
      domExtractProfile,
    );
    expect(dom.bio).toBe("Line one");
  });

  it("bio stops at a button/control word", async () => {
    const dom = await evaluate(igPage(igHeader({ bioLines: ["Line one"], extra: "<div>Follow</div>" })), domExtractProfile);
    expect(dom.bio).toBe("Line one");
  });

  it("external links: keeps real outbound anchors, drops instagram.com and threads links, de-duplicates", async () => {
    const dom = await evaluate(
      igPage(
        igHeader({
          bioLines: [],
          moreLine: "nasa.gov and 1 more",
          links: [
            "https://www.nasa.gov/",
            "https://www.nasa.gov/",
            "https://www.instagram.com/other/",
            "https://www.threads.net/@nasa",
          ],
        }),
      ),
      domExtractProfile,
    );
    expect(dom.externalLinks).toEqual(["https://www.nasa.gov/"]);
  });

  it("external links: falls back to the visible domain of the '... and N more' line when no anchor exists", async () => {
    const dom = await evaluate(igPage(igHeader({ bioLines: [], moreLine: "nasa.gov and 2 more" })), domExtractProfile);
    expect(dom.externalLinks).toEqual(["nasa.gov"]);
  });

  it("returns null when there is no <header>", async () => {
    expect(await evaluate(igPage("<main>nothing</main>"), domExtractProfile)).toBeNull();
  });

  it("returns null when the header has no stats lines (not a real profile header)", async () => {
    expect(await evaluate(igPage("<header><div>Log in</div><div>Sign up</div></header>"), domExtractProfile)).toBeNull();
  });

  it("post grid: de-duplicates hrefs, keeps alt text as caption, null caption when there is no image", async () => {
    const dom = await evaluate(
      igPage(
        igHeader() +
          igGrid([
            { href: "/p/AAA/", alt: "A caption" },
            { href: "/p/AAA/", alt: "A caption" },
            { href: "/p/BBB/" },
          ]),
      ),
      domExtractProfile,
    );
    expect(dom.posts.map((p) => [p.href, p.caption])).toEqual([
      ["/p/AAA/", "A caption"],
      ["/p/BBB/", null],
    ]);
  });
});

describe("domExtractPostMetrics (in-page)", () => {
  it("reads the exact publish time, like count and view count", async () => {
    const m = await evaluate(
      igPost({ postIso: "2026-09-20T12:00:00.000Z", likes: "1,234 likes", views: "12.5K views" }),
      domExtractPostMetrics,
    );
    expect(m).toEqual({ publishDate: "2026-09-20T12:00:00.000Z", likeCount: 1234, viewCount: 12_500 });
  });

  it("like and view counts are null (not 0) when the post hides them", async () => {
    const m = await evaluate(igPost({}), domExtractPostMetrics);
    expect(m).toEqual({ publishDate: "2026-09-20T12:00:00.000Z", likeCount: null, viewCount: null });
  });

  it("publishDate is null when there is no <time> element", async () => {
    const m = await evaluate(igPage("<article>no time here</article>"), domExtractPostMetrics);
    expect(m.publishDate).toBeNull();
  });

  it("uses the first like count in document order (the post's, before any comment's)", async () => {
    const m = await evaluate(
      igPost({ likes: "500 likes", comments: [igComment({ user: "a", body: "hi", likes: 3 })] }),
      domExtractPostMetrics,
    );
    expect(m.likeCount).toBe(500);
  });
});

describe("domExtractComments (in-page)", () => {
  const comments = [
    igComment({ user: "alice", body: "Great post!", likes: 3, iso: "2026-09-21T08:00:00.000Z" }),
    igComment({ user: "bob", body: "Line one\nLine two", iso: "2026-09-21T09:00:00.000Z", reply: true }),
    igComment({ user: "carol", body: "No controls at all", reply: false }),
  ];

  it("skips the post's own <time> and returns one row per comment block", async () => {
    const rows = await evaluate(igPost({ comments }), domExtractComments, 50);
    expect(rows.map((r) => r.username)).toEqual(["alice", "bob", "carol"]);
  });

  it("extracts text, like count and exact datetime; strips Reply/like controls from the text", async () => {
    const [alice] = await evaluate(igPost({ comments }), domExtractComments, 50);
    expect(alice).toEqual({
      username: "alice",
      text: "Great post!",
      likeCount: 3,
      datetime: "2026-09-21T08:00:00.000Z",
    });
  });

  it("like count is null when the comment shows none", async () => {
    const rows = await evaluate(igPost({ comments }), domExtractComments, 50);
    expect(rows[1].likeCount).toBeNull();
  });

  it("caps the number of comments returned at maxComments", async () => {
    const rows = await evaluate(igPost({ comments }), domExtractComments, 2);
    expect(rows).toHaveLength(2);
  });

  it("returns [] when the page has only the post's own <time>", async () => {
    expect(await evaluate(igPost({ comments: [] }), domExtractComments, 50)).toEqual([]);
  });

  it("skips a block that has fewer than username + time + body lines", async () => {
    const stub = `<li><div><div><div><div><div><time datetime="2026-09-21T08:00:00.000Z">2d</time></div></div></div></div></div></li>`;
    const rows = await evaluate(igPost({ comments: [stub, igComment({ user: "dave", body: "ok" })] }), domExtractComments, 50);
    expect(rows.map((r) => r.username)).toEqual(["dave"]);
  });
});

describe("legacy JSON fallback helpers", () => {
  const user = { username: "nasa", edge_followed_by: { count: 5 } };
  const html = (obj) => `<script type="application/json">${JSON.stringify(obj)}</script>`;

  it("extractProfileJson finds the blob that mentions edge_followed_by", () => {
    expect(extractProfileJson(html({ graphql: { user } }))).toEqual({ graphql: { user } });
  });

  it("extractProfileJson skips unrelated and malformed script blocks", () => {
    const page = `<script type="application/json">{"other":1}</script><script type="application/json">edge_followed_by {bad</script>`;
    expect(extractProfileJson(page)).toBeNull();
  });

  it("findUserNode looks in graphql.user, data.user and user; null otherwise", () => {
    expect(findUserNode({ graphql: { user } })).toBe(user);
    expect(findUserNode({ data: { user } })).toBe(user);
    expect(findUserNode({ user })).toBe(user);
    expect(findUserNode({ user: { unrelated: true } })).toBeNull();
    expect(findUserNode(null)).toBeNull();
  });
});

// ---- Full flows through a real page; the network is replaced by synthetic responses ----

const PROFILE_URL = /instagram\.com\/nasa\/$/;
const profilePage = (opts = {}) =>
  igPage(
    igHeader(opts) +
      igGrid([
        { href: "/p/AAA/", alt: "First caption" },
        { href: "/p/BBB/", alt: "Second caption" },
        { href: "/p/CCC/", alt: "Third caption" },
      ]),
  );

async function withContext(routes, fn) {
  const context = await browser.newContext();
  try {
    const seen = await serve(context, routes);
    const page = await context.newPage();
    return await fn({ page, seen, context });
  } finally {
    await context.close();
  }
}

describe("lookupProfile (full flow, synthetic pages)", () => {
  const base = { username: "nasa", sourceInput: "nasa", maxRecentPosts: 2 };

  it("returns a found profile row and post rows limited by maxRecentPosts", async () => {
    const routes = [
      { match: PROFILE_URL, body: profilePage() },
      { match: /\/p\/AAA\/$/, body: igPost({ postIso: "2026-09-20T12:00:00.000Z", likes: "1,000 likes" }) },
      { match: /\/p\/BBB\/$/, body: igPost({ postIso: "2026-09-19T12:00:00.000Z" }) },
    ];
    const { profile, posts } = await withContext(routes, ({ page }) => lookupProfile({ page, ...base }));

    expect(profile).toMatchObject({
      recordType: "profile",
      platform: "instagram",
      sourceInput: "nasa",
      status: "found",
      username: "nasa",
      displayName: "NASA",
      followerCount: 104_333_810,
      verified: true,
      totalLikes: null,
      accountCreatedDate: null,
    });
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      recordType: "post",
      postUrl: "https://www.instagram.com/p/AAA/",
      caption: "First caption",
      publishDate: "2026-09-20T12:00:00.000Z",
      likeCount: 1000,
      followerCount: 104_333_810, // author fields are embedded on every post row
    });
    // hidden like count is an honest null, and unexposed metrics are never guessed
    expect(posts[1]).toMatchObject({ likeCount: null, viewCount: null, commentCount: null, shareCount: null, isSponsored: null });
  }, 60_000);

  it("maxRecentPosts = 0 returns the profile with no posts", async () => {
    const { profile, posts } = await withContext([{ match: PROFILE_URL, body: profilePage() }], ({ page }) =>
      lookupProfile({ page, ...base, maxRecentPosts: 0 }),
    );
    expect(profile.status).toBe("found");
    expect(posts).toEqual([]);
  });

  it("a post page that fails to load yields that post with null metrics; the profile still succeeds", async () => {
    const routes = [
      { match: PROFILE_URL, body: profilePage() },
      { match: /\/p\/AAA\/$/, status: 500, body: "<html><body>Server error</body></html>" },
      { match: /\/p\/BBB\/$/, body: igPost({ likes: "7 likes" }) },
    ];
    const { posts } = await withContext(routes, ({ page }) => lookupProfile({ page, ...base }));
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ caption: "First caption", likeCount: null, publishDate: null });
    expect(posts[1].likeCount).toBe(7);
  }, 60_000);

  it("HTTP 404 -> not_found, no fabricated fields", async () => {
    const { profile, posts } = await withContext(
      [{ match: PROFILE_URL, status: 404, body: igPage("<div>whatever</div>") }],
      ({ page }) => lookupProfile({ page, ...base }),
    );
    expect(profile).toMatchObject({ status: "not_found", statusDetail: "HTTP 404", followerCount: null, bio: null });
    expect(posts).toEqual([]);
  });

  it("'Sorry, this page isn't available' on a 200 -> not_found", async () => {
    const { profile } = await withContext(
      [{ match: PROFILE_URL, body: igPage("<div>Sorry, this page isn't available.</div>") }],
      ({ page }) => lookupProfile({ page, ...base }),
    );
    expect(profile.status).toBe("not_found");
  });

  it("private account banner -> private, nothing else filled in", async () => {
    const { profile, posts } = await withContext(
      [{ match: PROFILE_URL, body: igPage(`${igHeader()}<div>This account is private</div>`) }],
      ({ page }) => lookupProfile({ page, ...base }),
    );
    expect(profile).toMatchObject({ status: "private", followerCount: null, displayName: null });
    expect(posts).toEqual([]);
  });

  it("a login wall is reported as not_found with a login-wall detail and saves debug artifacts", async () => {
    const wall = igPage('<form><input name="password"><button>Log in</button></form>');
    const { profile } = await withContext([{ match: PROFILE_URL, body: wall }], ({ page }) =>
      lookupProfile({ page, ...base }),
    );
    expect(profile.status).toBe("not_found");
    expect(profile.statusDetail).toMatch(/login wall/i);
    const keys = setValue.mock.calls.map((c) => c[0]);
    expect(keys).toContain("DEBUG_HTML_profile_nasa");
    expect(keys).toContain("DEBUG_META_profile_nasa");
  }, 60_000);

  it("DEBUG_META is saved as a JSON string (Actor.setValue rejects raw objects when contentType is set)", async () => {
    await withContext([{ match: PROFILE_URL, body: igPage("<div>unrecognised</div>") }], ({ page }) =>
      lookupProfile({ page, ...base }),
    );
    const meta = setValue.mock.calls.find((c) => c[0] === "DEBUG_META_profile_nasa");
    expect(typeof meta[1]).toBe("string");
    expect(() => JSON.parse(meta[1])).not.toThrow();
  });

  it("an unrecognised layout is reported as not_found with a layout-change detail", async () => {
    const { profile } = await withContext([{ match: PROFILE_URL, body: igPage("<div>unrecognised</div>") }], ({ page }) =>
      lookupProfile({ page, ...base }),
    );
    expect(profile.status).toBe("not_found");
    expect(profile.statusDetail).toMatch(/changed its page structure/i);
  });

  it("a rate-limit page throws RateLimitError instead of returning a row", async () => {
    await expect(
      withContext([{ match: PROFILE_URL, body: igPage("Please wait a few minutes before you try again.") }], ({ page }) =>
        lookupProfile({ page, ...base }),
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("a rate-limit page on a post propagates instead of being swallowed as a null-metrics post", async () => {
    const routes = [
      { match: PROFILE_URL, body: profilePage() },
      { match: /\/p\/AAA\/$/, body: igPage("Try Again Later") },
    ];
    await expect(withContext(routes, ({ page }) => lookupProfile({ page, ...base }))).rejects.toBeInstanceOf(
      RateLimitError,
    );
  }, 60_000);

  it("falls back to the legacy JSON blob when the DOM has no header", async () => {
    const json = {
      graphql: {
        user: {
          username: "nasa",
          full_name: "NASA",
          biography: "bio text",
          external_url: "https://www.nasa.gov/",
          is_verified: true,
          edge_followed_by: { count: 100 },
          edge_follow: { count: 5 },
          edge_owner_to_timeline_media: {
            count: 9,
            edges: [
              {
                node: {
                  shortcode: "ZZZ",
                  taken_at_timestamp: 1_790_000_000,
                  edge_media_to_caption: { edges: [{ node: { text: "legacy caption" } }] },
                  edge_liked_by: { count: 42 },
                  edge_media_to_comment: { count: 3 },
                  is_ad: false,
                },
              },
            ],
          },
        },
      },
    };
    const page = igPage(`<script type="application/json">${JSON.stringify(json)}</script>`);
    const { profile, posts } = await withContext([{ match: PROFILE_URL, body: page }], ({ page: p }) =>
      lookupProfile({ page: p, ...base }),
    );
    expect(profile).toMatchObject({ status: "found", followerCount: 100, followingCount: 5, postCount: 9, bio: "bio text" });
    expect(posts[0]).toMatchObject({
      postUrl: "https://www.instagram.com/p/ZZZ/",
      caption: "legacy caption",
      likeCount: 42,
      commentCount: 3,
      isSponsored: false,
      publishDate: new Date(1_790_000_000 * 1000).toISOString(),
    });
  });
});

describe("fetchComments (full flow, synthetic pages)", () => {
  const POST = "https://www.instagram.com/p/AAA/";
  const opts = { postUrl: POST, sourceInput: "nasa", maxComments: 10, topLevelOnly: true };

  it("returns one comment row per DOM comment with exact datetimes", async () => {
    const body = igPost({
      comments: [
        igComment({ user: "alice", body: "Great!", likes: 2, iso: "2026-09-21T08:00:00.000Z" }),
        igComment({ user: "bob", body: "Nice", iso: "2026-09-21T09:00:00.000Z" }),
      ],
    });
    const rows = await withContext([{ match: /\/p\/AAA\/$/, body }], ({ page }) => fetchComments({ page, ...opts }));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      recordType: "comment",
      postUrl: POST,
      commenterUsername: "alice",
      commentText: "Great!",
      likeCount: 2,
      commentDate: "2026-09-21T08:00:00.000Z",
      isReply: false,
    });
    expect(rows[1].likeCount).toBeNull();
  }, 60_000);

  it("respects maxComments", async () => {
    const body = igPost({ comments: [1, 2, 3, 4].map((n) => igComment({ user: `u${n}`, body: `c${n}` })) });
    const rows = await withContext([{ match: /\/p\/AAA\/$/, body }], ({ page }) =>
      fetchComments({ page, ...opts, maxComments: 2 }),
    );
    expect(rows.map((r) => r.commenterUsername)).toEqual(["u1", "u2"]);
  });

  it("returns [] (not fabricated rows) for a post with no comments", async () => {
    const rows = await withContext([{ match: /\/p\/AAA\/$/, body: igPost({}) }], ({ page }) =>
      fetchComments({ page, ...opts }),
    );
    expect(rows).toEqual([]);
  });

  it("falls back to legacy JSON comments, including replies only when topLevelOnly is false", async () => {
    const node = {
      owner: { username: "alice" },
      text: "parent",
      edge_liked_by: { count: 1 },
      created_at: 1_790_000_000,
      edge_threaded_comments: { edges: [{ node: { owner: { username: "bob" }, text: "reply", created_at: 1_790_000_100 } }] },
    };
    const json = { shortcode_media: { edge_media_to_parent_comment: { edges: [{ node }] } } };
    // extractProfileJson only accepts a blob that mentions edge_followed_by / edge_owner_to_timeline_media.
    const parsable = igPage(
      `<script type="application/json">${JSON.stringify({ ...json, edge_owner_to_timeline_media: {} })}</script>`,
    );
    const top = await withContext([{ match: /\/p\/AAA\/$/, body: parsable }], ({ page }) =>
      fetchComments({ page, ...opts, topLevelOnly: true }),
    );
    expect(top.map((r) => [r.commenterUsername, r.isReply])).toEqual([["alice", false]]);

    const all = await withContext([{ match: /\/p\/AAA\/$/, body: parsable }], ({ page }) =>
      fetchComments({ page, ...opts, topLevelOnly: false }),
    );
    expect(all.map((r) => [r.commenterUsername, r.isReply])).toEqual([
      ["alice", false],
      ["bob", true],
    ]);
  });

  it("a rate-limit page throws RateLimitError", async () => {
    await expect(
      withContext([{ match: /\/p\/AAA\/$/, body: igPage("Please wait a few minutes") }], ({ page }) =>
        fetchComments({ page, ...opts }),
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});
