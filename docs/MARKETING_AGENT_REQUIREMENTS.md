# Marketing Agent: initial requirements for the custom Apify Actor

Sources: the Marketing Agent's own requirement text (given to the builder at the start of the TikTok work; quoted exactly in section 1), the standing rules in the Website chat's handover document (2026-09-29), and the four change requests the Marketing Agent added later (section 4). The original detailed spec (MESSAGES.md #14) was not available in the builder's session, so nothing below is taken from it.

## 1. The requirement, word for word

> A custom Apify actor that, given a creator's username or a search keyword on TikTok, Instagram, or Facebook, returns their follower count, bio text (with any contact email or link), and their recent posts' captions, likes, comments, and share/view counts — plus, on request, the actual text of real comments on those posts (with likes and commenter handle). Everything needs to come back complete and unescaped in one joined dataset per call, with missing data marked as such rather than guessed, and with a per-run cap and cost report so spend stays visible. I use this raw data myself to score creators against Verity's own keyword and audience-fit rules — the actor's only job is fetching clean data, not judging it.

## 2. The purpose

Find the right mid-size creators to pitch (for a revenue-split promotion of the four Verity e-books), with less time and fewer credits. The Actor replaces five separate paid Apify Store scrapers with one purpose-built Actor, because the Creator plan cannot run Store Actors (only the account's own Actors and Apify's 7 universal ones).

## 3. The requirements, itemised

| #   | Requirement                                                   | Status (2026-09-30, logged out, no login or CAPTCHA solving)                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Input: a creator username **or a search keyword**             | Username: works on Instagram, Facebook and TikTok (TikTok intermittently). Keyword / hashtag search: **does not work** on any platform logged out. Instagram and Facebook search are behind a login wall; TikTok search never loads.                                                              |
| R2  | Follower count                                                | Works on all three (exact count on Instagram and TikTok).                                                                                                                                                                                                                                         |
| R3  | Bio text with any contact e-mail or link                      | Bio text, e-mails written in the bio (including behind Instagram's "... more") and links work. Instagram's Contact-button e-mail is **not** visible logged out.                                                                                                                                   |
| R4  | Recent posts: caption, likes, comments, share/view counts     | Instagram: works (likes can be hidden by the creator; shares never shown). Facebook: only the latest post and a few comments are visible to anonymous visitors. TikTok: single video URLs work; the profile video list is blocked by TikTok (the creator-embed page worked once, then throttled). |
| R5  | On request: real comment text with likes and commenter handle | Instagram and Facebook: works (limited on Facebook). TikTok: **does not work**, comments never load logged out.                                                                                                                                                                                   |
| R6  | One joined, complete, unescaped dataset per call              | Works: one flat dataset, consistent row shape.                                                                                                                                                                                                                                                    |
| R7  | Missing data marked as such, never guessed                    | Works: `null` / `not_found` / `private` / `blocked`, and `screeningWarnings` for checks that could not run.                                                                                                                                                                                       |
| R8  | Per-run cap and cost report                                   | Works: item cap, proxy-megabyte cap, `OUTPUT.cost` with proxy traffic and platform usage.                                                                                                                                                                                                         |
| R9  | The Actor only fetches clean data, it does not judge          | Kept for the data rows. Optional screening criteria were added later at the agent's request (section 4).                                                                                                                                                                                          |

## 4. Change requests added later by the Marketing Agent

1. **Follow link-in-bio pages** (Linktree, Beacons, bio.link, Stan Store and similar) so the destinations can be screened. Built; Linktree works live, Beacons is blocked by Cloudflare.
2. **Instagram Contact-button e-mail.** Not possible logged out (checked live).
3. **Reach rule:** median views / likes of the latest 4-6 posts as a percentage of followers, only for profiles that pass the first screen. Built; works on Instagram.
4. **Limit concurrent runs** (no more than 2 at once, later runs wait). Built and verified.

Added by the builder at the agent's request: screening by follower range, bio e-mail and "fail if the bio or links contain" patterns; `onlyPassing`; and (0.11.0, not yet run live) reading the creator's own website for what it sells and a public e-mail.

## 5. Standing rules (set by Fouad)

1. **Credentials:** never create, enter, paste or handle any API key, token, password or secret. If a step needs one, stop and give Fouad a step-by-step guide.
2. **No fabricated data:** never infer or guess a missing field; return an honest `null`. Never scrape private accounts. Never bypass CAPTCHAs, logins or paywalls.
3. **Budget:** $85 per month on Apify (about $2.85 per day, a guideline in the agent guide, not a hard rule). Paid tests only with minimal settings and a hard cost cap.
4. **Plan limits:** Creator plan. Do not propose Store Actors or a paid plan as the fix: the point is to customise the Actor.
5. **TikTok:** dropped as a hard target after two days without a reliable result. TikTok One (TikTok's own partner tool) is used for TikTok discovery. Work continues on Instagram and Facebook.
6. **Publishing and monetisation:** Console-only, done by Fouad.

## 6. Where the current Actor falls short of the purpose

The Actor fetches and screens the handles it is given. It **cannot discover creators** from a keyword or hashtag (R1), so the list of candidate handles has to come from outside (TikTok One, curated lists, or web research). In the last run, 90 curated handles gave 6 that passed reach and none that fit.
