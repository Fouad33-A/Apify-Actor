## What does Telegram Channel Stats do?

Reads **public Telegram channels** through Telegram's own public web pages (`t.me/s/<channel>` and `t.me/<channel>`) and returns, for each channel, the **number of members**, the **posting frequency** (posts per week) and the **views per post** (median, mean, min, max, and median views as a percentage of members). It is built to rank channels as **partner candidates**. No Telegram account, API key or phone number is needed, and it runs without a proxy.

## Why use it?

- Compare channels by real reach: median views against members shows how many members actually see a post.
- Check that a channel is alive: posts per week and days since the last post.
- Find more candidates: switch on "Also read channels mentioned in the posts" and the channels the seed channels mention often are read too.

## How to use it

1. Open the **Input** tab and list channels (`examplechannel`, `@examplechannel` or `https://t.me/examplechannel`).
2. Optionally set the number of posts to read (default 100), a member range, and whether to follow mentioned channels.
3. Start the run and open the **Channels** view of the dataset. Download it as JSON, CSV or Excel.

## Input

| Field                                                   | Meaning                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `channels`                                              | Public channel names or links. Private invite links (`t.me/+...`) cannot be read and are reported as `invalid_input`. |
| `maxPostsPerChannel`                                    | Most recent posts read per channel (default 100, max 1000).                                                           |
| `windowDays`                                            | Window for posts per week (default 30).                                                                               |
| `freshHours`                                            | Posts younger than this are left out of the view statistics (default 24), because views keep growing.                 |
| `minMembers` / `maxMembers`                             | Skip channels outside the range before their posts are read (row status `filtered`).                                  |
| `includePosts`                                          | Also return one row per post.                                                                                         |
| `followMentionedChannels`, `minMentions`, `maxChannels` | One-step discovery of channels mentioned in the posts.                                                                |

## Output

```json
{
    "recordType": "channel",
    "username": "examplechannel",
    "status": "ok",
    "members": 12300,
    "postsSampled": 100,
    "postsPerWeek": 9.33,
    "frequencyBasis": "last 30 days",
    "medianViews": 4100,
    "medianViewsPctOfMembers": 33.33,
    "daysSinceLastPost": 0.4,
    "mentionedAccounts": [{ "username": "partner_channel", "postsMentioning": 4 }]
}
```

`status` is one of `ok`, `filtered`, `not_found`, `preview_disabled` (the channel exists and shows its member count but Telegram publishes no post preview), `not_a_channel`, `blocked`, `error`, `invalid_input`. A figure the page does not show is `null`; nothing is estimated. Views and frequency need at least 3 posts that carry the data.

## Limits

- Only what Telegram shows publicly: channels without a public preview give members only.
- "Members" is the subscriber (channel) or member (group) count shown by Telegram.
- Telegram may answer HTTP 429 if too many channels are read at once; the row says `blocked`. Lower the concurrency or add a proxy.
- Read public information only. Respect Telegram's terms and the privacy of channel owners.
