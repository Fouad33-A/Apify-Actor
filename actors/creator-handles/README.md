# Creator Handles

Standalone TikTok creator discovery Actor. Goal: up to **100** unique public creators with **10,000–150,000 followers** and a **post within the last 7 days**. No median views, comments, or engagement screening.

## How it works

Searches public Bing results for TikTok profile/video URLs, then requests each public profile page using `got-scraping` (the same HTTP-client approach used by the Comments Scraper). Reads the public embedded TikTok profile state for follower count and latest post timestamp. **Never assumes missing information means a pass**. Outputs only profiles with both conditions confirmed.

The target is not guaranteed: search indexing, TikTok access restrictions and missing public fields may yield fewer than 100. The Actor emits a `RUN_SUMMARY` dataset row explaining results and errors. Run with `npm start` from this directory or build as an Apify Actor.
