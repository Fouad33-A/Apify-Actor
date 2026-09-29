## What does Verity Social Actor do?

Verity Social Actor looks up **public profile data, recent posts and comments** on **Instagram, Facebook and TikTok** and writes everything into one flat dataset with a consistent row shape. It never logs in, never needs an account, and never guesses: anything it cannot read is returned as `null` with an honest `status`.

It is built for creator-outreach screening: given usernames, you get followers, following, bio, links, public contact emails, verified flag and (where the platform shows them) recent posts and comments.

## What works today

|                       | Instagram                                                             | Facebook                                                      | TikTok    |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- | --------- |
| **Profile (Mode A)**  | Yes                                                                   | Yes (Pages)                                                   | Yes       |
| **Recent posts**      | Yes (latest posts, real captions, likes, comment counts, exact dates) | Only what a logged-out visitor sees (usually the latest post) | Not built |
| **Comments (Mode C)** | Yes (those shown to logged-out visitors, exact timestamps)            | Yes (a few per post, relative times only)                     | Not built |
| **Search (Mode B)**   | Not built                                                             | Not built                                                     | Not built |

Search, TikTok videos and TikTok comments are not implemented and return `error` rows saying so.

## How to use it

1. Set **Mode** to `profile` and **Platform** to the network you want.
2. Add **Usernames** (for example `nasa`) or, for comments, **Post URLs**.
3. Keep the default **Proxy configuration** but choose the **RESIDENTIAL** group. These platforms block datacenter traffic much more often.
4. Run it and open the dataset. Export as JSON, CSV or Excel.

Start small: `maxRecentPosts` 1–3 and `maxItemsPerRun` 5 costs a few cents.

## Input

| Field                  | Meaning                                          |
| ---------------------- | ------------------------------------------------ |
| `mode`                 | `profile`, `comments`, or `probe` (diagnostics)  |
| `platform`             | `instagram`, `facebook` or `tiktok`              |
| `usernames`            | Handles without `@` (Mode A)                     |
| `postUrls`             | Post URLs (Mode C)                               |
| `maxRecentPosts`       | Posts per profile                                |
| `fetchComments`        | Also fetch comments for each post returned       |
| `maxCommentsPerPost`   | Comment cap per post                             |
| `topLevelCommentsOnly` | Skip replies                                     |
| `maxItemsPerRun`       | Hard cap on rows written (cost safety net)       |
| `proxyConfiguration`   | Apify Proxy settings                             |
| `sessionCookies`       | Optional, secret. Not needed for anything above. |

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

## Cost

A profile lookup with a few posts typically runs 10–40 seconds on 1 GB of memory plus a few megabytes of residential proxy traffic, i.e. cents. Use `maxItemsPerRun` and the run's own timeout as caps.

## FAQ and disclaimer

Only public data is collected. Respect each platform's terms and applicable privacy law; do not use the output to contact people in ways they have not agreed to. Please report problems through the Issues tab.
