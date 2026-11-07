import { Actor, log } from 'apify';
import { chromium } from 'playwright';

await Actor.init();
const input = await Actor.getInput() || {};
const urls = (input.postUrls || []).slice(0, 3);
const maxScrolls = Math.max(1, Math.min(20, Number(input.maxScrolls || 8)));
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const raw of urls) {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1365, height: 900 } });
    const page = await context.newPage();
    const seen = new Map(), network = [];
    page.on('response', async response => {
      const url = response.url();
      if (!/instagram\.com\/(?:graphql|api\/v1\/media)/.test(url)) return;
      const item = { path: new URL(url).pathname, status: response.status(), method: response.request().method() };
      try {
        const body = await response.json();
        const stack = [body], visited = new Set();
        while (stack.length) {
          const value = stack.pop();
          if (!value || typeof value !== 'object' || visited.has(value)) continue;
          visited.add(value);
          if (typeof value.text === 'string' && (value.pk || value.id) && (value.user?.username || value.owner?.username)) {
            seen.set(String(value.pk || value.id), { id: String(value.pk || value.id), text: value.text, author: value.user?.username || value.owner?.username });
          }
          for (const v of Object.values(value)) if (v && typeof v === 'object') stack.push(v);
        }
        item.commentsObserved = seen.size;
      } catch { item.nonJson = true; }
      if (network.length < 60) network.push(item);
    });
    let navigationError = null;
    try { await page.goto(raw, { waitUntil: 'domcontentloaded', timeout: 35000 }); } catch (e) { navigationError = String(e.message).slice(0, 180); }
    await page.waitForTimeout(3000);
    const initial = seen.size;
    const steps = [];
    for (let i = 0; i < maxScrolls; i++) {
      await page.mouse.wheel(0, 650);
      await page.waitForTimeout(1100);
      const buttons = page.getByRole('button', { name: /view (all|more)|load more|more comments|see more/i });
      const count = await buttons.count().catch(() => 0);
      if (count) await buttons.first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(700);
      steps.push({ step: i + 1, networkComments: seen.size, matchingButtons: count });
    }
    const result = { sourceUrl: raw, navigationError, finalUrl: page.url(), title: await page.title().catch(() => ''), initialNetworkComments: initial, networkComments: seen.size, steps, network, sample: [...seen.values()].slice(0, 5) };
    results.push(result);
    await Actor.pushData(result);
    await context.close();
  }
  await Actor.setValue('BROWSER_PROBE', { results, note: 'Experimental logged-out browser probe. Network observations are not proof of full comment coverage.' });
} finally { await browser.close(); await Actor.exit(); }
