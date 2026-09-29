// Chromium ignores credentials embedded in a proxy URL
// (http://user:pass@host:port): it sends no Proxy-Authorization header, so an
// authenticating proxy answers 407. Playwright wants them as separate
// `username` / `password` fields. Apify's proxyConfiguration.newUrl() returns
// the embedded-credentials form, so it has to be split before launch.

export function toPlaywrightProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  const u = new URL(proxyUrl);
  const proxy = { server: `${u.protocol}//${u.host}` };
  if (u.username) proxy.username = decodeURIComponent(u.username);
  if (u.password) proxy.password = decodeURIComponent(u.password);
  return proxy;
}
