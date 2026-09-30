# Handoff notes (final state, code version 0.8.1)

Everything below was verified with real runs on Apify (residential proxy, no login, no cookies, `fouad_dp/my-actor`) unless marked otherwise. Total test spend was well under the agreed cap.

## 1. What works (live-verified)

| Feature                                                      | Status                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| TikTok profile (`@nasa`)                                     | Exact followers/following/likes/videos, bio, verified, account age. Unknown user -> `not_found`. |
| Instagram profile (`nasa`)                                   | Display name, bio, link, exact followers, following, posts count, verified.                      |
| Instagram posts                                              | Real caption, likes and comment count (rounded, flagged), exact date.                            |
| Instagram comments (Mode C)                                  | Real comments with exact ISO timestamps (those shown logged out).                                |
| Facebook Page (`NASA`, `natgeo`, `Cristiano`, `NASAKennedy`) | Name, exact followers, following, category, unwrapped links, contact email, verified.            |
| Facebook posts + comments                                    | Post link, reactions, caption, a few comments (relative times only).                             |

Added in 0.7.x and live-checked on build 0.0.23-0.0.25 (2026-09-29): run cost report + proxy-MB cap, TikTok `posts` mode (caption, likes, comments, shares, views, date, author followers from a video URL - verified on a real video), Facebook commenter @handle.

**Blocked by the platforms for a logged-out automated browser (verified live):**

- TikTok profile video list: `/api/post/item_list` answers HTTP 200 with an EMPTY body; TikTok's page data marks the session `botType: "others"`. The Actor writes one `blocked` post row.
- TikTok comments: the comment call is never made. `blocked` comment row.
- TikTok search: empty page, no search data. Error row.
- Instagram search/hashtag pages: HTTP 429 + redirect to login. Facebook search pages: "Not Found". Error rows with that evidence.
- `blockHeavyResources: true` made TikTok return an empty page (default now off). `standardUserAgent: true` also made the TikTok profile come back empty in one test; leave it off.
- Build 0.0.27 (2026-09-29): `fullChromium` (new headless), `hideAutomationFlag`, and both together were each tested on `@nasa`. The profile still loaded every time, but the video list was still empty/blocked in all three. Browser-flag changes do not fix it; the remaining routes (signed internal API calls, spoofed fingerprints, own accounts, captcha solving) were deliberately not built. Inputs kept, default off.
- 2026-09-30 (0.8.1): TikTok's public creator embed `https://www.tiktok.com/embed/@user` works logged out and lists the latest ~10 videos with ids and one count each, plus rounded header counts and bio. The Actor now uses it for recent videos (each then read from its own video page) and as a fallback for the profile header when the profile page is withheld. Hashtag (`/tag/x`) and keyword (`/discover/x`) pages come back empty; `embed/v2/<id>` shows counts only, no comment text.
- 2026-09-30 cookie test (build 0.0.37, throwaway account cookie via SESSION_COOKIES_TIKTOK, 71 cookies applied): TikTok answered the profile page with HTTP 403 (empty body) and the embed with "overload-protect triggered". The logged-in session made things WORSE than logged out, so comments and search stayed unavailable. Stopped there as agreed; no attempt to work around it (device/IP-bound sessions would need fingerprint spoofing). Remove the env var; the `overload-protect` page is now a rate-limit marker that stops the run.
- TikTok profile lookups otherwise work intermittently-reliably; one profile run returned the empty shell once, the repeat worked.

**Last live checks:** build 0.0.20 found a regression (every Facebook lookup threw on an `<svg>` sibling and the run silently wrote nothing). Fixed in 0.6.1 (regression tests, plus every failed lookup/comment fetch/search now writes a `status: "error"` row). **Build 0.0.21 re-verified Facebook live:** bio, exact followers, links and contact email on NASA, National Geographic and Cristiano Ronaldo; a reel post with full caption and views; a regular post with reactions, comment and share counts; comments. NASA's first item was an event card and was correctly skipped (no post row). TikTok and Instagram were verified on 0.0.20 and are unchanged since.

## 2. How it is deployed

Actor source is the GitHub branch `claude/apify-actor-handover-3w6phm`, linked in Apify Console (Source -> Git repository). Builds are triggered from the Console **Build** button (or automatically if "Automatic builds" is enabled). `.actor/`, `Dockerfile` (image `apify/actor-node-playwright-chrome:20-1.60.0`, `npm ci --omit=dev`) and `package.json` (Playwright pinned to 1.60.0 to match the image) must stay in sync.

## 3. Why the original problems happened

- **HTTP 407:** Chromium ignores credentials embedded in the proxy URL; they are now split into `username`/`password` (`src/proxy.js`).
- **Facebook Mode A never worked:** a module-level constant used inside `page.evaluate` (not serialised into the page).
- **Login walls:** Instagram's profile page is intermittently login-walled for logged-out visitors; its public embed page and post pages are not. TikTok and Facebook render fully.
- **False rate-limit stops:** rate-limit words appear inside script bundles (TikTok ships "captcha"); detection now reads visible text only.
- **Page language:** the proxy country changed Facebook's language; the browser context now asks for `en-US`.

## 4. Diagnostics tools (kept on purpose)

- `mode: "probe"` fetches up to 12 public URLs on the three platforms and saves status/text/DOM outline/JSON path to the `PROBE_RESULTS` record. It reports login walls; it never tries to get past them.
- `DIAG_*` records are written when a page is unrecognised. `OUTPUT.runtime` records code version, build number and proxy status.
- The temporary `DEBUG_HTML_*` / `DEBUG_SHOT_*` saves in `instagram.js` can be removed.

## 5. Known limits and follow-ups

- Selector work is based on layouts captured on 2026-09-29; platforms change markup. Tests use synthetic content in the captured shapes, so they prove the logic, not that the sites are unchanged. Re-run a small live check after any platform-side change.
- Instagram `likeCount`/`commentCount` come from the post's og:description and are rounded when shown as "117K".
- Facebook `likeCount` is the total reactions as displayed; comment/share counts are only set when the post page labels them.
- Instagram embed fallback has no bio/following/links.
- Anonymous visitors see only some posts/comments on Facebook and Instagram.
- Mode B: Instagram/Facebook keyword search generally needs a logged-in session (not used). TikTok search is the most heavily protected surface; TikTok One for Partners already covers TikTok discovery.
- TikTok videos/comments and Facebook post pagination are not built.
- If cookies are ever needed, put them in secret Actor environment variables; never in the repo or chat.

## 6. Cost notes

Residential proxy is billed per GB; a profile + a few posts is a few MB. Each verification round in this session cost cents. The account's $85/month limit was never approached.
