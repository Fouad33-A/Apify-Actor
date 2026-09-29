# Handoff notes (2026-09-29, cloud Claude Code session)

Nothing here has been run on Apify. Tests use synthetic fixtures in a local headless Chromium; they check the logic, not the real Instagram/Facebook pages.

## 1. Ready to carry over to the Apify Web IDE

GitHub does not auto-deploy. Copy these into the Web IDE, save, build:

| File                         | Change                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| `src/proxy.js`               | **new** - splits the proxy URL into `server`/`username`/`password` |
| `src/main.js`                | uses `toPlaywrightProxy()`; run loop moved to `run.js`             |
| `src/run.js`                 | **new** - run loop; Mode C fix; fail-fast on comment rate limits   |
| `src/platforms/facebook.js`  | `CONTROL_WORDS` moved inside `domExtractProfile`                   |
| `src/platforms/instagram.js` | only `export` keywords added (plus lint autofixes)                 |
| `src/cookies.js`             | accepts a leading `Cookie:` prefix                                 |

`package.json` dev dependencies, tests, lint and CI files do not affect the Actor and need no carry-over. `src/routes.js` (unused template code) was deleted; deleting it in the Web IDE is optional. The Prettier commit only changes whitespace/quotes, so it does not matter which style you paste.

**Do this first, and carry it over as one batch:** `proxy.js` + `main.js` + `run.js`.

### Why the proxy change matters (probable cause of the 407)

`main.js` passed `proxy: { server: "http://user:pass@proxy.apify.com:8000" }` to `chromium.launch`. Chromium ignores credentials embedded in a proxy URL, so it never sends `Proxy-Authorization`, and an authenticating proxy answers 407. That matches every symptom: 407 on all proxy types, no bytes or domain in Apify's proxy usage, and a proxy-off control that works.

Reproduced locally against a fake authenticating proxy:

- credentials in the URL: proxy sees no auth header, Chromium fails with `ERR_INVALID_AUTH_CREDENTIALS`
- separate `username`/`password` fields: HTTP 200

This is not yet confirmed against Apify's real proxy. After carrying over, one minimal run settles it: Instagram Mode A, `@nasa`, 512 MB, short timeout, `maxItemsPerRun=2`, a small hard cost cap. Whether to tell Apify support about this is Fouad's call.

### The other real bugs fixed

- **Facebook Mode A threw `ReferenceError: CONTROL_WORDS is not defined` on every run.** `page.evaluate` serialises only the function body, so the module-level constant did not exist in the page. It could not have worked through the actor; the earlier check was done by hand in a browser console.
- **Mode C did nothing unless `fetchComments` was also true.** It now always fetches comments.
- **A rate limit during comment fetching did not stop the run.** It now does, like lookups and searches.

## 2. Suspected issues NOT changed (need a real page to confirm)

1. `checkPageForRateLimit` tests the full page HTML (`page.content()`, scripts included). Markers like `/rate limit/i`, `/captcha/i`, `/try again later/i` could match ordinary script text and stop a healthy run. Consider testing visible text instead once a real page can be inspected.
2. Instagram bio: with exactly one external link there is no "... and N more" line, so the link's own text is probably appended to `bio`.
3. Instagram post like count is the first "N likes" leaf in document order. If a post hides likes but a comment shows "N likes" as a single element, the comment's count could be reported as the post's.
4. Instagram `isReply` is always `false`. With `topLevelCommentsOnly=false`, expanded replies are emitted as top-level comments.
5. The profile grid selector `main a[href*="/p/"]` does not match `/reel/` links, so reels are likely missing from recent posts.
6. Failed lookups (any non-rate-limit error) are only logged; no dataset row is written. `schema.js` says a failed lookup should never be silently dropped, but the status enum has no `error`. The same happens for Mode B/C on Facebook and TikTok: a successful exit and an empty dataset. Worth a schema decision (add an `error` status row).
7. `makeProfileRow` does not default `status`; a caller that forgets it produces `undefined`.
8. `waitUntil: "networkidle"` with a 60 s timeout may be slow or expensive on pages that never go idle; `domcontentloaded` plus waiting for the header could be cheaper.
9. The temporary diagnostics in `main.js` and `instagram.js` (proxy logging, `DEBUG_*` saves) can be removed once the proxy question is settled.
10. `README.md` is still the Apify Cheerio template text, which is what the Actor's page shows.

## 3. Blocked: Facebook posts extraction

Needs live DOM research on a real public Page. This session has no browsing tool that can safely do that (the Apify-run browsing tools would spend Fouad's account budget). `domExtractPosts` still returns `[]` on purpose.

## 4. Mode B (search) - options only, nothing built

These are hypotheses from general knowledge, not observations; each must be checked with a real session before designing anything.

- **Instagram:** keyword and hashtag search generally sits behind login. It would need the `sessionCookies` input, with account-restriction risk on the account used.
- **Facebook:** search results pages generally require login and use a different layout from a Page. Same cookie and risk considerations.
- **TikTok:** search works in a normal browser but is the most heavily bot-protected surface.
- **Existing alternative:** TikTok One for Partners already gives keyword search with follower, median-view and engagement filters, and the YouTube screener covers YouTube. So Mode B may not be worth building for TikTok discovery.

Suggested order if it is wanted at all: validate TikTok Mode A first, then investigate TikTok search. Instagram and Facebook Mode B last, only with an explicit decision to accept the login-session risk.

## 5. TikTok - risk assessment only

Not started, per instruction. Known risk: earlier HTTP 403s even when authenticated, likely signature-based anti-bot checks. Playwright is a real browser, which may help, but that is unproven. A residential proxy may be needed, which costs more per GB; that is Fouad's decision. Suggested first step once approved: one tiny run on a single public profile, capped in cost, and stop at the first block.
