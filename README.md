## What does Verity Social Actor do?

Verity Social Actor looks up **public profile data, recent posts and comments** on **Instagram, Facebook and TikTok** and writes everything into one flat dataset with a consistent row shape. It never logs in, never needs an account, and never guesses: anything it cannot read is returned as `null` with an honest `status`.

It is built for creator-outreach screening: given usernames, you get followers, following, bio, links, public contact emails, verified flag and (where the platform shows them) recent posts and comments.

## What works today

|                        | Instagram                                                             | Facebook                                                      | TikTok                                                                                    |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Profile (Mode A)**   | Yes                                                                   | Yes (Pages)                                                   | Yes (exact counts, bio, link, email in bio)                                               |
| **Recent posts**       | Yes (latest posts, real captions, likes, comment counts, exact dates) | Only what a logged-out visitor sees (usually the latest post) | **Blocked**: TikTok returns an empty video list to this automated browser                 |
| **Post by URL**        | Via profile                                                           | Via comments mode                                             | Yes (`mode: posts`: caption, likes, comments, shares, views, date, author follower count) |
| **Comments (Mode C)**  | Yes (those shown to logged-out visitors, exact timestamps)            | Yes (a few per post, relative times, commenter @handle)       | **Blocked**: TikTok does not load comments for this browser                               |
| **Keyword search (B)** | Needs login (429 + login redirect when logged out)                    | Needs login (search pages return "Not Found" when logged out) | Blocked (empty page, no search data)                                                      |

Wherever TikTok, Instagram or Facebook withhold data, the dataset gets a row with `status: "blocked"` or `"error"` and the reason. Nothing is guessed or filled in. This Actor never logs in and does not try to get around bot detection.

## How to use it

1. Set **Mode** to `profile` and **Platform** to the network you want.
2. Add **Usernames** (for example `nasa`) or, for `posts` / `comments` modes, **Post URLs**.
3. Keep the default **Proxy configuration** but choose the **RESIDENTIAL** group. These platforms block datacenter traffic much more often.
4. Run it and open the dataset. Export as JSON, CSV or Excel.

Start small: `maxRecentPosts` 1-3 and `maxItemsPerRun` 5 costs a few cents.

## Input

| Field                  | Meaning                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `mode`                 | `profile`, `posts` (known post URLs, TikTok), `comments`, `search`, or `probe` (diagnostics) |
| `platform`             | `instagram`, `facebook` or `tiktok`                                                          |
| `usernames`            | Handles without `@` (Mode A)                                                                 |
| `postUrls`             | Post URLs (`posts` and `comments` modes)                                                     |
| `maxRecentPosts`       | Posts per profile                                                                            |
| `fetchComments`        | Also fetch comments for each post returned                                                   |
| `maxCommentsPerPost`   | Comment cap per post                                                                         |
| `topLevelCommentsOnly` | Skip replies                                                                                 |
| `maxItemsPerRun`       | Hard cap on rows written                                                                     |
| `maxProxyMegabytes`    | Hard cap on proxy traffic; the run stops cleanly when reached (default 300, 0 = none)        |
| `proxyPricePerGbUsd`   | Optional: adds an estimated proxy cost in dollars to the cost report                         |
| `blockHeavyResources`  | Skip images/video/fonts to save traffic. Off by default (TikTok returns an empty page if on) |
| `proxyConfiguration`   | Apify Proxy settings                                                                         |
| `sessionCookies`       | Optional, secret. Not needed for anything above.                                             |

## Output

Rows share one shape and are told apart by `recordType` (`profile`, `post`, `comment`). Example profile row:

```json
{
    "recordType": "profile",
    "platform": "tiktok",
    "username": "nasa",
    "displayName": "NASA",
    "bio": "Making the seemingly impossible, possible.",
    "externalLinks": [],
    "contactEmails": [],
    "followerCount": 1872463,
    "followingCount": 23,
    "postCount": 49,
    "totalLikes": 9803342,
    "verified": true,
    "status": "found",
    "statusDetail": null
}
```

`status` is one of `found`, `not_found`, `private`, `blocked` (a login wall or challenge) or `error` (the lookup failed; `statusDetail` says why). A lookup is never silently dropped.

## Honest limits

- **Rounded numbers are labelled.** Where a platform only shows "117K" the row's `statusDetail` says so.
- **Facebook shows relative times only** ("1d"), so `publishDate` is `null` there.
- **Logged-out views are partial.** Facebook and Instagram show only some posts and comments without a login.
- **Instagram's profile page is sometimes login-walled.** The Actor then falls back to Instagram's public embed page: exact counts, verified flag and latest posts, but no bio, following count or links (stated in `statusDetail`).
- Page layouts change. If a platform changes its markup a field can come back `null` or a row can come back `blocked`; the `DIAG_*` records in the run's key-value store show what was seen.

## Cost report

Every run writes an `OUTPUT` record with a `cost` block: runtime, requests, `proxyMegabytes` measured in the browser, compute-unit estimate, an optional dollar estimate, and Apify's own usage figure for the run. Two caps protect spend: `maxItemsPerRun` and `maxProxyMegabytes`; `OUTPUT.budget.stopReason` says which one ended a run. Measured examples: a TikTok profile lookup moves about 7 MB and costs about $0.002 in platform usage plus that traffic on the residential proxy.

## FAQ and disclaimer

Only public data is collected. Respect each platform's terms and applicable privacy law; do not use the output to contact people in ways they have not agreed to. Please report problems through the Issues tab.
