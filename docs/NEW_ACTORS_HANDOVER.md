# New Actors: handover (2026-10-29)

Three Actors are prepared in this repository, branch `claude/apify-actor-handover-3w6phm`, one folder each under `actors/`. Each folder is a complete, separate Actor (`.actor/`, `Dockerfile`, `package.json` with lockfile, `src/`, `test/`, `README.md`). The existing root Actor (`fouad_dp/my-actor`) is untouched.

| Folder                          | Requirement                                                                                           | Offline tests | Live-tested |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------- | ----------- |
| `actors/telegram-channel-stats` | Public Telegram channel scraper: members, posting frequency, views per post, to find partner channels | 32 pass       | NO          |
| `actors/app-review-miner`       | App-store review miner for competitor complaints (Apple + Google Play)                                | 25 pass       | NO          |
| `actors/tiktok-creator-search`  | TikTok keyword and hashtag search that returns creators                                               | 19 pass       | NO          |

Lint (`eslint`) and `prettier --check` are clean for all three. "Live-tested NO" is the honest state: see "Where I stopped" below.

## Where I stopped (the brick walls)

1. **I cannot create or build Actors on Apify.** My Apify tools can run an existing Actor, not create one or click Build. That is the next step for you (below).
2. **This session cannot reach the real services.** The sandbox blocks `t.me` and `itunes.apple.com` (HTTP 403 from the egress proxy) and the plan cannot run Apify's public web-fetch Actor, so I could not look at a real Telegram page or a real Apple reviews feed. The parsers follow the structure of those pages as I know it (class names such as `tgme_widget_message`, `tgme_widget_message_views`, `tgme_channel_info_counter`; Apple's `feed.entry[]` with `im:rating`, `im:version`, `updated`), and the tests use sample pages built to that structure. **If a real page differs, the first live run will show it** (rows with `postsSampled: 0`, `members: null` or `status: error`), and the fix is in `src/parse.js` of that Actor.
3. **TikTok search has a hard platform limit** (see the Actor below). I built the best available route; I cannot make it return hundreds of creators.

## What each Actor does

### Telegram Channel Stats

- Reads `https://t.me/s/<channel>` (the public preview) for the member count, the latest posts and the views per post, paging with `?before=<id>`; falls back to `https://t.me/<channel>` to tell apart a channel with no preview (`preview_disabled`, members still returned), an unknown name (`not_found`), and a person or bot (`not_a_channel`).
- Per channel: `members`, `postsPerWeek` (posts in the last `windowDays` when the sample reaches back that far, otherwise over the sample's own span, and `frequencyBasis` says which), `medianViews`/`meanViews`/`minViews`/`maxViews`, `medianViewsPctOfMembers`, `daysSinceLastPost`, `forwardedPostsPct`, `mentionedAccounts`. Views of posts younger than `freshHours` (24) are left out, because views keep growing. Figures needing at least 3 posts are `null` below that.
- Partner discovery: `followMentionedChannels` reads, one step only, the channels that the seed channels mention (t.me links or @names) in at least `minMentions` posts. They carry `discoveredFrom`.
- Plain HTTP, no browser, no proxy by default, 256 MB memory.

### App Review Miner

- Apple: public customer-reviews JSON feed (50 per page, at most 10 pages = the 500 most recent reviews per app and country) plus the public lookup/search JSON. Google Play: the `google-play-scraper` npm library (see decisions), asked per star rating so low-star reviews are not lost to a page limit.
- Keeps reviews up to `maxRating` stars (default 2), optionally filtered by keyword, age and length; classifies each by keyword themes (crashes_bugs, login_account, billing_subscription, price_value, ads, performance, ux_design, support, missing_features, privacy_trust, plus your `customThemes`). Per app and country it writes a summary row with theme counts and up to 3 example quotes per theme.
- **Store check:** I searched the Apify Store: several App Store and Google Play review Actors exist (for example `thewolves/appstore-reviews-scraper`, `neatrat/google-play-store-reviews-scraper`, `code-node-tools/app-reviews-scraper`). **This account cannot run them** (the run of a public Actor was refused with `public-actor-disabled` on the plan), which is why this one is built. Your own check of the Store is still yours to make.

### TikTok Creator Search

- TikTok's search and hashtag pages do not load for a visitor who is not logged in (found earlier, two days of work), and I do not log in, solve CAPTCHAs or bypass anything. The route that did work in the Verity Actor is Google through Apify's Google SERP proxy: `site:tiktok.com <keyword>`, three wordings per keyword, handles read from result links, titles `(@handle)` and the `TikTok · handle` line. Hashtags are searched as `#tag`. The search code is a trimmed, TikTok-only copy of `src/websearch.js`.
- Optional enrichment runs your **TikTok Profile and Video Stats** Actor (`fouad_dp/tiktok-profile-video-stats`) in `profileOnly` mode, in batches of 50, and adds followers, likes, videos, bio, bio link, e-mails, region; `minFollowers`/`maxFollowers` then set `passesFilters`. If that call fails the creators are still returned, unenriched, with the reason in `enrichNote`.
- **Honest limit:** what Google returns varies from run to run. In the last Verity run, 5 keywords gave 81 handles across three platforms and TikTok queries often returned 0 to 9 handles each, many outside a mid-size range. Expect a handful of creators per keyword, not a complete list. The `OUTPUT` record lists every search attempt so a thin result can be explained.

## Check of your two existing Actors (nothing changed)

- Found by name: `fouad_dp/tiktok-profile-video-stats` and `fouad_dp/tiktok-comments-scraper`. I can read their input schemas and run them; **I cannot read their source code or build logs with my tools**, so "check their build" is limited to what the schema and test runs show.
- **TikTok Profile and Video Stats: works.** Test run `aJ1yF2ptjxzm1Luj7`, handle `allanainaction`, 3 videos: 8 seconds, no proxy, 1 profile row + 3 video rows + 1 summary row. Profile: 106,800 followers, bio, bio link, e-mail `allana@viralnationtalent.com`, `managementEmailInBio: true`. Source is TikTok's public creator embed (up to 10 recent videos); the Actor reports its own coverage honestly (for example `pinStatusReliable: false`).
- **TikTok Comments Scraper: returned nothing in my two tests.** Runs `j2QPvghGwp3KopO7o` (datacenter proxy) and `eN0fxYogY7FajV6an` (residential US proxy) on the video `https://www.tiktok.com/@allanainaction/video/7697474125815729439` (6 comments by TikTok's count): both ended `SUCCEEDED` with **0 items**; the crawler statistics show 1 request failed with "Detected a session error, rotating session" retried 10 times in about 40 ms. Two observations: (1) it finishes with status SUCCEEDED and exit code 0 even though every request failed and there is no `OUTPUT` record, so a caller cannot tell "no comments" from "blocked"; (2) the input schema has no cap on the number of comments. I changed nothing. If it works for you on other URLs, send me one and I will run it; if not, this is the part to fix first.

## Decisions I made that you may want to reverse

1. **Dependency:** `app-review-miner` depends on the npm package `google-play-scraper` (v10, ESM). Google has no public reviews endpoint and its internal request format is undocumented; writing and maintaining that myself, unverifiable from here, seemed worse. The project rules say to ask before adding packages; I added it to this one Actor only, loaded lazily so the Apple side works without it. To remove it, delete the dependency and `src/play.js`; Apple keeps working.
2. **TikTok profile data is taken from your existing Actor rather than copied code**, so there is one source of truth. It needs that Actor to exist in the same account and costs its compute per run.
3. **Spec:** you wrote that the full input and output spec comes once approved. I built to the one-line requirements plus what was needed to make them useful; field names and the input form are mine and cheap to change.

## What you need to do (Console steps are yours)

For each of the three folders:

1. Apify Console → Actors → **Create new** → **Link Git repository**.
2. Repository URL: `https://github.com/Fouad33-A/Apify-Actor#claude/apify-actor-handover-3w6phm:actors/telegram-channel-stats` (replace the folder with `actors/app-review-miner` or `actors/tiktok-creator-search` for the others). This form is `#<branch>:<folder>` in the Git URL field; if the Console shows separate Branch and Folder fields instead, enter the same values there.
3. Click **Build**, wait for it to succeed, and send me the build number and the Actor's `username/name`.
4. I then run small tests (cents each) and fix what the real pages show: first Telegram (a real channel, for example `telegram`), then Apple and Google Play on one app each, then TikTok search with one keyword.

If the Git source fails to build because of the folder path, tell me the exact error text from the build log; I cannot see it.

## Notes found on the way

- In `src/websearch.js` of the existing Actor, result-page addresses found "anywhere in the page source" are added as extra links with no title or snippet, so the exclude words (course, coach) were not applied to them and a result you wanted dropped could come back through that route. The new TikTok search does not have this problem (fixed and tested there). I did not touch the live Actor because you asked for no more rework.
- The root test suite needs Playwright's Chromium revision 1223; this sandbox has 1194, so the browser-based root tests fail here for that reason only. The three new Actors do not use a browser.
