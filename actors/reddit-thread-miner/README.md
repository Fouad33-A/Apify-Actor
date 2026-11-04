## What does Reddit Thread Miner do?

Reads **public Reddit threads and their top comments** for the subreddits and keywords you choose, and **tags the language people use when they talk about price**: "worth it", "too expensive", "free alternative" and the **competitors they name**. It reads Reddit's own public **RSS feeds**, with no login, no Reddit account and no API keys. Use it to see how students and parents talk about exam prep in communities such as r/igcse, r/SAT, r/APStudents, r/IBO and r/alevel. You also get Apify's scheduling, API access and integrations.

## Why use Reddit Thread Miner?

- Collect real **demand language** for each exam: what people ask, complain about and compare.
- See which competitors come up, and in what context (price, quality, free options).
- Repeat monthly and watch the conversation change.

## How to use Reddit Thread Miner

1. Enter subreddits (and optional keywords and dates) in the **Input** tab.
2. Run it. Requests are spaced on purpose, so large runs take a while.
3. Open the table: one **thread** row per thread (with its tagged comments) and one **subreddit** row with theme and competitor counts.

## Input

| Field                                                               | Meaning                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `subreddits`, `keywords`                                            | Where to read; keywords use Reddit's search inside each subreddit. |
| `dateFrom`, `dateTo`                                                | Keep threads inside this date range.                               |
| `maxThreadsPerSubreddit`                                            | Cap per subreddit (feeds reach back a limited way).                |
| `includeComments`, `maxThreadsWithComments`, `maxCommentsPerThread` | Comments cost one request per thread.                              |
| `competitors`, `customThemes`                                       | Your own competitor names and extra theme words.                   |
| `proxyConfiguration`                                                | Optional proxy, your choice.                                       |

## Output

```json
{
    "recordType": "thread",
    "subreddit": "igcse",
    "title": "Is Save My Exams worth it?",
    "createdAt": "2026-10-20T10:00:00+00:00",
    "threadThemes": ["price", "worth_it", "competitor"],
    "competitorsMentioned": ["save my exams"],
    "comments": [
        { "author": "u2", "text": "The free resources on YouTube are enough...", "themes": ["free_alternative"] }
    ],
    "status": "ok",
    "scrapedAt": "2026-10-29T14:00:00.000Z"
}
```

You can download the dataset in various formats such as JSON, HTML, CSV, or Excel.

### Data table

| Field                    | Meaning                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `threadThemes`, `themes` | `price`, `worth_it`, `free_alternative`, `competitor` and your own.  |
| `competitorsMentioned`   | Competitor names found in the thread.                                |
| `score`                  | Always `null`: the RSS feeds do not include scores.                  |
| `status`                 | `ok`, `blocked`, `rate_limited`, `not_found`, `no_threads`, `error`. |

## How much does it cost?

All requests are plain HTTP, so even a large run costs only a few cents of compute.

## Tips and limits

- **Reddit may refuse feeds to servers in data centres.** In testing from Apify, feeds were sometimes answered and sometimes refused (HTTP 403 or 429). A refused subreddit gets a row with `status: blocked` or `rate_limited`; the Actor waits out rate limits but never tries to get around a refusal. If this happens often, run it later, raise the delay, or choose a proxy you are entitled to use in `proxyConfiguration`.
- Feeds hold at most 100 entries per page and reach back a limited way, so very old threads may be out of reach.
- Theme tags are keyword matches. The matched words can differ in meaning, so skim the text before quoting.

## FAQ, disclaimers and support

Only public Reddit content is read. Follow Reddit's terms and respect the people behind the posts: do not use the data to identify or contact individuals. Problems or ideas: open an issue in the Issues tab.
