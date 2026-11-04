# Monetization checklist (pay per event)

The code side is done (`src/charging.js`, version 0.8.0). The steps below are Console-only.

## 1. Events to define (Publishing > Monetization > Actor pricing)

| Event name        | Title   | Description                                            |
| ----------------- | ------- | ------------------------------------------------------ |
| `profile-scraped` | Profile | One profile with followers, bio, links, contact email  |
| `post-scraped`    | Post    | One post with caption, likes, comments, shares, views  |
| `comment-scraped` | Comment | One real comment with text, likes and commenter handle |

- Set `profile-scraped` as the **primary event**.
- **Delete the synthetic `apify-default-dataset-item` event.** If it stays, every row (blocked and error rows too) is charged on top. The Actor logs a warning and writes `OUTPUT.charging.warning` if it is still enabled.
- Keep the synthetic `apify-actor-start` event (Apify covers the first 5 seconds of compute).
- Set a minimum for the user's max-charge limit that covers a start plus one profile.

## 2. Set prices from measured cost, not guesses

Per run the Actor writes `OUTPUT.cost.proxyMegabytes` and `OUTPUT.cost.platformUsage`. A TikTok profile lookup moved about 6-7 MB. Residential proxy is billed per GB on the platform, so:

    cost per profile ~= (MB / 1000) x (your residential $/GB) + compute (about $0.003)
    price to break even = cost / 0.8   (you keep 80% of revenue)

Read your real $/GB and the run's proxy line in Console > Billing > Usage before choosing prices. If the break-even is far above what similar Store Actors charge, either raise the price or cut traffic (`blockHeavyResources` is off by default because it broke TikTok; it is untested on Instagram/Facebook and may cut traffic a lot there).
Apify sets a month's profit for an Actor with negative profit to $0 for payout purposes, but do not rely on that: price above break-even.

## 3. Publish

1. Publishing > Display information: logo and short description.
2. Publishing > Monetization: billing details, payment method, then Development > Insights > Payouts > Verify identity (KYC).
3. Sample output and output schema sections, Actor permissions (limited permissions is enough).
4. Publish on Store.

## 4. First paid test (do this yourself, tiny)

Run `profile` for `nasa` on TikTok with `maxItemsPerRun` 2. Then check `OUTPUT.charging.chargedEvents` (expects `profile-scraped: 1`) and the run's charges in Console. A blocked/error row must show no charge.

## 5. Before going public

- Legal review: scraping Instagram/Facebook/TikTok breaches their terms of service; a public listing is more exposed than private use.
- The public README states what is blocked (TikTok video list/comments/search, IG/FB search).
- The GitHub repo is public: the source is visible whatever the Store's "hide source" setting says.
