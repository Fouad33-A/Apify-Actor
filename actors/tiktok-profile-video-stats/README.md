# TikTok Profile & Video Stats

Analyze public TikTok creator profiles and a recent-video sample without logging in.

## What it returns

For each requested creator the Actor can return a profile row, recent public video rows, and a creator summary containing follower and engagement metrics, median plays/comments/likes/shares/saves, median audit video IDs, posting cadence, selling/sponsorship signals, top videos by comments (including each top video's comment and save counts), and ready-to-use TikTok Comments Scraper handoffs.

## Public-source coverage

This build uses TikTok's public creator embed for video discovery. That source exposes at most **10 recent candidates**, so `videosPerProfile` is intentionally limited to 1–10. It does not claim 30-video parity.

`isPinned` and `isSlideshow` are populated only when TikTok exposes enough evidence. Unknown state remains `null`; it is not silently converted to `false`. When `excludePinned=true`, explicitly pinned videos are excluded. A conservative date-gap heuristic may also exclude an isolated old highlighted candidate, but that candidate is reported as *suspected highlighted*, not asserted to be pinned.

`postsPerWeek` is calculated as `7 / median adjacent post gap in days` over the selected sample. This is more robust than using the full newest-to-oldest span, which can be badly distorted by one old highlighted/pinned candidate. `medianPostingGapDays` and `postsPerWeekMethod` are returned for auditability.

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