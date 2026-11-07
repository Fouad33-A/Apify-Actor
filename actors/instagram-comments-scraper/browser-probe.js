import { Actor, log } from 'apify';
import { chromium } from 'playwright';

await Actor.init();
const input = await Actor.getInput() || {};
const urls = (input.postUrls || []).slice(0, 3);
const maxScrolls = Math.max(1, Math.min(20, Number(input.maxScrolls || 8)));
const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [];
try {
  for (const raw of urls) {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1365, height: 900 } });
    const page = await context.newPage();
    const seen = new Map(), network = [], allResponses = [];
    page.on('response', async response => {
      const url = response.url();
      if (allResponses.length < 100) allResponses.push({ host: (() => { try { return new URL(url).hostname; } catch { return ''; } })(), path: (() => { try { return new URL(url).pathname.slice(0, 120); } catch { return ''; } })(), status: response.status() });
      if (!/instagram\.com\/(?:api\/graphql|graphql|api\/v1\/media)/.test(url)) return;
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
        item.topKeys = Object.keys(body || {}).slice(0, 15);
        item.dataKeys = Object.keys(body?.data || {}).slice(0, 15);
        item.errorSummary = JSON.stringify(body?.errors || body?.error || null).slice(0, 350);
        item.commentRelatedPaths = [];
        const todo = [{ v: body, path: '
      } catch { item.nonJson = true; }
      if (network.length < 60) network.push(item);
    });
    let navigationError = null;
    try { await page.goto(raw, { waitUntil: 'domcontentloaded', timeout: 35000 }); } catch (e) { navigationError = String(e.message).slice(0, 180); }
    await page.waitForTimeout(3000);
    const initial = seen.size;
    const commentButtonsBefore = await page.getByRole('button', {name:/load more comments/i}).count().catch(()=>0);
    const initialText = (await page.locator('body').innerText().catch(() => '')).slice(0, 1000);
    const buttonLabels = await page.getByRole('button').allTextContents().catch(() => []);
    const steps = [];
    const visibleBefore = (await page.locator('body').innerText().catch(() => '')).length;
    for (let i = 0; i < maxScrolls; i++) {
      await page.mouse.wheel(0, 650);
      await page.waitForTimeout(1100);
      const buttons = page.getByRole('button', { name: /view (all|more)|load more|more comments|see more/i });
      const count = await buttons.count().catch(() => 0);
      let clickError = null;
      if (count) await buttons.first().evaluate(el => el.click()).catch(e => { clickError = String(e.message).slice(0, 150); });
      await page.waitForTimeout(700);
      steps.push({ step: i + 1, networkComments: seen.size, matchingButtons: count, clickError, visibleTextLength: (await page.locator('body').innerText().catch(() => '')).length });
    }
    const result = { sourceUrl: raw, navigationError, finalUrl: page.url(), title: await page.title().catch(() => ''), initialNetworkComments: initial, commentButtonsBefore, networkComments: seen.size, initialText, visibleBefore, buttonLabels: buttonLabels.slice(0, 30), allResponses, steps, network, sample: [...seen.values()].slice(0, 5) };
    results.push(result);
    await Actor.pushData(result);
    await context.close();
  }
  await Actor.setValue('BROWSER_PROBE', { results, note: 'Experimental logged-out browser probe. Network observations are not proof of full comment coverage.' });
} finally { await browser.close(); await Actor.exit(); }
, depth: 0 }], walked = new Set();
        while (todo.length && item.commentRelatedPaths.length < 25) {
          const cur = todo.pop(); if (!cur.v || typeof cur.v !== 'object' || walked.has(cur.v) || cur.depth > 9) continue;
          walked.add(cur.v);
          for (const [k,v] of Object.entries(cur.v)) {
            if (/comment|edge|page_info|cursor/i.test(k)) item.commentRelatedPaths.push({ path: (cur.path + '.' + k).slice(0,180), kind: Array.isArray(v) ? 'array:' + v.length : typeof v });
            if (v && typeof v === 'object') todo.push({ v, path: cur.path + '.' + k, depth: cur.depth + 1 });
          }
        }
      } catch { item.nonJson = true; }
      if (network.length < 60) network.push(item);
    });
    let navigationError = null;
    try { await page.goto(raw, { waitUntil: 'domcontentloaded', timeout: 35000 }); } catch (e) { navigationError = String(e.message).slice(0, 180); }
    await page.waitForTimeout(3000);
    const initial = seen.size;
    const initialText = (await page.locator('body').innerText().catch(() => '')).slice(0, 1000);
    const buttonLabels = await page.getByRole('button').allTextContents().catch(() => []);
    const steps = [];
    const visibleBefore = (await page.locator('body').innerText().catch(() => '')).length;
    for (let i = 0; i < maxScrolls; i++) {
      await page.mouse.wheel(0, 650);
      await page.waitForTimeout(1100);
      const buttons = page.getByRole('button', { name: /view (all|more)|load more|more comments|see more/i });
      const count = await buttons.count().catch(() => 0);
      let clickError = null;
      if (count) await buttons.first().evaluate(el => el.click()).catch(e => { clickError = String(e.message).slice(0, 150); });
      await page.waitForTimeout(700);
      steps.push({ step: i + 1, networkComments: seen.size, matchingButtons: count, clickError, visibleTextLength: (await page.locator('body').innerText().catch(() => '')).length });
    }
    const result = { sourceUrl: raw, navigationError, finalUrl: page.url(), title: await page.title().catch(() => ''), initialNetworkComments: initial, networkComments: seen.size, initialText, visibleBefore, buttonLabels: buttonLabels.slice(0, 30), allResponses, steps, network, sample: [...seen.values()].slice(0, 5) };
    results.push(result);
    await Actor.pushData(result);
    await context.close();
  }
  await Actor.setValue('BROWSER_PROBE', { results, note: 'Experimental logged-out browser probe. Network observations are not proof of full comment coverage.' });
} finally { await browser.close(); await Actor.exit(); }
