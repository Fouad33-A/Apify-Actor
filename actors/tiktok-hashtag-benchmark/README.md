## What does TikTok Hashtag Benchmark do?

Finds **public TikTok videos for a hashtag** (for example `#igcse`, `#satmath`, `#apcalculus`, `#ibmaths`), reads each video's own numbers and returns **view benchmarks**: median, 25th/75th/90th percentile, engagement rate and suggested view targets. You can limit it to videos posted from chosen countries, such as the Gulf. It needs **no login** and no browser, and you also get Apify's scheduling, API access and integrations.

## Why use TikTok Hashtag Benchmark?

- Set realistic **view targets** for your own TikTok or Reels content in a niche.
- See how a hashtag performs in the UAE or Saudi Arabia compared with worldwide.
- Track the same hashtags month after month on a schedule.

## How to use TikTok Hashtag Benchmark

1. Enter hashtags in the **Input** tab, and optionally country codes.
2. Run it. A run takes a few minutes per hashtag because search results are read slowly on purpose.
3. Open the table: one **benchmark** row per hashtag, and one **video** row per video behind it.

## Input

| Field                               | Meaning                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `hashtags`                          | Hashtags, with or without #.                                              |
| `regions`                           | Optional country codes; only videos posted from these countries are used. |
| `maxVideosPerHashtag`, `recentDays` | How many videos to use and how recent they must be.                       |
| `minVideosForBenchmark`             | Below this the row says `thin_sample`.                                    |
| `includeVideos`                     | Add the video rows.                                                       |

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
| `status`                                          | `ok`, `thin_sample`, `no_videos`.                                                |

## How much does it cost?

Each video is one small page read. A hashtag with 50 videos costs a few cents of compute.

## Tips and limits

- **The sample is what search engines return**, usually tens of videos, not TikTok's own "top 50", which is not available without logging in. The row says `thin_sample` when fewer videos than your threshold were found.
- Views are the numbers shown on each video page at the time it was read.
- The search step is spaced about 5 seconds per request and waits out "too many requests" answers. Nothing is bypassed.
- Country comes from TikTok's own "posted from" field; some videos have none and are counted as `unknown`.

## FAQ, disclaimers and support

Only public pages are read; follow TikTok's terms when using the data. Questions or problems: open an issue in the Issues tab.
