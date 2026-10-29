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
