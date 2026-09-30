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

## Batch screening of handles you already have (recommended)

```json
{
    "mode": "profile",
    "platform": "instagram",
    "usernames": ["handle1", "handle2", "..."],
    "maxRecentPosts": 0,
    "minFollowers": 30000,
    "maxFollowers": 150000,
    "requireContactEmail": true,
    "excludeBioPatterns": ["stan.store", "ebook", "e-book"],
    "followLinkInBio": true,
    "reachPosts": 5,
    "minReachPercent": 3,
    "onlyPassing": true,
    "maxItemsPerRun": 60,
    "maxProxyMegabytes": 250,
    "blockResourceTypes": ["image", "media", "font"],
    "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

The screen runs in stages, cheapest first, and each costly step only touches profiles that have not failed yet:

1. **First screen** (no extra page loads): follower range, contact e-mail in the bio, and the `excludeBioPatterns` text in the bio and the links shown in it.
2. **Link-in-bio pages** (`followLinkInBio`, on by default when `excludeBioPatterns` is set): for profiles that passed, the Actor opens their link-in-bio pages (linktr.ee, beacons.ai, bio.link, carrd.co, stan.store and similar; up to 2 pages, 40 links each) and checks the destination links against the same patterns. A Stan Store one click behind a Linktree is now seen: the row has `bioLinkTargets` (the destinations found) and fails with `bio or link contains "stan.store"`. A page that cannot be read, shows no links, or answers with an error or bot-check page (a Beacons page once answered with a Cloudflare 5xx page) is listed in `screeningWarnings` and its links are not used: it is **not** counted as clean, so check those rows by hand. Verified live on Linktree (planbudgetdream: Amazon storefront and amzn.to links found; savvymoneygirl: 9 destinations); Beacons was blocked in that test.
3. **Reach rule** (`reachPosts`, 0 = off; use 4-6): for profiles that passed, the latest posts are read and the row gets `postsSampled`, `medianLikes`, `medianComments`, `medianViews`, `likesPctOfFollowers`, `viewsPctOfFollowers` and `reachPctOfFollowers` (median views of the sampled posts / followers when at least 3 posts show views, otherwise median likes / followers; `reachBasis` says which). `minReachPercent` makes profiles below it fail with the numbers. If fewer than 3 posts carry counts (creators often **hide post likes**: Instagram then shows only the comment count) reach is `null`: it is never guessed, it does **not** fail the profile, and the row gets a `screeningWarnings` entry ("reach not computed ... check the reach by hand"). Only a measured reach below `minReachPercent` fails. So **a row with `screeningWarnings` passed every check that could be run; check the listed ones by hand.** Each post row says when its likes are hidden, or when its page could not be loaded; in that case the row warns "N of M post pages could not be loaded" so a failed load is not mistaken for hidden likes. `commentsPctOfFollowers` (median comments / followers) is returned as well: it is available even when likes are hidden. From 0.10.3 post pages are read as soon as they have loaded (before, a 30-second wait for network silence could throw away a page that had loaded, which left reach empty). Instagram rounds large like counts (e.g. "117K"); the median is on those displayed numbers.

Bios are read in full (the Actor clicks Instagram's "... more"), and e-mails written in the bio fill `contactEmails` (verified live: planbudgetdream, cazza_time, savvymoneygirl). Each row comes back with `passesFilters` and `filterFailures`; with `onlyPassing` only the profiles that meet every criterion are written (blocked or failed lookups are still written, marked as such). Start with 20-30 handles, read `OUTPUT.cost`, then scale. Measured on 20 handles with every stage on (build 0.0.63): $0.18 in total (about $0.009 per handle), 125 MB of traffic; it took 25 minutes, which 0.10.3 should cut a lot (it no longer waits for network silence on profile and post pages).

Optional stricter pattern list if you also want to exclude other digital-product sellers (your decision; the defaults above only cover Stan Store and e-books): add `selar.co`, `nestuge`, `gumroad`, `payhip`, `whop.com`, `teachable`, `kajabi`, `podia` to `excludeBioPatterns`. They are matched against the bio, the links in it and the destinations behind link-in-bio pages. The link-in-bio and reach steps add cost only for profiles that passed the first screen (link pages are light; reach costs one extra profile load plus one page per sampled post, roughly $0.02-0.03 per profile at about $2 per GB).

**Not possible logged out: the Instagram "Contact" button email.** Checked live: the public profile page carries no `public_email` or business-email field for either account tested; Instagram only gives it to logged-in sessions. The Actor reads e-mail addresses written in the bio text (`contactEmails`), which is what a visitor sees. For a business email that exists only behind the Contact button, the agent must check the profile by hand or ask the creator.

## Run concurrency

Verified live (three runs started within 3 seconds: two ran together, the third waited about 33 seconds for a slot and then ran). Run **at most 2 runs of this Actor at a time** (and 1 at a time if a run uses a large batch). Parallel browser runs on the same proxy pool made page loads time out (a 60-second seed lookup timeout was seen). From 0.10.0 the Actor enforces this itself: a new run waits until fewer than `maxConcurrentRuns` (default 2) other runs that started earlier are still active, polling every 10 seconds, for up to `concurrencyWaitMinutes` (default 10). If it still has no slot it ends without doing any work and writes `OUTPUT.skipped = true` with the reason; retry later. Set `maxConcurrentRuns` to 0 to turn the limit off.

## Discovery: `expand` mode (new in 0.9.0, needs a live check before you rely on it)

There is no keyword or hashtag search (Instagram and Facebook require a login for it; this Actor never logs in). `expand` finds new creators from creators you already know fit, using only pages a logged-out visitor can see:

1. You give **seeds**: creators that are already good fits (for example `planbudgetdream`, `easy_budget`).
2. The Actor reads each seed's recent posts and comments and collects **the accounts they @mention and the accounts that comment**.
3. It ranks those accounts (seen by more seeds first, then most sightings, deliberate @mentions above plain comments), skips the seeds and anything in `excludeUsernames`, and looks up the top `maxCandidates`.
4. Each candidate comes back as a normal profile row plus: `discoveredFrom` (which seeds), `discoverySignals` (`mention` and/or `commenter`), `timesSeen`, `discoveryExamples` (post URLs) and, if you give criteria, `passesFilters` and `filterFailures` (the reasons).

Then repeat: candidates that pass become the next round's seeds. Pass every handle you have already screened in `excludeUsernames` so nothing is looked up twice.

Screening criteria (optional, also work in `profile` mode): `minFollowers`, `maxFollowers`, `requireContactEmail`, `excludeBioPatterns` (text matched in the bio and link URLs, e.g. `stan.store`, `ebook`), `onlyPassing`. The Actor reports facts against your criteria; it never guesses a missing value as a pass. `onlyPassing` leaves out profiles that were read fine but fail; blocked or failed lookups are always written.

Honest expectations:

- Most commenters are ordinary followers, not creators. The strongest signals are accounts the seed **mentions or tags** and accounts that appear under **several** seeds' posts. Expect a modest yield per round, more with more seeds.
- **Instagram** signals: accounts @mentioned in captions and comments, and commenters.
- **Facebook** works too (seeds are Page names such as `NASA`). Signals: accounts tagged or linked in the Page's latest post, and commenters (with their `@handle` when they have one). Anonymous visitors see only the latest post(s) and a few comments per Page, so each seed gives fewer candidates than on Instagram, and many commenters are personal profiles, which the Actor cannot read as Pages (those rows come back as `not_found`, `private` or `blocked`, marked as such). Use a small `maxCandidates` on Facebook; tagged Pages are the useful signal.
- **TikTok** can only use @mentions in captions (comments are not available).
- **Live results, Instagram (build 0.0.53, seeds `planbudgetdream` + `easy_budget`, 3 posts each, images/video/fonts blocked):** the run completed in 3.5 minutes, read 55 comments, found 64 sightings, looked up 10 candidates with exact follower counts, bios and links, and used about 72 MB of proxy traffic (roughly $0.15 at about $2 per GB, the platform's own rate). **0 of 10 candidates passed the 30-150K + bio-email screen.** Why:
    - Most people who comment on a creator's posts are ordinary followers (81, 166, 348, 1,121, 1,467 followers...). The audience is not where 30-150K creators come from.
    - Some @mentions are scam-style accounts that do not exist ("invest_brittany_platform_"): they come back `not_found`.
    - Two "commenters" (`129`, `2.4k`) were like counts read as names. Fixed in 0.9.3 (such rows are now dropped).
- **Second live run (build 0.0.55 = code 0.9.3, same two seeds, 30 candidates, pre-screen on):** 30 candidates looked up in 12 minutes, **0 of 30 passed** the 30-150K + bio-email screen. The pre-screen worked (13 candidates were rejected from the light follower count without a full profile read). The audience is tiny accounts (3-9,000 followers); the only accounts near creator size were two _above_ the range (`carlallenofficial` 195,981, `lisasongsutton` 216,982). Seed captions gave no @mentions this time. Measured cost: **about $0.29 in total** (proxy $0.21 for 137 MB, compute $0.08), roughly $0.01 per candidate.
- **Honest conclusion: `expand` from two seeds does not find creators in your range.** Commenters are the audience, not peers. Do not rely on it as the main source of candidates.
- **What gives the best result: use curated lists for candidates and this Actor as the batch screener.** The Marketing Agent's web-list handles already come from creator-curated pages (its hit rate was better than 1 in 5). Put those handles in `profile` mode WITH the screening criteria and `onlyPassing: true`, in batches of 30-50: the Actor reads each profile (follower count, bio, links, e-mail), checks your criteria, and returns only the usable ones, with `filterFailures` explaining every reject if you turn `onlyPassing` off. That replaces screening 60 handles by hand. Budget about $0.01 per handle.
- **`expand` remains useful** as a secondary source when you can give it **10-20 confirmed fits**: accounts that appear under several seeds rank first and are more likely to be creators in the same niche. Run it only on good seeds and read `OUTPUT.expand` for what it saw.
- **Facebook (build 0.0.51, `NASA` Page, latest post only):** no candidates: the latest post tagged nobody and showed no commenter handles. Facebook yields far less than Instagram for anonymous visitors.
- **Blocking images/video/fonts works on Instagram** (data intact): always pass `"blockResourceTypes": ["image", "media", "font"]` for Instagram. It roughly halves the traffic. Keep the default (`media` only) for TikTok (blocking images made it return an empty page) and use it cautiously on Facebook.
- **Cost:** about $2 per GB of residential proxy (16.6 MB measured = about $0.03). The proxy line in `OUTPUT` can lag: re-read it a minute later.
- Read `OUTPUT.expand`: per seed, `profileStatus`, `postsRead`, `captionMentions`, `commentsRead`, `commenterSightings`, plus the total `sightings`, `candidates`, `lookedUp` and `preScreened`. A run that returns nothing explains itself there.

Example:

```json
{
    "mode": "expand",
    "platform": "instagram",
    "usernames": ["planbudgetdream", "easy_budget"],
    "maxRecentPosts": 3,
    "maxCommentsPerPost": 30,
    "maxCandidates": 30,
    "excludeUsernames": ["already", "screened", "handles"],
    "minFollowers": 30000,
    "maxFollowers": 150000,
    "requireContactEmail": true,
    "excludeBioPatterns": ["stan.store", "ebook", "e-book"],
    "maxItemsPerRun": 30,
    "maxProxyMegabytes": 200,
    "blockResourceTypes": ["image", "media", "font"],
    "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

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
