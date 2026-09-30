# Agent guide: Verity Social Actor (one page)

Actor: `fouad_dp/my-actor` (private, run through the Apify connector or a saved Task). It fetches raw public data from TikTok, Instagram and Facebook. It does no scoring or judging: that stays with you.

## Budget: stay within about $2.85 per day

The monthly budget is $85, which is about **$2.85 per day**. This is a guideline, not a hard block, but keep it in mind on every run:

- Start small: 1-3 usernames, `maxRecentPosts` 3, `maxItemsPerRun` 20-30. Scale up only if the earlier run was cheap.
- One profile lookup moves about 6-7 MB of residential proxy traffic. Check the real cost before batching dozens.
- After every run read the `OUTPUT` record (key-value store): `cost.proxyMegabytes`, `cost.platformUsage.usageTotalUsd`, `budget.stopReason`. Add the day's runs up yourself and stop for the day when you are near $2.85.
- Always pass `maxItemsPerRun` and `maxProxyMegabytes` (the Actor's own hard caps per run).
- Never re-run a `blocked` lookup in a loop: a blocked platform stays blocked and each retry costs money.

## Always use

```json
{ "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] } }
```

## Recipes

| Goal                                | Input                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Creator profile (any platform)      | `{"mode":"profile","platform":"tiktok","usernames":["nasa"],"maxRecentPosts":0,"maxItemsPerRun":10,"maxProxyMegabytes":60}`    |
| Instagram profile + recent posts    | `{"mode":"profile","platform":"instagram","usernames":["nasa"],"maxRecentPosts":5,"maxItemsPerRun":10,"maxProxyMegabytes":60}` |
| Instagram/Facebook posts + comments | same, plus `"fetchComments":true,"maxCommentsPerPost":10`                                                                      |
| One TikTok video's metrics          | `{"mode":"posts","platform":"tiktok","postUrls":["https://www.tiktok.com/@user/video/123"],"maxItemsPerRun":5}`                |
| Comments on known post URLs (IG/FB) | `{"mode":"comments","platform":"instagram","postUrls":["https://www.instagram.com/p/XXXX/"],"maxCommentsPerPost":10}`          |

Read rows with `get-dataset-items`; read the run report with `get-key-value-store-record` (record `OUTPUT`).

## What works, and what does not (verified live)

- Profiles (followers, bio, links, contact email, verified): TikTok, Instagram, Facebook Pages. Yes.
- Instagram posts (caption, likes, comment count, date) and comments: yes (what a logged-out visitor sees).
- Facebook: latest post(s) and a few comments with commenter handle: yes.
- TikTok video by URL (`posts` mode): caption, likes, comments, shares, views, date, author followers: yes.
- **TikTok profile video list, TikTok comments, TikTok search: blocked by TikTok.** Instagram and Facebook keyword search: need a login, not available.
- To find creators, use TikTok's own discovery tools first, then feed handles and video URLs into this Actor.

## Reading the rows

Every row has `recordType` (`profile`, `post`, `comment`) and `status`:

- `found`: real data. Missing individual fields are `null` (never guessed).
- `private`: only public header facts.
- `not_found`: the account/post does not exist.
- `blocked`: the platform withheld it (login wall or bot check). Treat as **data unavailable**, not as "empty".
- `error`: the lookup failed; `statusDetail` says why.

Rounded numbers are flagged in `statusDetail` (Instagram likes such as "117K"). Facebook has relative times only (`publishDate` null).

## Rules

- Public data only. No logins, cookies or tokens in prompts, chats or the repo.
- Do not score inside the Actor; take the raw rows and apply Verity's own keyword and audience-fit rules elsewhere.
- Report `blocked`/`error` rows to the user instead of hiding them.
