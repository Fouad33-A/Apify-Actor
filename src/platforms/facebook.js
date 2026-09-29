// Facebook: Mode A (profile/Page lookup) - PARTIAL implementation.
//
// STATUS (built 2026-09-28, during the wait for Apify support's proxy-407
// fix): this file was rewritten from the unimplemented stub after live-
// inspecting the real facebook.com desktop DOM for a public Page (@NASA,
// anonymous view). Only the Page-level fields (name, follower/following
// counts, bio, category, verified badge, external links) are built and
// DOM-verified against that real page. Recent-posts extraction (the
// `posts` array Mode A also returns) is intentionally NOT attempted yet
// and comes back empty every time - see the note above domExtractPosts.
// Building it from guesses would risk exactly what the requirements doc
// rules out (fabricated/wrong data reported as if it were real), so it's
// left as explicit future work instead of shipped half-verified.
//
// Verified live (real Chrome, real facebook.com/NASA, 2026-09-28):
// - Page name, "N followers • M following" stats line, bio text, and
//   category all live inside `[role="main"]`'s FIRST direct child (the
//   "intro card"). Order: name, stats line, action buttons (Sign
//   up/Follow/Search this Page - control words, skipped), bio line(s),
//   category. Category is reliably the last `[role="button"]` inside the
//   intro card whose text isn't a control word.
// - The verified badge is an <svg> containing a <title>Verified account
//   </title> - NOT an aria-label on the svg itself (that aria-label holds
//   the page name instead, since it's grouped with the name for a11y).
// - External links (the page's own "Links" section, e.g. nasa.gov) are
//   NOT direct anchors - Facebook wraps every outbound link through
//   https://l.facebook.com/l.php?u=<encoded target>&... . The real target
//   is the `u` query parameter, not the anchor's resolved hostname.
// - Facebook's modern DOM has no <time>/<abbr> timestamp elements at all
//   (confirmed absent even on a post permalink page) - unlike Instagram,
//   there is no machine-readable exact publish date available without
//   hovering a tooltip or a further API call. Any future post-timestamp
//   field from this platform will have to be the relative text ("2h",
//   "August 14") rather than an ISO datetime, and should say so honestly
//   rather than fabricate a fake ISO conversion.
//
// This has only been inspected anonymously (not run through the actor's
// own Playwright/proxy path yet) - same "verified by hand, untested via
// the actor itself" caveat instagram.js carried before its first live run.


import { checkPageForRateLimit } from "../errors.js";
import { makeProfileRow } from "../schema.js";

const DOMAIN = "www.facebook.com";


// Runs inside the page. See file header for what was verified and how.
export function domExtractProfile() {
  // Must live inside this function: page.evaluate serialises only the function
  // body, so a module-level constant would be a ReferenceError in the page.
  const CONTROL_WORDS = new Set([
    "sign up",
    "log in",
    "follow",
    "following",
    "message",
    "call",
    "email",
    "directions",
    "search this page",
    "liked",
    "like",
    "share",
    "more",
  ]);

  const main = document.querySelector('[role="main"]');
  if (!main || !main.children.length) return null;
  const introCard = main.children[0];
  if (!introCard) return null;

  const rawLines = introCard.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
  if (rawLines.length < 2) return null;

  // "28M followers" or "28M followers • 52 following" (Pages). Personal
  // profiles show "N friends" instead - not this actor's target, and this
  // regex intentionally does not match that shape, so lookupProfile falls
  // through to a not_found/unrecognised result rather than guessing.
  const statsRe = /^([\d.,]+[KMB]?)\s*followers?(?:\s*[•·]\s*([\d.,]+[KMB]?)\s*following)?$/i;
  const statsIdx = rawLines.findIndex((l) => statsRe.test(l));
  if (statsIdx === -1) return null;

  const pageName = rawLines[0];
  const statsMatch = rawLines[statsIdx].match(statsRe);

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

  const followerCount = parseAbbrev(statsMatch[1]);
  const followingCount = statsMatch[2] ? parseAbbrev(statsMatch[2]) : null;

  const roleButtonTexts = [...introCard.querySelectorAll('[role="button"]')]
    .map((b) => b.innerText.trim())
    .filter(Boolean)
    .filter((t) => !CONTROL_WORDS.has(t.toLowerCase()) && t !== pageName);
  const category = roleButtonTexts.length ? roleButtonTexts[roleButtonTexts.length - 1] : null;

  const bioLines = [];
  for (let i = statsIdx + 1; i < rawLines.length; i++) {
    const l = rawLines[i];
    if (CONTROL_WORDS.has(l.toLowerCase())) continue;
    if (category && l === category) break;
    bioLines.push(l);
  }
  const bio = bioLines.length ? bioLines.join("\n") : null;

  const verified = [...introCard.querySelectorAll("svg title")].some(
    (t) => /verified/i.test(t.textContent || "")
  );

  // External links: the Page's own "Links" section, found by heading text
  // rather than a fixed child index (the sidebar's position among
  // `[role="main"]`'s children isn't guaranteed for every Page layout).
  // Every real outbound link Facebook renders is wrapped through
  // https://l.facebook.com/l.php?u=<target>&... - unwrap it to get the
  // actual destination instead of reporting facebook.com/l.php itself.
  let externalLinks = [];
  const linksHeading = [...document.querySelectorAll("span, div, h2")].find(
    (el) => el.children.length === 0 && el.textContent.trim() === "Links"
  );
  if (linksHeading) {
    // the section containing the heading and its link list is a nearby
    // ancestor - walk up a few levels and collect l.php anchors within it.
    let section = linksHeading.parentElement;
    for (let i = 0; i < 4 && section; i++) section = section.parentElement;
    const scope = section || document;
    const raw = [...scope.querySelectorAll('a[href^="https://l.facebook.com/l.php"]')]
      .map((a) => {
        try {
          return new URL(a.getAttribute("href")).searchParams.get("u");
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    externalLinks = [...new Set(raw)];
  }

  return { pageName, followerCount, followingCount, bio, category, verified, externalLinks };
}

// NOT YET BUILT. The feed under a Page's Posts tab lazy-loads, mixes post
// types (photo/video/reel/text) with different DOM shapes per type, and -
// per the file header note - carries no machine-readable timestamp at all.
// A first pass inspecting one reel permalink found its post ID via a
// `/reel/<id>/` anchor sitting near the reaction counts, but that's one
// post type out of several and not enough to generalise from without
// risking silently wrong data on the others. Needs its own live-test pass
// (ideally the actor's real run, once the Apify proxy issue is fixed)
// before being built for real, same discipline as instagram.js's Mode B.
export function domExtractPosts() {
  return [];
}

export async function lookupProfile({ page, username, sourceInput, maxRecentPosts }) {
  const url = `https://${DOMAIN}/${encodeURIComponent(username)}`;
  const response = await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(1500);
  const html = await page.content();

  checkPageForRateLimit("facebook", "profile", html);

  const status = response?.status();
  const lowerHtml = html.toLowerCase();

  if (
    status === 404 ||
    lowerHtml.includes("this content isn't available") ||
    lowerHtml.includes("page not found")
  ) {
    return {
      profile: makeProfileRow({
        platform: "facebook",
        sourceInput,
        username,
        status: "not_found",
        statusDetail: `HTTP ${status ?? "unknown"}`,
      }),
      posts: [],
    };
  }

  const dom = await page.evaluate(domExtractProfile);

  if (dom) {
    const profile = makeProfileRow({
      platform: "facebook",
      sourceInput,
      username: dom.pageName || username,
      displayName: dom.pageName,
      bio: dom.bio,
      externalLinks: dom.externalLinks,
      followerCount: dom.followerCount,
      followingCount: dom.followingCount,
      postCount: null, // Facebook Pages don't expose a total post count in this layout
      totalLikes: null, // "N followers" replaced Page like-counts in the current UI
      verified: dom.verified,
      accountCreatedDate: null,
      status: "found",
      statusDetail: dom.category ? `Category: ${dom.category}` : null,
    });

    // Recent posts: not built yet (see domExtractPosts) - always empty for
    // now rather than guessed. maxRecentPosts is accepted for interface
    // parity with the other platforms but has no effect until this lands.
    void maxRecentPosts;
    const domPosts = await page.evaluate(domExtractPosts);

    return { profile, posts: domPosts };
  }

  const looksLikeLoginWall = lowerHtml.includes('name="pass"') && lowerHtml.includes("log in");

  return {
    profile: makeProfileRow({
      platform: "facebook",
      sourceInput,
      username,
      status: "not_found",
      statusDetail: looksLikeLoginWall
        ? "Facebook served a login wall instead of the Page (no session cookie provided, or this IP/session was challenged)"
        : "Page loaded but the intro-card DOM shape didn't match a recognisable Facebook Page header - may be a personal profile URL (not supported) or a layout change (needs a live re-check)",
    }),
    posts: [],
  };
}

// Mode B (keyword search) and Mode C (comments) are not built yet - Mode B
// needs its own DOM investigation (Facebook's search results page has a
// different layout from a Page), and Mode C needs the same live-test pass
// domExtractPosts does, since there's no reliable anchor to walk up from
// without semantic <time> elements. Flagged here rather than guessed at.
export async function searchPosts() {
  throw new Error("Facebook Mode B (search) not yet implemented - see README pending list");
}

export async function fetchComments() {
  throw new Error("Facebook Mode C (comments) not yet implemented - see README pending list");
}
