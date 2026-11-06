# TikTok Comments Scraper

Scrapes comments that TikTok exposes through its anonymous public top-level comment pagination. No TikTok login, user cookies, CAPTCHA solving, signature reverse engineering, or paid external API/service is used.

## Input

Use `videoUrls` for the standard handoff from TikTok Profile & Video Stats:

```json
{
  "videoUrls": ["https://www.tiktok.com/@creator/video/1234567890"],
  "maxCommentsPerPost": 100,
  "includeReplies": false
}
```

`postUrls` remains supported for compatibility and may contain URL strings or `{ "url": "..." }` objects. At least one URL must be supplied. Unknown top-level input fields fail loudly so schema mismatches are visible instead of silently producing no data.

Question clustering is **off by default**. Set `"questionAnalysis": true` to enable legacy repeated-question analysis. With the default `false`, only comment rows and the run summary are emitted; the summary includes `questionAnalysisEnabled: false` and `questionsDetected: null`. Claude can analyze the complete raw comment dataset separately.

## Output

Each saved comment has `recordType: "comment"`, comment/video IDs, text, username, `isQuestion`, `replyCount` when TikTok exposes it, and `isReply: false`.

Every controlled run also writes `recordType: "RUN_SUMMARY"` to the dataset and the same object to the `OUTPUT` key-value-store record. The summary includes per-video coverage, repeated question themes, failures, and truthful cost fields.

## Comment coverage

`maxCommentsPerPost` is a **per-video cap**. Pagination continues until that cap, TikTok reports `has_more=0`, the cursor stops advancing, a page fails, or a safety limit is reached.

TikTok's displayed/reported comment total is not a promise that the anonymous top-level pagination source will return the same number of rows. Reported totals can include replies or comments that TikTok does not expose through this source. The Actor therefore reports both `reportedTotal` and `commentsSaved` per video instead of claiming missing rows were successfully scraped.

## Replies

`includeReplies` is accepted so callers can state their intent, but this build does **not** fetch reply threads. When requested, the Actor logs the limitation and reports `replies.requested=true` and `replies.fetched=false`. It does not fabricate reply coverage.

## Questions

`isQuestion` is a lightweight text heuristic based on question marks and common question openings. The run summary groups recurring question themes locally and deterministically (no external AI/API). Finance-specific themes such as HSA and 529 are grouped even when users phrase the same concern differently. `repeatedQuestions` only returns clusters seen at least 3 times and includes `count`, `distinctVideos`, and up to three representative examples. Unrecognized questions fall back to exact normalized-text grouping.

## Cost

`estimatedCostUsd` and `billedEvents` are `null` because the Actor cannot authoritatively determine the final Apify billing record from inside its own run. Use the Apify run billing/usage record for actual charges/events.


## Repeated-question clustering (v4)

`repeatedQuestions` is computed locally with no external AI/API. Questions are grouped per creator. Exact normalized repeats are retained, and paraphrases are clustered when a recurring pair of meaningful content tokens appears in at least 3 detected questions. Near-duplicate clusters are suppressed. Each emitted cluster includes `creator`, `normalizedQuestion`, `theme`, `count`, `distinctVideos`, and up to 3 examples.

TikTok's reported comment total can vary between pagination responses; the scraper preserves the maximum reported total observed for each video rather than allowing a later lower response to overwrite it.


### v4.3 tighter recurring-question clusters

Generic verbs/adjectives and weak context words such as `go`, `cover`, `best`, `year`, and `plan` are excluded from cluster labels. Pair clusters must contain a meaningful topic token. Strong topic tokens that recur in at least 3 detected questions can also form a cluster by themselves, which merges paraphrases that share the topic but not the same wording (for example HSA questions phrased in different ways). Clustering remains local, deterministic, per creator, and uses no external AI/API.

### v4.1 runtime repair
Restores the HTTP client, video resolver, comment-page fetcher, and genuine-comment parser helpers that were accidentally omitted from the v4 source package. No external paid service was added.


### v4.3 cluster quality

Repeated-question clusters now suppress generic labels such as `about`, `add`, `video`, `one`, `any`, `needed`, `never`, `next`, `week`, `option`, and `month`. Broad `insurance` and creator-curiosity `wife` are also excluded as unattended cluster labels. A cluster is emitted only when it spans at least 2 videos or contains at least 4 detected questions. Cross-video clusters rank ahead of concentrated one-video clusters. Each cluster now presents `questionText` first (a representative real question) and `cluster` second, while retaining `normalizedQuestion` for backward compatibility.