# Instagram Comments Scraper v2.13

Public-data-only acceptance candidate. Uses a persistent anonymous Instagram session over `got-scraping` with Apify residential proxy support. It does not use Instagram credentials, user-supplied cookies, browsers, external scraper APIs, databases, or third-party data providers.

The Actor bootstraps each public post on `www.instagram.com`, preserves first-party cookies, extracts any embedded public comments, then tries bounded first-party Instagram comment routes using the same session and follows Instagram-provided pagination cursors. Diagnostics are written to `SUMMARY` and `errors` without exposing proxy credentials.


## GitHub migration and Marketing Agent integration

This is the original Web IDE v2.13 source imported to GitHub, with additive output and filtering features. The anonymous Instagram request routes, pagination, session and proxy logic remain unchanged. Build the Actor in Apify from branch `import/instagram-comments-web-ide-nov7` and source directory `actors/instagram-comments-scraper`.

Optional `runLabel` is echoed in dataset rows and KV `SUMMARY`. Optional `sinceDate` is a strict UTC `YYYY-MM-DD` cutoff on comments with known creation dates; comments without usable dates are retained. Existing `maxItems` remains a total dataset-row cap; `no_data` records count toward it. Comment rows now include `recordType: comment`, `status: ok`, `sourceUrl`, `runLabel`, and aliases `text` and `author`. A post with no accessible matching comments emits a `no_data` row (if capacity remains); request failures emit a status `error` row. KV `SUMMARY` includes effective input, date-exclusion counts, no-data count and completion status. Legacy comment fields and the `errors` key are retained.

**Limitations:** Instagram may deny anonymous requests or omit comments. A successful run or a `no_data` row does not prove a post has no comments. The existing `maxVideosPerCreator` option is not backed by reliable creator identification and must not be relied on as a true per-creator cap. Apify FREE Actor pricing does not provide a universal hard infrastructure-cost cap. Live extraction still needs to be verified after the GitHub build.
