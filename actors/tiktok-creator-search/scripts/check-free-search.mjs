#!/usr/bin/env node
// Public search engine discovery diagnostic: no paid proxy, no Apify, no login.
// Measures actual unique handles, not qualified creators.
import { mkdirSync, writeFileSync } from 'node:fs';

const queries = ['site:tiktok.com/@ "followers" "videos"', 'site:tiktok.com/@ "art" "creator"', 'site:tiktok.com/@ "food" "videos"'];
const engines = {
  bing: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
  brave: (q) => 'https://search.brave.com/search?q=' + encodeURIComponent(q) + '&source=web',
  duckduckgo: (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q), // Google baseline
};
const unique = new Set(), rows = [];
for (const [engine, makeUrl] of Object.entries(engines)) {
  for (const query of queries) {
    const row = { engine, query, status: null, bytes: 0, handles: 0, error: null, sample: [] };
    try {
      const response = await fetch(makeUrl(query), { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscoveryDiagnostic/1.0)' } });
      row.status = response.status;
      const html = (await response.text()).slice(0, 2_000_000);
      row.bytes = html.length;
      const decoded = html.replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/%2f/gi, '/').replace(/&amp;/g, '&');
      const matches = new Set();
      for (const match of decoded.matchAll(/(?:https?:\/\/)?(?:www\.|m\.)?tiktok\.com\/@([a-z0-9._]{2,24})(?=[/?#"'<\\\s&]|$)/gi)) {
        const h = match[1].toLowerCase();
        if (h.startsWith('.') || h.endsWith('.') || h.includes('..')) continue;
        matches.add(h);
        unique.add(h);
      }
      row.handles = matches.size;
      row.sample = [...matches].slice(0, 5);
    } catch (error) { row.error = String(error?.message ?? error).slice(0, 180); }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
const result = { checkedAt: new Date().toISOString(), totalUniqueHandles: unique.size, rows, sampleProfiles: [...unique].slice(0, 30).map(h => 'https://www.tiktok.com/@' + h), caveat: 'Public search HTML only. Handles are unverified candidates; no follower/view/activity screening was performed.' };
mkdirSync('diagnostics', { recursive: true });
writeFileSync('diagnostics/free-search-discovery.json', JSON.stringify(result, null, 2) + '\n');
console.log('FREE_SEARCH_RESULT ' + JSON.stringify({ totalUniqueHandles: unique.size, byEngine: Object.fromEntries(Object.keys(engines).map(e => [e, rows.filter(r => r.engine === e).reduce((n,r) => n + r.handles,0)])) }));
