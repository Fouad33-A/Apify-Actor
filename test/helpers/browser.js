// Real headless Chromium for tests that exercise the in-page extractors and
// the platform lookup flows. Nothing here touches the network: pages are fed
// synthetic HTML via setContent() or request interception (serve()).
//
// PW_CHROMIUM_PATH overrides the browser binary (useful when the installed
// Playwright version wants a Chromium revision that isn't on the machine).

import { chromium } from "playwright";

export async function launchBrowser() {
  return chromium.launch({ headless: true, executablePath: process.env.PW_CHROMIUM_PATH || undefined });
}

// Serve synthetic responses for matching URLs; everything else is aborted so a
// test can never reach a real site. routes: [{ match: RegExp, status?, body?, contentType? }]
export async function serve(context, routes) {
  const seen = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    seen.push(url);
    const hit = routes.find((r) => r.match.test(url));
    if (!hit) return route.abort();
    return route.fulfill({
      status: hit.status ?? 200,
      contentType: hit.contentType ?? "text/html; charset=utf-8",
      body: hit.body ?? "<html><body></body></html>",
    });
  });
  return seen;
}
