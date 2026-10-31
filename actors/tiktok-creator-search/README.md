## What does TikTok Creator Search do?

Finds **TikTok creators for keywords and hashtags**. TikTok's own search and hashtag pages do not load for a visitor who is not logged in, so the Actor asks **Brave Search** (plain HTTP, no proxy needed; Google through Apify's Google SERP proxy is the fallback) for `tiktok.com` results and extracts the creator handles from them. Optionally it then adds **followers, likes, bio, bio link and e-mails** by running your _TikTok Profile and Video Stats_ Actor in `profileOnly` mode.

## Why use it?

- Turn a topic ("budgeting for beginners", `#debtfree`) into a list of creator handles with evidence: the queries that found them, how often, search snippets and sample video links.
- Filter by follower range once profile data is added (`passesFilters`).
- Hand the handles to your other Actors (profile stats, comments).

## How to use it

1. Enter keywords and/or hashtags in the **Input** tab.
2. Optionally set a follower range and leave "Add profile data" on.
3. Run it and open the **Creators** view.

## Input

| Field                                                                   | Meaning                                                                                                                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `keywords`, `hashtags`                                                  | What to search. Hashtags may be written with or without `#`.                                                                                 |
| `excludeWords`, `searchModifiers`                                       | Drop results mentioning words (course, coach...); add words to every query (creator).                                                        |
| `maxSearchPages`, `maxSearchSeconds`                                    | How deep and how long to search.                                                                                                             |
| `maxCreators`                                                           | Cap on creators returned and profiles looked up.                                                                                             |
| `enrichProfiles`, `profileActor`                                        | Add profile data using your own Actor (default `fouad_dp/tiktok-profile-video-stats`).                                                       |
| `minFollowers`, `maxFollowers`, `onlyPassing`                           | Follower range and whether to return only creators inside it.                                                                                |
| `examPresets`                                                           | Optional starting keywords and hashtags for `igcse`, `sat`, `ib`, `ap`, `a_level`.                                                           |
| `regions`, `languages`, `matchMode`                                     | Prefer (or only keep) creators whose profile says they are in these countries or use these languages. Unknown locations are kept and marked. |
| `addMedianViews`, `videosForMedian`, `minMedianViews`, `maxMedianViews` | Median views of the newest videos (1-10) as an optional figure and filter. Runs your profile Actor in its fuller mode, which costs more.     |

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

## Matching Gulf creators and reach

These are **inputs, not fixed results**: leave them empty and the Actor behaves as before. A creator's country comes from their profile when it shows one; in testing most profiles showed none, so the Actor then reads the country TikTok attaches to the creator's **latest video** (`regionSource: "latest video"`). That needs "Add profile data" and one extra page read per creator. Creators with no country at all say `locationMatch: null`. To steer the search itself toward a region, add words such as `UAE` or `Dubai` to `searchModifiers`. The exam presets are popular starting wordings, not a complete list.

## Limits

- **Yield is limited and varies.** In a live test one keyword gave about 25 handles over two result pages, and a few keywords together gave around 50. Search results change from run to run, and many results are accounts outside a mid-size range or not creators, so expect tens of handles per keyword, not hundreds. The `OUTPUT` record lists every search attempt.
- Follower figures in search snippets are only used to order the profile lookups; the numbers in the dataset come from the profile Actor.
- Brave Search limits how fast it can be asked. Requests are spaced about 5 seconds apart and a "too many requests" answer is waited out; if it keeps limiting, Brave is dropped for the run (Google is used instead when the account has the Google SERP proxy) and the report says so. Nothing is solved, rotated or bypassed.
- The profile step uses your account's Actor and its compute is billed to you.


## Runtime safety and partial results

The Actor owns a soft runtime budget (`maxRunSeconds`, default 270 seconds) and reserves `enrichmentReserveSeconds` (default 60 seconds) for profile enrichment and output. If `maxSearchSeconds` would consume that reserve, the effective search budget is shortened automatically. Creator rows are written after each small enrichment batch instead of waiting for the entire run. Every controlled run also writes a `RUN_SUMMARY` dataset record and the same summary to the `OUTPUT` key-value-store record.

When `onlyPassing` is enabled and no creator passes all requested numeric filters, up to five rows are returned as `recordType: "near_miss"`. These rows are explicitly diagnostic and include `nearMissReason`; they are not passing creators.

`estimatedCostUsd` in the run summary is currently `null` because the authoritative Apify billing amount is not available to the Actor while it is running. The summary says this explicitly rather than presenting a guessed amount as an invoice cost.
