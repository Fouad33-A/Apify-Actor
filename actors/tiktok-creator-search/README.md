## What does TikTok Creator Search do?

Finds **TikTok creators for keywords and hashtags**. TikTok's own search and hashtag pages do not load for a visitor who is not logged in, so the Actor asks **Google** (through Apify's Google SERP proxy) for `tiktok.com` results and extracts the creator handles from them. Optionally it then adds **followers, likes, bio, bio link and e-mails** by running your _TikTok Profile and Video Stats_ Actor in `profileOnly` mode.

## Why use it?

- Turn a topic ("budgeting for beginners", `#debtfree`) into a list of creator handles with evidence: the queries that found them, how often, search snippets and sample video links.
- Filter by follower range once profile data is added (`passesFilters`).
- Hand the handles to your other Actors (profile stats, comments).

## How to use it

1. Enter keywords and/or hashtags in the **Input** tab.
2. Optionally set a follower range and leave "Add profile data" on.
3. Run it and open the **Creators** view.

## Input

| Field                                         | Meaning                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `keywords`, `hashtags`                        | What to search. Hashtags may be written with or without `#`.                           |
| `excludeWords`, `searchModifiers`             | Drop results mentioning words (course, coach...); add words to every query (creator).  |
| `maxSearchPages`, `maxSearchSeconds`          | How deep and how long to search.                                                       |
| `maxCreators`                                 | Cap on creators returned and profiles looked up.                                       |
| `enrichProfiles`, `profileActor`              | Add profile data using your own Actor (default `fouad_dp/tiktok-profile-video-stats`). |
| `minFollowers`, `maxFollowers`, `onlyPassing` | Follower range and whether to return only creators inside it.                          |

## Output

```json
{
    "recordType": "creator",
    "handle": "examplecreator",
    "profileUrl": "https://www.tiktok.com/@examplecreator",
    "queriesMatched": ["budgeting for beginners"],
    "timesSeen": 3,
    "followers": 52000,
    "emails": ["hello@example.com"],
    "passesFilters": true,
    "sampleVideoUrls": ["https://www.tiktok.com/@examplecreator/video/..."]
}
```

## Limits

- **Yield is limited and varies.** Google returns different results from run to run, and many results are accounts outside a mid-size range or not creators. Expect a handful of handles per query, not hundreds. The `OUTPUT` record lists every search attempt.
- Follower figures in search snippets are only used to order the profile lookups; the numbers in the dataset come from the profile Actor.
- If Google answers with a bot check the run stops searching and says so; nothing is solved or bypassed.
- The profile step uses your account's Actor and its compute is billed to you.
