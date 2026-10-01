# Saved Task: setup and use (Verity discovery, build 0.12.0)

The Marketing Agent's approved criteria (2026-10-01) are stored once in a saved Apify **Task**. After that the Agent only changes the **search keywords** (and the list of handles already in the tracker).

## One-time setup (you, in the Apify Console, about 3 minutes; no API key is involved)

1. Console > **Actors** > `my-actor` > click **Build** and wait until the build is green. Note the build number (0.12.0 or later).
2. Open the Actor > **Create task** (top right).
3. Name it `verity-discover`.
4. In the Input tab switch the editor to **JSON** and paste the whole content of `docs/TASK_INPUT.json` (it is in the repository, branch `claude/apify-actor-handover-3w6phm`).
5. Open the **Run options** of the Task: **Timeout 3600** seconds, **Memory 2048** MB.
6. **Save**.

## What the Agent changes per run

Only these two fields in the Task input (Console, or the Apify MCP "run task" call with an input override):

```json
{
    "searchKeywords": ["budgeting for beginners", "debt free journey", "index fund investing"],
    "excludeUsernames": ["handle1", "handle2"]
}
```

`excludeUsernames` is the handles already in the tracker (A5): they are not opened at all and are listed in `OUTPUT.discovery.skippedDuplicates`.

## What happens in one run

1. Every keyword is searched on the public web for Instagram, Facebook and TikTok accounts. Google is asked first through Apify's own Google SERP proxy (plain HTTP, billed per search by the platform, no secret needed from you); Bing is the fallback. DuckDuckGo and Brave show CAPTCHAs to automated browsers and are only tried if listed.
2. Up to `maxCandidates` (30) accounts are opened, the three platforms taking turns. Follower counts shown by the search engines are **not** used: each account is re-read from its own page.
3. **A rules (hard filters):** followers 10,000 to 150,000; bio, bio links, link-in-bio pages and the creator's own website checked for the sells-courses/e-books words; management/agency e-mail in the bio; not found / private / blocked; duplicates skipped.
4. **B score (max 60)** for the profiles that passed: B1 not monetised 20, B2 engagement 15, B3 size 10, B4 reachable by e-mail 10, B5 posts per week 5. Profiles below `minScore` 25 fail with the numbers.
5. `crypto` and `trading` only raise a warning.
6. `onlyPassing` is false on purpose: every account that was opened comes back with `passesFilters` and the reason for each failure. Filter on `passesFilters = true`.

## TikTok

TikTok hides most post data when logged out. A TikTok account that passes the hard filters is scored on what can be read; a rule whose data is not shown (B1 sponsored count, B2 engagement, B5 posts per week) is given its **full points** and listed in `scoreUnknownRules` with `scoreUnknownTreatedAsFull: true`. Look those accounts up in TikTok One for the missing numbers. On Instagram and Facebook an unknown rule counts 0 and carries a "check by hand" warning. To treat Facebook like TikTok, add `"facebook"` to `unknownFullScorePlatforms` in the Task.

## Read the run afterwards

- **Dataset:** one row per account with `scorecard` (points per rule), `scoreTotal`, `scoreMax`, `scoreUnknownRules`, `contactEmails` and `contactEmailSources` (where each e-mail was found), `filterFailures`, `screeningWarnings`.
- **OUTPUT > discovery:** for every search: the query, which engine answered (`ok`, `blocked`, `no_results`, `unrecognised`), and how many accounts it gave. `enginesBlocked` lists engines that showed a bot check (nothing is solved or clicked through). `candidatesFound`, `toLookUp`, `preScreened`, `blockedPlatforms`.
- **OUTPUT > cost:** proxy traffic and cost for the whole run. Cost per search is the run cost divided by the number of queries (keywords times platforms).

## Live results (build 0.0.85 = code 0.12.7, 2026-10-01)

2 keywords x 3 platforms: 6 Google searches (3-12 s each), 54 accounts found, 9 looked up (cap for the test), 3 minutes, **$0.13** in total (about $0.014 per account). Instagram `allison` (81k) passed and scored 45 of 60 from 10 real posts; a Facebook page passed on 25 of 60 from 5 real plugin posts; the other accounts failed with named reasons (followers outside 10k-150k, `stan.store` in the bio links). TikTok posts are not read by default (cost), so TikTok's B1/B2/B5 are unknown and take full points, listed in `scoreUnknownRules`. Expect Google's speed to vary (3 s to 65 s per search in earlier runs); the search phase stops after `maxSearchSeconds`.

Notes for the Agent:

- B1 (20) + B5 (5) alone give 25, which is `minScore`: a large page that posts often and has no shop link can pass on those two (a bank did). The fit gate (C3) removes such pages; raise `minScore` to 30 if you want the Actor to require some engagement, size or e-mail as well.
- Most accounts Google returns are outside 10k-150k. Use several keywords per run and `excludeUsernames` for handles already tracked.

## If a search engine blocks the Actor

The run still finishes: the next engine is tried, and the report says exactly what each page showed. If all three engines block or show nothing for every query, `candidatesFound` is 0 and `OUTPUT.discovery.search.queries[].attempts[].detail` holds what the page said. Nothing is solved and no login is used.

## Known limits (unchanged)

Beacons pages are blocked by Cloudflare (warning, links not read). Instagram's Contact-button e-mail is not visible logged out. Words like `course` and `coach` match inside other words (for example "of course"): the row always names the word that matched, so a wrong fail is easy to spot.
