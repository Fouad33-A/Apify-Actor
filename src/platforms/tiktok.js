// TikTok: NOT YET IMPLEMENTED. This is the platform with real, established
// risk - our own earlier testing got hard HTTP 403s on cookie-authenticated
// plain requests, most likely TikTok's X-Bogus/msToken signature
// fingerprinting flagging an unsigned session as more suspicious than an
// anonymous one (see Marketing Scraper README, 2026-09-27). A real browser
// (this actor uses Playwright, not plain requests) changes the odds, but
// per the honest assessment given to Fouad before he subscribed to Apify,
// that's not proven until tested live - do not claim this works until a
// real run against a real TikTok profile confirms it.
//
// Build order: validate Instagram and Facebook first (better evidence base),
// then attempt this with real telemetry from those attempts informing how
// much extra work (stealth tuning, residential proxy, retry/backoff) TikTok
// specifically needs.

export async function lookupProfile() {
  throw new Error("TikTok Mode A not yet implemented - pending live validation, see README");
}

export async function searchPosts() {
  throw new Error("TikTok Mode B not yet implemented - pending live validation, see README");
}

export async function fetchComments() {
  throw new Error("TikTok Mode C not yet implemented - pending live validation, see README");
}
