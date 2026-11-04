#!/usr/bin/env node
// Free, read-only diagnostic. No Apify, proxy, login, or paid API.
import { writeFileSync, mkdirSync } from 'node:fs';

const pages = [
  'https://ads.tiktok.com/creative/creativeCenter/trends',
  'https://ads.tiktok.com/creative/creativeCenter/trends/video?period=7',
  'https://ads.tiktok.com/creative/creativeCenter/trends/video?period=30',
];
const output = { checkedAt: new Date().toISOString(), pages: [], uniqueHandles: 0, sampleProfiles: [], note: 'HTML-only public access; zero results may indicate client-side rendering or access restrictions.' };
const handles = new Set();
for (const url of pages) {
  const row = { url, status: null, bytes: 0, handles: 0, error: null };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PublicPageDiagnostic/1.0)' } });
    row.status = response.status;
    const html = (await response.text()).slice(0, 2_000_000);
    row.bytes = html.length;
    const decoded = html.replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/%2f/gi, '/');
    const pageHandles = new Set();
    for (const match of decoded.matchAll(/(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([a-z0-9._]{2,24})(?=[/?#"'<\\\s]|$)/gi)) {
      const handle = match[1].toLowerCase();
      if (handle.startsWith('.') || handle.endsWith('.') || handle.includes('..')) continue;
      pageHandles.add(handle);
      handles.add(handle);
    }
    row.handles = pageHandles.size;
  } catch (error) {
    row.error = String(error?.message ?? error).slice(0, 200);
  }
  output.pages.push(row);
  console.log(JSON.stringify(row));
}
output.uniqueHandles = handles.size;
output.sampleProfiles = [...handles].slice(0, 20).map((handle) => 'https://www.tiktok.com/@' + handle);
mkdirSync('diagnostics', { recursive: true });
writeFileSync('diagnostics/creative-center.json', JSON.stringify(output, null, 2) + '\n');
console.log('CREATIVE_CENTER_RESULT ' + JSON.stringify(output));
