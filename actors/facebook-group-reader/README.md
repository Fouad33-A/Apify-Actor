## What does Facebook Public Group Reader do?

Reads what a **public Facebook group exposes in logged-out public HTML**: group metadata and structured posts with engagement counts when Facebook embeds them in the page. It **never logs in and never asks for Facebook account credentials, account cookies or access tokens**. When Facebook answers with a login page instead of public group content, the Actor reports `login_wall` and does not try to bypass it.

## Why use Facebook Public Group Reader?

- Collect questions and demand language from public groups.
- Track public group size and visible activity over time.
- Feed public post text into your own analysis workflows.

## How to use Facebook Public Group Reader

1. Paste public group addresses (`https://www.facebook.com/groups/...`) in the **Input** tab.
2. Run it.
3. Check each group row's `status`, then use the post rows that follow it.

## Input

| Field | Meaning |
| --- | --- |
| `groups` | Public Facebook group addresses. |
| `maxPostsPerGroup` | Maximum posts requested. Facebook may expose fewer in logged-out HTML. |
| `sinceDate` | Optional lower date bound for returned posts. |
| `includeAuthors` | Off by default so personal names are not collected unless requested. |
| `maxSessionAttempts` | Fresh anonymous HTTP attempts per group. Default `1`; increase only for login/block resilience. Extra sessions do not guarantee deeper feed results. |
| `proxyConfiguration` | Optional. By default the Actor uses Apify residential proxies. |
| `maxItems` | Optional global cap on dataset rows (group, post and no_data). The summary says `partial` when work is unfinished. |
| `runLabel` | Optional string echoed in every output row and `SUMMARY`. |

## Output

```json
{
    "recordType": "post",
    "groupId": "igcse.help",
    "text": "Is it worth paying for revision notes?",
    "createdAt": "2026-10-20T08:53:20.000Z",
    "reactions": 12,
    "comments": 3,
    "shares": 1,
    "status": "ok",
    "scrapedAt": "2026-10-29T14:00:00.000Z"
}
```

The dataset can be exported through Apify in formats such as JSON, CSV and Excel.

### Data table

| Field | Meaning |
| --- | --- |
| `memberCount`, `name`, `privacy` | Group metadata when Facebook exposes it publicly. |
| `text`, `createdAt`, `url`, `postId` | Structured public post fields when embedded in the page. |
| `reactions`, `comments`, `shares` | Engagement counts when present in the public payload. |
| `status` | `ok`, `no_posts_visible`, `login_wall`, `not_found`, `http_error`, or `invalid_input`. |

## Cost behavior

The default is one anonymous HTTP request per group, using Apify residential proxy routing unless you supply another proxy configuration. `maxSessionAttempts` can be raised for resilience, but repeated sessions may expose the same initial posts and therefore should not be used merely to seek deeper pagination.

## Tips and limits

- **Facebook decides what a logged-out visitor sees.** A public group can expose metadata and only a small initial set of posts, or it can redirect the request to login.
- `maxPostsPerGroup` is an upper limit, not a promise. The Actor returns the public posts it can parse and reports the actual count truthfully.
- The Actor does not reproduce Facebook's undocumented internal Relay/GraphQL pagination protocol, use browser automation, solve CAPTCHAs, or bypass access walls.
- Facebook's public page structure can change. If the embedded structured feed changes, a group may return `no_posts_visible` until the parser is updated.
- Private or otherwise access-restricted groups cannot be read.

## FAQ, disclaimers and support

Only public logged-out content is read. Follow Facebook's terms and applicable law, and do not use the data to identify or contact individuals. For problems, provide a public example group and the Actor run status/logs in the Issues tab.


## ExamRung Marketing Agent compatibility

The original public HTML extraction remains unchanged. Extra output fields include `groupName`, `groupUrl`, `postUrl`, `postedAt`, `sourceUrl`, `runLabel`, `isQuestion`, `topicTags`, `classificationMethod`, and per-group `verificationStatus`. All posts retain their original text and dates.

Question and topic flags are simple text heuristics, **not confirmed classifications**. `rulesText`, `allowsPromotion`, `postsPerWeek`, `language`, and `authorType` are explicitly `null` when anonymous public HTML cannot substantiate them. Do not treat these missing values as evidence that promotion is allowed.

Every group with zero usable posts receives its group row with legacy status and its own `no_data` row (unless `maxItems` prevents it). The run `SUMMARY.status` is `partial` when any group has an `http_error`, `login_wall`, `not_found`, or `invalid_input`, even if other groups succeed. The `groupErrors` count and `groupFailures` array identify affected groups. If the cap prevents a required `no_data` row, the summary is also `partial`. `noDataReason` distinguishes `no_matching_posts`, `group_unverified`, and `no_posts_exposed`. This does not imply the group is nonexistent: Facebook sometimes provides a generic page rather than group content.

The key-value store includes `OUTPUT` for older consumers and `SUMMARY` with exact input, emitted counts, date exclusions and completion status. `maxItems` counts dataset rows; it does not limit proxy expenses. A universal hard dollar budget cannot be enforced by this FREE Actor; run-time and infrastructure spending limits must be configured and monitored externally.

This Actor never authenticates to Facebook or reads private groups. Scraping additional pages is not guaranteed by increasing session attempts, and a few exposed posts are not a reliable sample for computing weekly activity.
