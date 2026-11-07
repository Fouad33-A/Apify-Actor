## What does TikTok Hashtag Benchmark do?

Finds **public TikTok videos for a hashtag** (for example `#igcse`, `#satmath`, `#apcalculus`, `#ibmaths`), reads each video's own numbers and returns **view benchmarks**: median, 25th/75th/90th percentile, engagement rate and suggested view targets. You can limit it to videos posted from chosen countries, such as the Gulf. It needs **no login** and no browser, and you also get Apify's scheduling, API access and integrations.

## Why use TikTok Hashtag Benchmark?

- Set realistic **view targets** for your own TikTok or Reels content in a niche.
- See how a hashtag performs in the UAE or Saudi Arabia compared with worldwide.
- Track the same hashtags month after month on a schedule.

## How to use TikTok Hashtag Benchmark

1. Enter hashtags in the **Input** tab, and optionally country codes. If you already have TikTok video links or creator handles (e.g., from TikTok One or a completed Apify Actor), enter them in **Known TikTok video URLs** or **Known creator handles**. Set **Discover additional videos through search** to false to use only those supplied sources.
2. Run it. A run takes a few minutes per hashtag because search results are read slowly on purpose.
3. Open the table: one **benchmark** row per hashtag, and one **video** row per video behind it.

## Input

| Field                               | Meaning                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `hashtags`                          | Hashtags, with or without #.                                                     |
| `regions`                           | Optional country codes; only videos posted from these countries are used.        |
| `maxVideosPerHashtag`, `recentDays` | How many videos to use and how recent they must be (default: the last 365 days). |
| `minVideosForBenchmark`             | Below this the row says `thin_sample`.                                           |
| `includeVideos`                     | Add the video rows.                                                              |
| `videoUrls`, `creatorHandles`       | Optional known sources to improve coverage when search engines return irrelevant videos. |
| `searchDiscovery`                   | Set false to benchmark only supplied URLs/handles; default true also discovers search results. |
| `maxVideoPageReads`                 | Upper bound on video-page requests per hashtag (default 100); this is not a USD cap. |

## Output

```json
{
    "recordType": "benchmark",
    "hashtag": "igcse",
    "status": "ok",
    "videosUsed": 38,
    "medianViews": 4200,
    "p25Views": 1500,
    "p75Views": 11800,
    "medianEngagementRatePct": 6.4,
    "viewTargets": { "conservative": 1500, "typical": 4200, "ambitious": 11800 },
    "regions": { "AE": 21, "GB": 9, "unknown": 8 },
    "scrapedAt": "2026-10-29T14:00:00.000Z"
}
```

You can download the dataset in various formats such as JSON, HTML, CSV, or Excel.

### Data table

| Field                                             | Meaning                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `medianViews`, `p25Views`, `p75Views`, `p90Views` | Views per video across the sample.                                               |
| `medianEngagementRatePct`                         | Median of (likes + comments + shares) / views.                                   |
| `viewTargets`                                     | Conservative, typical and ambitious targets (25th, 50th, 75th percentile).       |
| `dropped`                                         | Why found videos were left out: not tagged, too old, other country, unavailable. |
| `status`                                          | `ok`, `thin_sample`, `no_videos`, `discovery_rate_limited`, or `discovery_failed`.                                                |

## How much does it cost?

Compute charges depend on the number of discovered candidates, creator-page reads, network timeouts and run duration. The Actor has a configurable per-hashtag video-page request limit, but does not enforce a guaranteed USD spending cap.

## Tips and limits

- **The sample is not TikTok's own "top 50"**, which is not available without logging in. The Actor finds creators who post under the hashtag through search, then reads each creator's recent videos from TikTok's public creator embed and keeps those that carry the hashtag. Search alone mostly returns old videos, so this second step is what gives a recent sample. The row says `thin_sample` when fewer videos than your threshold were found, and shows `creatorsRead` and `dropped` so you can see why.
- Views are the numbers shown on each video page at the time it was read.
- Search discovery checks Brave, Bing and DuckDuckGo, stops using a blocked source, and uses a short delay between search requests. When a source is rate limited, the actor does not bypass its limits.
- Country comes from TikTok's own "posted from" field; some videos have none and are counted as `unknown`.
- The Actor counts only videos whose page confirms the requested hashtag and has a valid view count and post date. Missing metadata is not guessed. Median engagement is calculated only from videos with complete like, comment and share counts.
- A successful run with `no_matching_videos`, `thin_sample`, or `no_videos` is **not** evidence that the hashtag's true performance is low. Search results are not a random or representative sample and can contain unrelated videos.

## FAQ, disclaimers and support

Only public pages are read; follow TikTok's terms when using the data. Questions or problems: open an issue in the Issues tab.
