## What does App Review Miner do?

Reads recent **low-rated reviews of competitor apps** from the **Apple App Store** and **Google Play** and groups the complaints by theme: crashes and bugs, login problems, billing and subscriptions, price, ads, performance, design, support, missing features and privacy. You get one row per review and one summary per app with theme counts and example quotes.

## Why use it?

- See what users of a competitor complain about most, with quotes and dates.
- Find gaps to build for: "missing features" and "ux design" complaints, filtered by keyword.
- Track a competitor over time with the "last N days" filter.

## How to use it

1. In the **Input** tab, add competitor apps (store links, App Store ids or Google Play package names) and/or search keywords such as `meditation app`.
2. Choose the countries and how many stars count as a complaint (default: 2 stars or fewer).
3. Run it. Open the **App summaries** view for the ranking of themes per app and the **Reviews** view for the individual reviews.

## Input

| Field                                                | Meaning                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps`                                               | App Store links/ids or Google Play links/package names.                      |
| `searchKeywords`, `searchStores`, `maxAppsPerSearch` | Find competitor apps by keyword.                                             |
| `countries`, `language`                              | Store countries (each app is read per country) and the Google Play language. |
| `maxRating`                                          | Keep reviews up to this many stars (default 2; 5 keeps everything).          |
| `keywords`, `recentDays`, `minReviewLength`          | Further review filters.                                                      |
| `customThemes`, `themedOnly`                         | Add your own theme words; keep only reviews that match a theme.              |

## Output

App row: `name`, `developer`, `averageRating`, `ratingCount`, `reviewsRead`, `reviewsKept`, `themeCounts` (theme, reviews, share, up to 3 example quotes). Review row: `rating`, `title`, `text`, `date`, `version`, `helpfulVotes`, `developerReply` (Google Play only), `themes`, `themeMatches`.

## Limits

- **App Store:** Apple's public feed exposes the 500 most recent reviews per app and country, so complaints are taken from those.
- **Google Play:** read through the `google-play-scraper` library, with Google Play filtering by star rating. Google changes its pages without notice, so this part can break; the app row then says why.
- Themes are keyword matches in English, not a language model. A review can match several themes. Add words with `customThemes`.
- Review text is public user content; use it for analysis, not for contacting reviewers.
