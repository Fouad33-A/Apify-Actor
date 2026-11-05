# TikTok Profile & Video Stats

Analyze public TikTok creator profiles and a recent-video sample without logging in.

## What it returns

For each requested creator the Actor can return a profile row, recent public video rows, and a creator summary containing follower and engagement metrics, median plays/comments/likes/shares/saves, median audit video IDs, posting cadence, selling/sponsorship signals, top videos by comments (including each top video's comment and save counts), and ready-to-use TikTok Comments Scraper handoffs.

## Public-source coverage

This build uses TikTok's public creator embed for video discovery. That source exposes at most **10 recent candidates**, so `videosPerProfile` is intentionally limited to 1–10. It does not claim 30-video parity.

`isPinned` and `isSlideshow` are populated only when TikTok exposes enough evidence. Unknown state remains `null`; it is not silently converted to `false`. When `excludePinned=true`, explicitly pinned videos are excluded. A conservative date-gap heuristic may also exclude an isolated old highlighted candidate, but that candidate is reported as *suspected highlighted*, not asserted to be pinned.

## Posting cadence

`postsPerWeek` is span-based: `(dated posts - 1) × 7 ÷ days between the newest and the oldest post used`. A span-based figure is not inflated by a burst of posts, but one old pinned or highlighted video can stretch the span and make the rate look far too low. So some videos are left out of **this calculation only**. They stay in the video rows and in every other metric (medians, top videos by comments, and so on).

Left out of the cadence calculation:

- **Old pinned videos**: videos TikTok marks as pinned (`isPinned: true`) that are older than the oldest unpinned video in the sample. A pinned video posted inside the window of the other posts is an ordinary recent post and counts normally.
- **Suspected highlighted videos**: the same conservative date-gap heuristic described above. They are reported as *suspected*, not asserted to be pinned.

Anything less clear is **not discarded**. The estimate is flagged instead, so you can judge it:

| Field | Meaning |
| --- | --- |
| `postsPerWeek` | The span-based figure, or `null` when it cannot be calculated. |
| `postsPerWeekMethod` | `span_all_sampled_posts`, or `span_excluding_pinned_or_suspected_highlighted` when videos were left out. |
| `postingCadenceConfidence` | `high`, `medium`, `low` or `insufficient`. |
| `postingCadenceFlags` | Why the estimate may be uncertain (see below). |
| `postingCadencePostsUsed`, `postingCadenceSpanDays` | How many posts the figure is based on, and the span in days. |
| `postingCadenceExcludedVideoIds` | Videos left out of the cadence calculation only. |
| `postsPerWeekIfOldestExcluded` | Only when the oldest post looks isolated: the figure without it, next to the main one. |
| `medianPostingGapDays`, `postingAnomaly` | Unchanged: the median gap between adjacent posts, and whether `postsPerWeek` is above 20. |

Flags in `postingCadenceFlags`:

- `pinned_excluded_from_cadence`, `suspected_highlighted_excluded_from_cadence`: videos were left out, see `postingCadenceExcludedVideoIds`.
- `oldest_post_isolated`: the oldest post is at least 14 days (and at least 4 times the typical gap) away from the one before it. It is kept, and `postsPerWeekIfOldestExcluded` shows the alternative. Confidence is `low`.
- `oldest_post_pin_status_unknown`: with the flag above, TikTok did not say whether that oldest post is pinned.
- `few_posts_sampled`: fewer than 5 dated posts (confidence at most `medium`).
- `burst_posting_short_span`: the posts used cover less than a day, so the weekly rate is an extrapolation (confidence `low`).
- `only_pinned_posts_sampled`: every sampled post is pinned, so none could be compared (confidence `low`).
- `fewer_than_2_dated_posts`, `posts_share_one_timestamp`: no figure can be calculated (`insufficient`).

## Selling and sponsorship

`selling` and `sellingSignals` describe creator-owned sales: commerce language in the bio (shop, store, merch, courses, discount codes, affiliate links, booking), commerce link domains (`.shop`, `.store`) and TikTok shop or commerce flags.

Paid or sponsored content is reported separately in `sponsored` (boolean) and `sponsoredSignals`, from the video ad flag and the sponsorship signals found in captions. A creator can be sponsored without selling, and the other way round. `sponsoredCount` and `sponsoredPct` are unchanged.

## Comments handoff

Each creator summary contains two Comments Scraper handoffs:

- `commentScraperInput` keeps the existing top-10-by-comments handoff.
- `commentScraperInputAll` contains **all analyzed videos**, up to the public-source 10-video cap, for full creator question mining.

Both use the same canonical contract:

```json
{
  "videoUrls": ["https://www.tiktok.com/@creator/video/123"],
  "maxCommentsPerPost": 100,
  "includeReplies": false
}
```

A compatibility `postUrls: [{"url":"..."}]` representation is also emitted in both handoffs. TikTok Comments Scraper v2 accepts both forms.

`topVideoUrlsByComments` provides a simple ordered list of up to 10 TikTok video links per creator. Set `outputRows` to `summaryOnly` for one creator summary per successful profile, rather than separate video rows. The ranking is limited to the available public embed sample (up to 10 recent candidates), not the latest 30 videos.\n\n`topVideosByComments` contains the top ten analyzed videos ranked by comment count and includes `videoId`, `videoUrl`, `comments`, `saves`, `plays`, `createdAt`, and `caption`, so comment/save decisions can be made directly from the creator summary without a second lookup.

## Median audit IDs

The summary returns `medianVideoIdsByPlays` and `medianVideoIdsByComments`. With an odd number of usable videos the list contains the middle-ranked video ID. With an even number it contains the two IDs whose values are averaged to produce the numeric median.

## Cost reporting

`estimatedCostUsd` and `billedEvents` are intentionally `null`. Exact Apify billing is authoritative in the run's billing/usage record and is not fabricated inside the Actor. `runMaxTotalChargeUsd` only reflects the platform-provided run charge ceiling when available.

## Limits and safety

Public TikTok only. No TikTok login, user cookies, CAPTCHA solving, browser-signature reverse engineering, fingerprint evasion, or external paid data provider is used. Public availability can change and individual profiles/videos may fail independently.