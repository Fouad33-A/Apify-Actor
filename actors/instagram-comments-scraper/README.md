# Instagram Comments Scraper v2.13

Public-data-only acceptance candidate. Uses a persistent anonymous Instagram session over `got-scraping` with Apify residential proxy support. It does not use Instagram credentials, user-supplied cookies, browsers, external scraper APIs, databases, or third-party data providers.

The Actor bootstraps each public post on `www.instagram.com`, preserves first-party cookies, extracts any embedded public comments, then tries bounded first-party Instagram comment routes using the same session and follows Instagram-provided pagination cursors. Diagnostics are written to `SUMMARY` and `errors` without exposing proxy credentials.
