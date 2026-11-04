// Rate-limit detection: fail fast and specifically, never silently retry and
// burn quota, per the requirements doc. This is deliberately conservative -
// a false "not a rate limit" costs a wasted retry; a false "rate limit" stops
// the run early and tells the Marketing Agent exactly what to look at. Either
// is recoverable. Silently retrying into a block and burning the run's
// budget is the one failure mode the requirements explicitly rule out.

export class RateLimitError extends Error {
    constructor(platform, endpoint, detail) {
        super(`Rate limited by ${platform} at ${endpoint}: ${detail}`);
        this.name = 'RateLimitError';
        this.platform = platform;
        this.endpoint = endpoint;
        this.detail = detail;
    }

    toRecord() {
        return {
            platform: this.platform,
            endpoint: this.endpoint,
            message: this.message,
            at: new Date().toISOString(),
        };
    }
}

// HTTP-level check - use on every response the crawler sees.
export function checkHttpStatusForRateLimit(platform, endpoint, statusCode) {
    if (statusCode === 429) {
        throw new RateLimitError(platform, endpoint, 'HTTP 429 Too Many Requests');
    }
    // Some platforms (Instagram, Facebook) return 403 for both "blocked" and
    // "rate limited" - checkPageForRateLimit below narrows that using page
    // content, since a bare 403 alone is too ambiguous to call a rate limit.
}

// Page-content check - platform-specific markers seen in real testing
// (see Marketing Scraper README's "What actually works" section for the
// anonymous-vs-cookie findings this is built on).
const MARKERS = {
    tiktok: [/Verify to continue/i, /captcha/i, /unusual traffic/i, /overload-protect/i],
    instagram: [/Please wait a few minutes/i, /Try Again Later/i, /rate limit/i],
    facebook: [/you.?ve been temporarily blocked/i, /unusual activity/i, /try again later/i],
};

export function checkPageForRateLimit(platform, endpoint, pageText) {
    const markers = MARKERS[platform] || [];
    for (const re of markers) {
        if (re.test(pageText)) {
            throw new RateLimitError(platform, endpoint, `Block/rate-limit page matched ${re}`);
        }
    }
}

// Checks what a visitor would actually see. Scanning raw HTML is wrong: normal pages carry
// words like "captcha" or "rate limit" inside script bundles (TikTok's page does), which
// would falsely stop a healthy run.
// Runs page.evaluate, retrying when the page navigates or reloads underneath it (TikTok's first response is
// often a small challenge page that reloads itself once).
export async function evaluateStable(page, fn, arg, { retries = 3, settleMs = 1500 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await page.evaluate(fn, arg);
        } catch (err) {
            const navigating = /Execution context was destroyed|navigation/i.test(String(err?.message));
            if (!navigating || attempt >= retries) throw err;
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await page.waitForTimeout(settleMs);
        }
    }
}

export async function assertNotRateLimited(page, platform, endpoint) {
    const text = await evaluateStable(page, () => (document.body ? document.body.innerText : ''));
    checkPageForRateLimit(platform, endpoint, text);
}
