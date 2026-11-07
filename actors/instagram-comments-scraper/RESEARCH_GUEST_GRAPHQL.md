# Instagram guest GraphQL research — 2026-11-07

## Verified live benchmark (connected public-Actor account)

Public Actor: xmolodtsov/instagram-comment-scraper (V80ZaSeIcb3S64ADj).
- Input full URL for `/khanacademy/reel/DZ5MZOkE532/` returned "No valid Instagram post URLs or shortcodes"; **bare shortcode worked**.
- Run `tIyXQaVME9ncBdWTZ`: 17 unique top-level comments for `DZ5MZOkE532` (prior stable internal scraper: 12–13; prior signed-in observation: 18).
- Run `Tjcw9OWUS7eQdtrT7`: 5 comments for `DdosTElFCwR` and 17 for `DZ5MZOkE532`; 22 unique IDs, 11 requests, 6 pagesRequested/pagesAnswered in aggregate, but **one comment page per post**. No proof of multi-page cursor pagination.
- STATISTICS: proxyMode "Apify datacenter", docIdSource "pinned:27837656105907150", cleanEnd true for both, zero failed requests.
- Run `9iedFgL200AtYsW4F`: limit 3 returned 3 but reported cleanEnd true; **cleanEnd alone is not a completeness guarantee**.
- Public Actor README describes guest GraphQL queries, pinned-comment doc ID candidates, JavaScript bundle query-ID discovery, in-run deduplication. Source code is not available through the public Actor connector.

## Verified internal browser experiment (other account)

- Run `cyGlHPMGEfRyV0Bnb`: Chrome loaded logged-out reel, rendered comments, clicked "Load more comments", captured five `/api/graphql` POST responses. One returned `Unauthorized logged out query.` with code 1675002; no additional comments.
- This is evidence that **that specific browser query** is unauthorized, not that all guest queries are forbidden.
- Stable branch `import/instagram-comments-web-ide-nov7` remains production reference, with HTML extraction and denied `/api/v1/media/{id}/comments/` endpoints.

## Candidate methods (unverified in our own Actor)

1. Guest `/api/graphql` POST with `doc_id=27837656105907150`, media ID and variables. The exact variable schema, headers, response shape and whether this ID works are **not yet verified**.
2. Another public GraphQL query ID reported in open-source aiograpi: `6974885689225067`. Must independently test, not assume interchangeable query signatures.
3. Scan publicly served JavaScript for query metadata / doc IDs, with per-run cache. Do not assume a regex match is the correct comment query; validate with response structure.
4. Parse `edges[].node` and `page_info.end_cursor/has_next_page`, as well as alternative `comments[]` shapes. Follow cursors only if the response actually supplies them.
5. Preserve embedded HTML fallback and status `unverified_partial_possible`. Do not claim complete coverage based on count or cleanEnd alone.

## Next engineering acceptance

- Isolated research branch: `research/instagram-guest-graphql-nov7`; no production edits yet.
- Add a bounded GraphQL diagnostic runner with configurable candidate doc IDs and safe response metadata; do not persist authentication headers or cookies.
- On private Actor account, test same two benchmark posts; compare unique IDs, not only row count.
- Test an independently selected high-comment post to establish whether cursor pagination works across **two or more pages**.
- Only promote after successful runtime test and no regressions to filtering, URL normalization, deduplication, and no-data semantics.

## Cost and risk

- Third-party Actor is free under the user's connected free account; its output is not a guarantee of complete Instagram data.
- No login credentials or cookies are required for the research benchmark.
