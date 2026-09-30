# Test brief for the Marketing Agent: verify the screening stages on build 0.0.58

Goal: one real batch that checks the three new stages (link-in-bio following, reach rule, concurrency) on real handles, and measures cost. Read `docs/AGENT_GUIDE.md` first (it is the current version).

## What to run

Run **one run at a time** (do not start a second run until the first has finished, except step 3).

### Step 1: the batch (Instagram, about 20 handles)

Use 20 handles from your own list. Include, if you have them: a few you already know **pass** everything, a few you know **fail because of a Stan Store or ebook hidden behind a Linktree/Beacons link**, and a few with follower counts outside 30-150K. Input:

```json
{
    "mode": "profile",
    "platform": "instagram",
    "usernames": ["<20 handles>"],
    "maxRecentPosts": 0,
    "minFollowers": 30000,
    "maxFollowers": 150000,
    "requireContactEmail": true,
    "excludeBioPatterns": ["stan.store", "ebook", "e-book"],
    "followLinkInBio": true,
    "reachPosts": 5,
    "minReachPercent": 3,
    "onlyPassing": false,
    "maxItemsPerRun": 30,
    "maxProxyMegabytes": 250,
    "blockResourceTypes": ["image", "media", "font"],
    "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

(`onlyPassing` is **false** on purpose: for this test we need to see the rejects and their reasons.)

### Step 2: read the results

From the dataset and from the `OUTPUT` record, report back **exactly** (paste, do not summarize away problems):

1. For each handle: `username`, `status`, `followerCount`, `contactEmails`, `passesFilters`, `filterFailures`, `screeningWarnings`, `bioLinkTargets`, `postsSampled`, `medianLikes`, `medianViews`, `reachPctOfFollowers`, `reachBasis`.
2. From `OUTPUT`: `cost.proxyMegabytes`, `cost.platformUsage.usageTotalUsd` (read it again a minute later if it looks tiny), `budget.stopReason`, `cost.runtimeSecs`, `runtime.codeVersion` (must be 0.10.0), and `rateLimitErrors`.
3. Your own judgement on these checks:
    - Did a Stan Store / ebook hidden behind a link-in-bio page get caught (`bioLinkTargets` contains it and `filterFailures` says so)?
    - Are there rows with `screeningWarnings` about link-in-bio pages that could not be read? Which hosts (linktr.ee, beacons.ai, ...)?
    - Do the `reachPctOfFollowers` numbers look right when you check two or three profiles by hand (median of the last 5 posts' likes / followers)?
    - Anything `blocked`, `error`, or slow?

### Step 3: the concurrency check (only after step 2)

Start **three** very small runs at once (for example 1 handle each, `maxItemsPerRun` 2, `maxProxyMegabytes` 30). Expected: two work at once, the third waits for a slot and then runs. Report the start and finish time of each run and whether any run ended with `OUTPUT.skipped = true`.

## Budget

The whole test should cost roughly **$0.50-$1.00** (20 profiles at about $0.02-0.03 each with reach, plus a few cents). If `cost.platformUsage.usageTotalUsd` for step 1 exceeds $1.50, stop and report before running anything else. Stay within the $2.85/day guideline.

## Send back

Paste the per-handle table, the `OUTPUT` figures and your judgement to the builder. Do not fix or rerun anything on your own if something looks wrong: report it.
