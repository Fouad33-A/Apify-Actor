// Instagram: Mode A (profile lookup) and Mode C (comment retrieval).
//
// STATUS (rewritten 2026-09-28 after first live test on Apify): the original
// version of this file scanned page HTML for a legacy GraphQL JSON blob
// (edge_followed_by / edge_owner_to_timeline_media). A live test against
// @nasa showed Instagram's current web app no longer embeds that shape -
// the profile stats, bio and posts are all still there, just rendered as
// plain page content instead. This version reads the live, hydrated DOM
// directly (via page.evaluate) instead of parsing a JSON blob, which is
// more robust to Instagram's internal schema/field-name changes since it
// follows what a human actually sees, not an internal API shape.
//
// Verified live (real Chrome, real instagram.com/nasa/, 2026-09-28):
// header stats (exact follower count via a title="104,333,810" attribute
// on the abbreviated "104M" span), bio, external link, verified badge,
// full name, and the post grid (URL + caption from image alt text) all
// extract cleanly this way. Individual post pages expose publish time via
// <time datetime="...">; a "like count" as plain text ("### likes") is NOT
// always present (some accounts, e.g. this NASA post, hide like counts -
// that's the account's own choice, not a scraping failure, so it comes
// back null exactly like Instagram's own UI shows nothing). Comments are
// not in a semantic <ul>/<li> list; each comment is identified by walking
// up from its <time> element to the single shared ancestor whose visible
// text is exactly that one comment's block (username, time-ago, body,
// like count, Reply/See translation controls).

import { Actor, log } from "apify";

import { checkPageForRateLimit } from "../errors.js";
import { makeCommentRow,makePostRow, makeProfileRow } from "../schema.js";

// TEMP DIAGNOSTIC (2026-09-28): the live-DOM extraction below was verified
// by hand in a real logged-in Chrome session, but the first Apify test run
// (headless Playwright + datacenter proxy, no session cookie) came back
// not_found with neither the DOM nor legacy JSON path matching. That means
// Instagram is very likely serving a different page to that anonymous/proxy
// traffic (a login wall, consent wall, or block page) rather than the DOM
// layout changing again. This saves the raw HTML + a screenshot to the
// actor's key-value store on that failure path so it can be inspected
// without guessing. Safe to remove once the real cause is confirmed.
async function saveDebugArtifact(page, html, tag, meta) {
  try {
    await Actor.setValue(`DEBUG_HTML_${tag}`, html, { contentType: "text/html; charset=utf-8" });
  } catch (err) {
    log.warning(`Failed to save DEBUG_HTML_${tag}: ${err?.message}`);
  }
  try {
    // Actor.setValue only auto-serializes to JSON when no explicit
    // contentType is given; with one set (as here, so the KV store item
    // shows as JSON rather than octet-stream), it requires a
    // String/Buffer/Stream - passing the raw object throws. Stringify it
    // ourselves. (Bug found 2026-09-28: every prior run logged "Failed to
    // save DEBUG_META_*" for exactly this reason - harmless, since
    // log.info right after always carried the same data, but worth fixing
    // since the file dump is more convenient to browse in the KV store UI.)
    await Actor.setValue(`DEBUG_META_${tag}`, JSON.stringify(meta, null, 2), {
      contentType: "application/json; charset=utf-8",
    });
    log.info(`DEBUG_META_${tag}: ${JSON.stringify(meta)}`);
  } catch (err) {
    log.warning(`Failed to save DEBUG_META_${tag}: ${err?.message}`);
  }
  try {
    // Bounded timeout + no waitForFonts stall: screenshot is best-effort only,
    // must never eat the run's time/cost budget the way an unbounded default
    // (which waits on document.fonts.ready) can on a stuck/never-idle page.
    const shot = await page.screenshot({ fullPage: false, timeout: 8_000 });
    await Actor.setValue(`DEBUG_SHOT_${tag}`, shot, { contentType: "image/png" });
    log.info(`Saved DEBUG_SHOT_${tag} to the key-value store`);
  } catch (err) {
    log.warning(`Failed to save DEBUG_SHOT_${tag}: ${err?.message}`);
  }
}

const DOMAIN = "www.instagram.com";

// ---- legacy JSON-blob extraction (kept as a harmless fallback in case
// Instagram brings the old shape back for some accounts/builds) ----
export function extractProfileJson(html) {
  const scriptRe = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = scriptRe.exec(html)) !== null) {
    const chunk = match[1];
    if (chunk.includes("edge_followed_by") || chunk.includes("edge_owner_to_timeline_media")) {
      try {
        return JSON.parse(chunk);
      } catch {
        // not valid standalone JSON (some blocks are wrapped) - fall through
      }
    }
  }
  return null;
}

export function findUserNode(json) {
  if (!json) return null;
  const candidates = [json?.graphql?.user, json?.data?.user, json?.user];
  for (const c of candidates) {
    if (c && (c.edge_followed_by || c.username)) return c;
  }
  return null;
}

// ---- live-DOM extraction (primary path) ----

// Runs inside the page. Reads the profile header the way a human sees it:
// username / full name / "N posts" / "N followers" / "N following" / bio /
// external link(s) / verified badge - in that order, but located by regex
// on each line rather than fixed indices, so a missing full name or an
// extra line doesn't shift everything else out of place.
export function domExtractProfile() {
  const header = document.querySelector("header");
  if (!header) return null;

  const rawLines = header.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
  if (rawLines.length < 2) return null;

  const statRe = /^([\d.,]+[KMB]?)\s*(posts|followers|following)$/i;
  const statIdxs = [];
  rawLines.forEach((l, i) => {
    if (statRe.test(l)) statIdxs.push(i);
  });
  if (statIdxs.length === 0) return null; // not a real profile header - bail to caller's fallback logic

  const firstStat = Math.min(...statIdxs);
  const lastStat = Math.max(...statIdxs);

  const usernameLine = rawLines[0];
  const fullName = firstStat > 1 ? rawLines.slice(1, firstStat).join(" ").trim() || null : null;

  const statValues = {};
  for (const i of statIdxs) {
    const m = rawLines[i].match(statRe);
    statValues[m[2].toLowerCase()] = m[1];
  }

  function parseAbbrev(text) {
    if (text == null) return null;
    const t = String(text).replace(/,/g, "");
    const m = t.match(/^([\d.]+)([KMB])?$/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    const suf = (m[2] || "").toUpperCase();
    if (suf === "K") n *= 1e3;
    else if (suf === "M") n *= 1e6;
    else if (suf === "B") n *= 1e9;
    return Math.round(n);
  }

  // Prefer the exact figure from a title="12,345,678" attribute on the
  // abbreviated span (Instagram puts the precise count there as a tooltip);
  // fall back to parsing the visible abbreviated text.
  function exactCount(displayText) {
    if (displayText == null) return null;
    const titled = [...header.querySelectorAll("[title]")];
    for (const el of titled) {
      const t = el.getAttribute("title");
      if (t && /^[\d,]+$/.test(t) && el.textContent.trim() === displayText) {
        return parseInt(t.replace(/,/g, ""), 10);
      }
    }
    return parseAbbrev(displayText);
  }

  const postCount = exactCount(statValues.posts);
  const followerCount = exactCount(statValues.followers);
  const followingCount = exactCount(statValues.following);

  // Bio: everything between the last stat line and either the external-link
  // line ("...and N more") or a known button/control word.
  const controlWords = new Set([
    "follow",
    "following",
    "message",
    "edit profile",
    "contact",
    "call",
    "email",
    "directions",
    "view shop",
  ]);
  const bioLines = [];
  for (let i = lastStat + 1; i < rawLines.length; i++) {
    const l = rawLines[i];
    if (/\sand\s\d+\smore$/i.test(l)) break;
    if (controlWords.has(l.toLowerCase())) break;
    if (l === usernameLine) break; // story-highlight owner tag repeats the username
    bioLines.push(l);
  }
  const bio = bioLines.length ? bioLines.join("\n") : null;

  // External link(s): real anchors first (excluding Instagram/Threads' own
  // domains), falling back to the visible "domain.com and N more" text.
  const extAnchors = [...header.querySelectorAll("a")].filter((a) => {
    try {
      const h = new URL(a.href);
      return h.hostname && !/instagram\.com$/i.test(h.hostname) && !/threads\.(com|net)$/i.test(h.hostname);
    } catch {
      return false;
    }
  });
  const externalLinks = [...new Set(extAnchors.map((a) => a.href))];
  if (externalLinks.length === 0) {
    const moreLine = rawLines.find((l) => /\sand\s\d+\smore$/i.test(l));
    if (moreLine) {
      const domainMatch = moreLine.match(/^(\S+)/);
      if (domainMatch) externalLinks.push(domainMatch[1]);
    }
  }

  const verified = !!header.querySelector('svg[aria-label="Verified"]');

  // Post grid: URL + caption (from image alt text - Instagram's own
  // accessibility description, which is the post caption verbatim on
  // photo posts). No like/comment counts are exposed in the grid itself
  // (only on hover, which isn't reflected in the static DOM) - those are
  // fetched per-post by the caller when maxRecentPosts > 0.
  const postAnchors = [...document.querySelectorAll('main a[href*="/p/"]')];
  const seenHref = new Set();
  const posts = [];
  for (const a of postAnchors) {
    const href = a.getAttribute("href");
    if (!href || seenHref.has(href)) continue;
    seenHref.add(href);
    const img = a.querySelector("img");
    posts.push({
      href,
      caption: img ? img.getAttribute("alt") : null,
      isVideoOrCarousel: !!a.querySelector('svg[aria-label="Carousel"], svg[aria-label="Clip"], svg[aria-label="Reel"]'),
    });
  }

  return {
    username: usernameLine,
    fullName,
    bio,
    externalLinks,
    followerCount,
    followingCount,
    postCount,
    verified,
    posts,
  };
}

// Runs inside a single post's page. Pulls publish date (exact, from the
// <time> element), like count if shown (some accounts hide it - that's a
// real null, not a failure), and a best-effort view count for video posts.
export function domExtractPostMetrics() {
  const times = [...document.querySelectorAll("time")];
  const publishTime = times[0] || null;

  let likeCount = null;
  const likeCandidates = [...document.querySelectorAll("section, div, a, span")].filter(
    (el) => el.children.length === 0 && /^[\d,.]+[KMB]?\s*likes?$/i.test(el.textContent.trim())
  );
  // The overall post like count (as opposed to a per-comment like count)
  // sits directly under the action-button row, before any comment text
  // exists in the DOM order - the first match in document order is it.
  if (likeCandidates.length) {
    const raw = likeCandidates[0].textContent.trim().replace(/likes?$/i, "").trim();
    const m = raw.replace(/,/g, "").match(/^([\d.]+)([KMB])?$/i);
    if (m) {
      let n = parseFloat(m[1]);
      const suf = (m[2] || "").toUpperCase();
      if (suf === "K") n *= 1e3;
      else if (suf === "M") n *= 1e6;
      else if (suf === "B") n *= 1e9;
      likeCount = Math.round(n);
    }
  }

  let viewCount = null;
  const viewCandidates = [...document.querySelectorAll("section, div, a, span")].filter(
    (el) => el.children.length === 0 && /^[\d,.]+[KMB]?\s*views?$/i.test(el.textContent.trim())
  );
  if (viewCandidates.length) {
    const raw = viewCandidates[0].textContent.trim().replace(/views?$/i, "").trim();
    const m = raw.replace(/,/g, "").match(/^([\d.]+)([KMB])?$/i);
    if (m) {
      let n = parseFloat(m[1]);
      const suf = (m[2] || "").toUpperCase();
      if (suf === "K") n *= 1e3;
      else if (suf === "M") n *= 1e6;
      else if (suf === "B") n *= 1e9;
      viewCount = Math.round(n);
    }
  }

  return {
    publishDate: publishTime ? publishTime.getAttribute("datetime") : null,
    likeCount,
    viewCount,
  };
}

// Runs inside a single post's page. Each comment's shared container is
// found by walking up 6 levels from its <time> element - verified live to
// be the exact single-comment text boundary (see file header note). The
// very first <time> on the page is the post's own publish time, not a
// comment, and is skipped.
export function domExtractComments(maxComments) {
  const times = [...document.querySelectorAll("time")];
  if (times.length < 2) return [];
  const controlRe = /^(reply|see translation|hide|pin(ned)?|unpin|\d+[\d,]*\s*likes?|like)$/i;
  const seen = new Set();
  const rows = [];
  for (const t of times.slice(1)) {
    let node = t;
    for (let i = 0; i < 6 && node; i++) node = node.parentElement;
    if (!node || seen.has(node)) continue;
    seen.add(node);

    const lines = node.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) continue; // need at least username, time-ago, body

    const username = lines[0];
    let end = lines.length;
    while (end > 2 && controlRe.test(lines[end - 1])) end--;

    let likeCount = null;
    for (let i = end; i < lines.length; i++) {
      const m = lines[i].match(/^([\d,]+)\s*likes?$/i);
      if (m) {
        likeCount = parseInt(m[1].replace(/,/g, ""), 10);
        break;
      }
    }

    const commentText = lines.slice(2, end).join("\n").trim() || null;
    rows.push({
      username,
      text: commentText,
      likeCount,
      datetime: t.getAttribute("datetime") || null,
    });
    if (rows.length >= maxComments) break;
  }
  return rows;
}

export async function lookupProfile({ page, username, sourceInput, maxRecentPosts }) {
  const url = `https://${DOMAIN}/${encodeURIComponent(username)}/`;
  const response = await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  // The profile header/stats hydrate client-side just after networkidle;
  // give the SPA a short beat to finish before reading the DOM.
  await page.waitForTimeout(1500);
  const html = await page.content();

  // TEMP DIAGNOSTIC: the two prior live tests (datacenter proxy, then
  // residential proxy) both came back with an identical 183-byte "html" -
  // just a <script> tag that nulls out document.cookie/cookieStore, no
  // <html>/<head>/<body> at all. Being byte-identical across two different
  // proxy pools rules out a per-request Instagram anti-bot challenge page
  // (those carry session-specific tokens/nonces, not fixed bytes) - this
  // looks like it's coming from something in the navigation/proxy path
  // itself, not from instagram.com's actual response. Logging the resolved
  // URL, HTTP status and response headers on every run (not just the
  // not_found path) to see whether page.goto() is even reaching Instagram.
  let responseHeaders = {};
  try {
    responseHeaders = response ? await response.allHeaders() : {};
  } catch {
    // headers unavailable (e.g. response object stale) - proceed without them
  }
  const navMeta = {
    requestedUrl: url,
    finalUrl: page.url(),
    httpStatus: response?.status() ?? null,
    httpStatusText: response?.statusText() ?? null,
    responseOk: response?.ok() ?? null,
    contentType: responseHeaders["content-type"] ?? null,
    contentLength: responseHeaders["content-length"] ?? null,
    server: responseHeaders.server ?? null,
    viaHeader: responseHeaders.via ?? null,
    htmlByteLength: new TextEncoder().encode(html).length,
  };
  log.info(`Nav diagnostics for ${username}: ${JSON.stringify(navMeta)}`);

  checkPageForRateLimit("instagram", "profile", html);

  const status = response?.status();
  const lowerHtml = html.toLowerCase();

  if (status === 404 || lowerHtml.includes("sorry, this page isn&#x27;t available") || lowerHtml.includes("sorry, this page isn't available")) {
    return {
      profile: makeProfileRow({
        platform: "instagram", sourceInput, username,
        status: "not_found", statusDetail: `HTTP ${status ?? "unknown"}`,
      }),
      posts: [],
    };
  }

  if (lowerHtml.includes("this account is private")) {
    return {
      profile: makeProfileRow({
        platform: "instagram", sourceInput, username,
        status: "private", statusDetail: "Private account banner present",
      }),
      posts: [],
    };
  }

  const dom = await page.evaluate(domExtractProfile);

  if (dom) {
    const profile = makeProfileRow({
      platform: "instagram",
      sourceInput,
      username: dom.username || username,
      displayName: dom.fullName,
      bio: dom.bio,
      externalLinks: dom.externalLinks,
      followerCount: dom.followerCount,
      followingCount: dom.followingCount,
      postCount: dom.postCount,
      totalLikes: null, // Instagram does not expose an all-time like total
      verified: dom.verified,
      accountCreatedDate: null, // not exposed publicly
      status: "found",
    });

    const gridPosts = dom.posts.slice(0, maxRecentPosts);
    const posts = [];
    for (const gp of gridPosts) {
      const postUrl = new URL(gp.href, `https://${DOMAIN}`).toString();
      let metrics = { publishDate: null, likeCount: null, viewCount: null };
      try {
        await page.goto(postUrl, { waitUntil: "networkidle", timeout: 30_000 });
        await page.waitForTimeout(800);
        const postHtml = await page.content();
        checkPageForRateLimit("instagram", "post", postHtml);
        metrics = await page.evaluate(domExtractPostMetrics);
      } catch (err) {
        if (err?.name === "RateLimitError") throw err;
        // a single post failing to load shouldn't drop the whole profile -
        // report this post with nulls rather than aborting the run.
      }
      posts.push(
        makePostRow({
          platform: "instagram",
          sourceInput,
          username: dom.username || username,
          displayName: dom.fullName,
          bio: dom.bio,
          externalLinks: dom.externalLinks,
          followerCount: dom.followerCount,
          followingCount: dom.followingCount,
          verified: dom.verified,
          postUrl,
          caption: gp.caption,
          publishDate: metrics.publishDate,
          likeCount: metrics.likeCount,
          commentCount: null, // Instagram's web UI doesn't expose an exact total without paging all comments
          shareCount: null, // Instagram does not expose share counts
          viewCount: metrics.viewCount,
          isSponsored: null, // not reliably exposed in the current DOM; left honest-null rather than guessed
        })
      );
    }

    return { profile, posts };
  }

  // DOM extraction found no header - fall back to the legacy JSON-blob
  // shape in case Instagram serves it for some accounts/builds.
  const json = extractProfileJson(html);
  const user = findUserNode(json);

  if (user) {
    const profile = makeProfileRow({
      platform: "instagram",
      sourceInput,
      username: user.username ?? username,
      displayName: user.full_name ?? null,
      bio: user.biography ?? null,
      externalLinks: [user.external_url, ...(user.bio_links?.map((l) => l.url) || [])].filter(Boolean),
      followerCount: user.edge_followed_by?.count ?? null,
      followingCount: user.edge_follow?.count ?? null,
      postCount: user.edge_owner_to_timeline_media?.count ?? null,
      totalLikes: null,
      verified: user.is_verified ?? null,
      accountCreatedDate: null,
      status: "found",
    });
    const edges = user.edge_owner_to_timeline_media?.edges || [];
    const posts = edges.slice(0, maxRecentPosts).map((edge) => {
      const {node} = edge;
      const postUrl = `https://${DOMAIN}/p/${node.shortcode}/`;
      return makePostRow({
        platform: "instagram",
        sourceInput,
        username: user.username ?? username,
        displayName: user.full_name ?? null,
        bio: user.biography ?? null,
        externalLinks: [user.external_url].filter(Boolean),
        followerCount: user.edge_followed_by?.count ?? null,
        followingCount: user.edge_follow?.count ?? null,
        verified: user.is_verified ?? null,
        postUrl,
        caption: node.edge_media_to_caption?.edges?.[0]?.node?.text ?? null,
        publishDate: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null,
        likeCount: node.edge_liked_by?.count ?? node.edge_media_preview_like?.count ?? null,
        commentCount: node.edge_media_to_comment?.count ?? null,
        shareCount: null,
        viewCount: node.video_view_count ?? null,
        isSponsored: node.is_ad ?? null,
      });
    });
    return { profile, posts };
  }

  // Neither the live DOM nor the legacy JSON shape matched. Distinguish a
  // login wall (no header, page is dominated by a login form) from a
  // genuinely unrecognised layout, so the two show up differently in the
  // dataset rather than both being an opaque "not_found".
  const looksLikeLoginWall =
    lowerHtml.includes('name="password"') &&
    (lowerHtml.includes("log in") || lowerHtml.includes("log into instagram"));

  await saveDebugArtifact(page, html, `profile_${username}`, navMeta);

  return {
    profile: makeProfileRow({
      platform: "instagram", sourceInput, username,
      status: "not_found",
      statusDetail: looksLikeLoginWall
        ? "Instagram served a login wall instead of the profile page (no session cookie provided, or this IP/session was challenged)"
        : "Page loaded but neither the current DOM layout nor the legacy JSON shape matched - Instagram may have changed its page structure again (needs a live re-check)",
    }),
    posts: [],
  };
}

export async function fetchComments({ page, postUrl, sourceInput, maxComments, topLevelOnly }) {
  await page.goto(postUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(1200);
  const html = await page.content();
  checkPageForRateLimit("instagram", "comments", html);

  if (!topLevelOnly) {
    // Best-effort: replies are collapsed behind "View replies" by default
    // and not present in the DOM until expanded. Click a bounded number of
    // them before collecting, rather than leaving repliesincluded silently
    // unfulfilled.
    try {
      const replyButtons = await page.locator('text=/View replies|View \\d+ replies/i').all();
      for (const btn of replyButtons.slice(0, 15)) {
        try {
          await btn.click({ timeout: 1500 });
          await page.waitForTimeout(250);
        } catch {
          // a single stuck expand button shouldn't stop the rest
        }
      }
    } catch {
      // no reply buttons found/clickable - proceed with whatever is already loaded
    }
  }

  const domComments = await page.evaluate(domExtractComments, maxComments);
  if (domComments.length) {
    return domComments.map((c) =>
      makeCommentRow({
        platform: "instagram",
        sourceInput,
        postUrl,
        commenterUsername: c.username ?? null,
        commentText: c.text ?? null,
        likeCount: c.likeCount ?? null,
        commentDate: c.datetime ?? null,
        isReply: false, // reply nesting isn't reliably distinguishable in the current DOM - see fetchComments notes
      })
    );
  }

  // Fall back to the legacy JSON shape in case it's still served for some builds.
  const json = extractProfileJson(html);
  const edges =
    json?.shortcode_media?.edge_media_to_parent_comment?.edges ||
    json?.data?.shortcode_media?.edge_media_to_parent_comment?.edges ||
    [];

  const rows = [];
  for (const edge of edges.slice(0, maxComments)) {
    const {node} = edge;
    rows.push(
      makeCommentRow({
        platform: "instagram",
        sourceInput,
        postUrl,
        commenterUsername: node.owner?.username ?? null,
        commentText: node.text ?? null,
        likeCount: node.edge_liked_by?.count ?? null,
        commentDate: node.created_at ? new Date(node.created_at * 1000).toISOString() : null,
        isReply: false,
      })
    );
    if (!topLevelOnly) {
      const replies = node.edge_threaded_comments?.edges || [];
      for (const r of replies) {
        if (rows.length >= maxComments) break;
        rows.push(
          makeCommentRow({
            platform: "instagram",
            sourceInput,
            postUrl,
            commenterUsername: r.node.owner?.username ?? null,
            commentText: r.node.text ?? null,
            likeCount: r.node.edge_liked_by?.count ?? null,
            commentDate: r.node.created_at ? new Date(r.node.created_at * 1000).toISOString() : null,
            isReply: true,
          })
        );
      }
    }
  }
  return rows;
}

// Mode B (keyword search) is NOT implemented yet. Instagram's public web UI
// has no keyword/hashtag search endpoint that returns structured results
// without full app-session GraphQL calls (different, higher-risk surface
// than the profile page) - needs its own investigation before building,
// flagged in README as pending rather than guessed at.
export async function searchPosts() {
  throw new Error("Instagram Mode B (search) not yet implemented - see README pending list");
}
