## What does Facebook Public Group Reader do?

Reads what a **public Facebook group shows to a visitor who is not logged in**: the group name, **member count** and the **visible posts** with their reaction, comment and share counts. It **never logs in, never uses cookies and never asks for your Facebook account**, so it is safe to share and publish. When Facebook answers with its login page instead of the group, the Actor says so (`login_wall`) and reads nothing. You also get Apify's scheduling, API access and integrations.

## Why use Facebook Public Group Reader?

- Collect the questions parents and students ask in public education groups.
- Track group size and activity over time.
- Feed post text into your own analysis of demand language.

## How to use Facebook Public Group Reader

1. Paste public group addresses (`https://www.facebook.com/groups/...`) in the **Input** tab.
2. Run it.
3. Check the **status** of each group row: `ok`, `no_posts_visible` or `login_wall`.

## Input

| Field                           | Meaning                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `groups`                        | Public group addresses.                                      |
| `maxPostsPerGroup`, `sinceDate` | How many posts and since when.                               |
| `includeAuthors`                | Off by default so personal names are not collected.          |
| `proxyConfiguration`            | Optional; you choose it. The Actor never logs in either way. |

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

You can download the dataset in various formats such as JSON, HTML, CSV, or Excel.

### Data table

| Field                             | Meaning                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `memberCount`, `name`, `privacy`  | From the group page when it is shown.                                               |
| `reactions`, `comments`, `shares` | Counts shown on the post, when present.                                             |
| `status`                          | `ok`, `no_posts_visible`, `login_wall`, `not_found`, `http_error`, `invalid_input`. |

## How much does it cost?

One page read per group, so a run of a few groups costs a fraction of a cent.

## Tips and limits

- **Facebook decides what a logged-out visitor sees.** From Apify's servers in testing, Facebook redirected group pages to its login page; the row then says `login_wall`. It may behave differently for other networks or groups, which is why the result is reported honestly per group.
- A logged-out page shows only the first posts it loads. Older posts need scrolling or a login and are not read.
- Facebook's page structure is not documented and changes. The post reader looks for the data Facebook embeds in the page; if a page differs, the group row says `no_posts_visible`. Please report an example in the Issues tab.
- Private groups cannot be read.

## FAQ, disclaimers and support

Only public content is read. Follow Facebook's terms, and do not use the data to identify or contact individuals. Questions: open an issue in the Issues tab.
