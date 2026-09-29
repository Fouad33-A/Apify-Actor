// Parses a raw "Cookie:" header string (the format marketing_scraper.py's
// cookie_dir files already use, and what the sessionCookies input field
// expects) into Playwright addCookies() objects for a given domain. Using
// addCookies (not just an extra HTTP header) matters here because Instagram
// and Facebook's client-side JS reads document.cookie directly in places a
// plain request header wouldn't reach.

export function parseCookieHeader(header, domain) {
    if (!header || !header.trim()) return [];
    return header
        .trim()
        .replace(/^cookie:\s*/i, '')
        .split(';')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => {
            const eq = pair.indexOf('=');
            if (eq === -1) return null;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            if (!name) return null;
            return {
                name,
                value,
                domain,
                path: '/',
            };
        })
        .filter(Boolean);
}
