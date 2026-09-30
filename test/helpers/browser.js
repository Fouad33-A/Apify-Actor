// Real headless Chromium for tests that exercise the in-page extractors and
// the platform lookup flows. Nothing here touches the network: pages are fed
// synthetic HTML via setContent() or request interception (serve()).
//
// PW_CHROMIUM_PATH overrides the browser binary (useful when the installed
// Playwright version wants a Chromium revision that isn't on the machine).

import { chromium } from 'playwright';

export async function launchBrowser() {
    return chromium.launch({ headless: true, executablePath: process.env.PW_CHROMIUM_PATH || undefined });
}

// Serve synthetic responses for matching URLs; everything else is aborted so a
// test can never reach a real site. routes: [{ match: RegExp, status?, body?, contentType? }]
// (body may be a function of the 1-based hit count, to serve a different page on a retry)
export async function serve(context, routes) {
    const seen = [];
    await context.route('**/*', (route) => {
        const url = route.request().url();
        seen.push(url);
        const hit = routes.find((r) => r.match.test(url));
        if (!hit) return route.abort();
        hit.hits = (hit.hits ?? 0) + 1;
        const body = typeof hit.body === 'function' ? hit.body(hit.hits) : hit.body;
        return route.fulfill({
            status: hit.status ?? 200,
            contentType: hit.contentType ?? 'text/html; charset=utf-8',
            headers: hit.headers,
            body: body ?? '<html><body></body></html>',
        });
    });
    return seen;
}
