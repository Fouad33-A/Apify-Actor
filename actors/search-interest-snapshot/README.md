## What does Search Interest Snapshot do?

Reads **Google Trends** for your keyword list, **country by country**, and returns a flat table: the average, latest and peak interest, whether it is **rising or falling**, the peak date, and the top and rising related searches. Download it as **CSV, Excel or JSON**, schedule it on the Apify platform, and call it through the API. It needs **no login** and no browser.

## Why use Search Interest Snapshot?

- Compare demand for exams and courses (igcse, sat prep, ib maths) across the Gulf and other countries.
- See what is rising before the season starts.
- Replace screenshots of the Trends page with data you can sort and chart.

## How to use Search Interest Snapshot

1. Enter your keywords and country codes in the **Input** tab.
2. Choose the time range (the default is the last 12 months).
3. Run it and open the table, or download the CSV.

## Input

| Field                                      | Meaning                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `keywords`                                 | Search terms.                                                           |
| `geos`                                     | Country codes (AE, SA, QA, GB, US). Empty means worldwide.              |
| `timeRange`                                | `today 12-m`, `today 3-m`, `today 5-y`, `now 7-d`, `all` or two dates.  |
| `compareTogether`                          | Off: each keyword has its own 0-100 scale. On: up to 5 share one scale. |
| `includeTimeline`, `includeRelatedQueries` | Add one row per time point, and the related searches.                   |

## Output

```json
{
    "recordType": "interest",
    "keyword": "igcse",
    "geo": "AE",
    "timeRange": "today 12-m",
    "average": 54.2,
    "latest": 71,
    "peak": 100,
    "peakDate": "2026-05-03",
    "trend": "rising",
    "trendPct": 38.5,
    "status": "ok",
    "scrapedAt": "2026-10-29T14:00:00.000Z"
}
```

You can download the dataset in various formats such as JSON, HTML, CSV, or Excel.

### Data table

| Field                       | Meaning                                                                         |
| --------------------------- | ------------------------------------------------------------------------------- |
| `average`, `latest`, `peak` | Google's 0-100 index: 100 is the peak for that keyword and place in the period. |
| `trend`, `trendPct`         | Last third of the period against the first third (`rising`, `falling`, `flat`). |
| `recordType`                | `interest`, `timeline` (one per time point) or `relatedQuery`.                  |
| `status`                    | `ok`, `no_data`, `rate_limited`, `http_error`, `unreadable`.                    |

## How much does it cost?

Each keyword and country takes two or three small requests. A run of 10 keywords across 4 countries finishes in a few minutes and costs a few cents.

## Tips and limits

- The numbers are an **index**, not search counts. With "compare together" off, do not compare numbers between keywords.
- Google Trends limits how fast it can be asked. Requests are spaced 2.5 seconds apart and a "too many requests" answer is waited out; if it persists the row says `rate_limited`. Nothing is bypassed.
- Very small keywords show `no_data`.

## FAQ, disclaimers and support

The data comes from the public Google Trends page; follow Google's terms for how you use it. Problems or ideas: open an issue in the Issues tab.


## Marketing Agent compatibility

Optional inputs: `maxItems` limits **all dataset rows** (interest, timeline and relatedQuery), `runLabel` labels each row, and `sinceDate` filters time-series points to UTC dates on or after `YYYY-MM-DD` **within the requested `timeRange`**. Metrics are recalculated from retained points. `sinceDate` does not expand the Google Trends query period or guarantee data at finer resolution. Google Trends returns a relative 0–100 index, not search volumes; comparison caveats still apply.

Every emitted row includes `recordType`, `status`, `scrapedAt`, `sourceUrl` and `runLabel`. A missing or entirely filtered series retains its existing `interest` row with `status: no_data`; no extra duplicate row is created. The key-value store preserves legacy `OUTPUT` and adds `SUMMARY` with the effective inputs, request/row/failure counts, filtered timeline points, stop reason, and `completed`/`partial` status. When `maxItems` is reached, later jobs and output are stopped. Related-query failures remain warnings as in the original scraper.

The Actor is FREE-priced but Apify compute/storage can still incur infrastructure usage; `maxTotalChargeUsd` is not a universal hard compute cap. Control usage with keyword/geo counts, `maxItems`, timeouts, and the existing polite request delay.
