# Agent guide: Verity Social Actor

Actor: `fouad_dp/my-actor` (private; run it through the Apify connector or a saved Task). It fetches raw public data from TikTok, Instagram and Facebook. It does no scoring or judging: that stays with you.

## Where this Actor fits

- **TikTok discovery and creator profiles come from TikTok One (for Partners).** Use its filters to get the handles; its creator profile already shows the profile facts (followers, bio, audience, etc.). You do not need this Actor for TikTok profile facts (it can return them, but they are redundant).
- **What this Actor can add for TikTok is video-level stats**: caption, likes, comment count, shares, views and date per video. Two routes, both **unreliable, see "Reliability" below**:
    - `profile` mode with `maxRecentPosts`: the Actor lists a creator's latest videos itself (via TikTok's public creator page) and reads each. Worked once live (build 0.0.42), then TikTok throttled it on the next two attempts.
    - `posts` mode: give it video URLs (for example ones you already have from TikTok One) and it reads each video's own page. This avoids the throttled creator page. Verified live earlier; cost per video is not re-measured yet.
- **Instagram and Facebook profiles, posts and comments** (what a logged-out visitor can see) work and are the most dependable part of this Actor.
- **Not available, do not plan around them:**
    - **TikTok comment text.** TikTok never loads comments for a logged-out browser (tested several ways, including a logged-in cookie: TikTok rejected it). Store Actors that scrape comments cannot be used on the Creator plan, and the universal Apify scrapers (Web Scraper, Playwright, etc.) hit the same TikTok block. So score TikTok creators on captions and the counts (likes, comments, shares, views) instead.
    - **TikTok keyword/hashtag search**, and **Instagram/Facebook keyword search** (login required).

## Reliability (TikTok), measured live on 2026-09-30

- TikTok answers with an empty or challenge page, or with an "overload-protect triggered" throttle page. When that happens the Actor writes a `blocked` row that says so and stops the run.
- Results over three recent attempts to list a creator's videos: 1 success (build 0.0.42), 2 throttled (builds 0.0.39, 0.0.46). Profile facts loaded in the last two runs.
- **A throttled run is cheap** (about $0.003 in the last one), a run that loads videos is not (see Budget). Do not retry in a loop; wait, and try again later (hours, not seconds). If `blocked` persists, fall back to TikTok One's own numbers for that creator.
- Plan the workflow so a missing TikTok video list never blocks scoring: TikTok One data first, video stats as an optional extra.

## Budget: about $2.85 per day ($85 per month)

This is a guideline, not a hard block, but the cost is real, so treat it carefully:

- **A run that loads TikTok videos cost about $0.36 in proxy traffic** (build 0.0.42, 3 videos), because TikTok's creator page autoplays preview videos. Version 0.8.5+ blocks video/audio streams to cut this, but **the saving has not been measured yet** (the run that would have shown it was throttled). Until measured, assume up to about $0.35 per creator when videos load, i.e. at most 6-8 such creators per day.
- A run that gets `blocked` costs almost nothing (about $0.003 in the latest test).
- Instagram/Facebook profile lookups and `posts` mode: check the actual cost of the first run before batching.
- After **every** run read the `OUTPUT` record: `cost.platformUsage.usageTotalUsd` (the platform's figure; it can lag, so read it again a minute later if it looks too small), `cost.proxyMegabytes` (measured in the browser; may under-count), `budget.stopReason`. Add up the day's runs and stop near $2.85. Cross-check with Apify Console > Billing > Usage.
- Always pass the per-run caps: `maxItemsPerRun` and `maxProxyMegabytes` (use 40 for one TikTok creator).
- One creator per run until costs are known.

## Always use

```json
{ "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] } }
```

## Recipes

| Goal                                 | Input                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| TikTok: recent videos of one creator | `{"mode":"profile","platform":"tiktok","usernames":["handle"],"maxRecentPosts":3,"maxItemsPerRun":6,"maxProxyMegabytes":40}`           |
| TikTok: one video's metrics          | `{"mode":"posts","platform":"tiktok","postUrls":["https://www.tiktok.com/@user/video/123"],"maxItemsPerRun":3,"maxProxyMegabytes":20}` |
| Instagram profile + recent posts     | `{"mode":"profile","platform":"instagram","usernames":["handle"],"maxRecentPosts":5,"maxItemsPerRun":10,"maxProxyMegabytes":60}`       |
| Instagram/Facebook posts + comments  | the same, plus `"fetchComments":true,"maxCommentsPerPost":10`                                                                          |
| Comments on known IG/FB post URLs    | `{"mode":"comments","platform":"instagram","postUrls":["https://www.instagram.com/p/XXXX/"],"maxCommentsPerPost":10}`                  |

Read rows with `get-dataset-items`; read the run report with `get-key-value-store-record` (record `OUTPUT`).

## Reading the rows

Every row has `recordType` (`profile`, `post`, `comment`) and `status`:

- `found`: real data. A missing individual field is `null` (never guessed).
- `private`: only public header facts.
- `not_found`: the account or post does not exist.
- `blocked`: the platform withheld it (empty page, login wall, throttle such as TikTok's "overload-protect"). Treat as **data unavailable**, not as "empty". Try again later, not in a loop.
- `error`: the lookup failed; `statusDetail` says why.

Notes: TikTok video dates from a withheld page are approximate (taken from the video id). Instagram likes such as "117K" are rounded and flagged in `statusDetail`. Facebook shows relative times only (`publishDate` null).

## Rules

- Public data only. No logins, cookies or tokens in prompts, chats or the repo.
- Do not score inside the Actor; take the raw rows and apply Verity's own keyword and audience-fit rules elsewhere.
- Report `blocked` and `error` rows to the user instead of hiding them.
- Never hammer a platform that throttled you: stop and report.
