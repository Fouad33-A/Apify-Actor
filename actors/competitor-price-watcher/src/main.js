import { createHash } from 'node:crypto';

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

import { compareWithPrevious, snapshotOf } from './compare.js';
import { extractPage } from './extract.js';

const DEFAULTS = {
    delayBetweenPagesMs: 1500,
    concurrency: 2,
    historyStoreName: 'competitor-price-history',
    updateHistory: true,
};

export function readInput(raw) {
    const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)) };
    const pages = [];
    const invalid = [];
    for (const item of Array.isArray(input.pages) ? input.pages : []) {
        const url = typeof item === 'string' ? item : item?.url;
        const name = typeof item === 'object' ? (item?.name ?? item?.userData?.name ?? null) : null;
        let parsed;
        try {
            parsed = new URL(String(url).trim());
        } catch {
            invalid.push(String(url));
            continue;
        }
        if (!/^https?:$/.test(parsed.protocol)) {
            invalid.push(String(url));
            continue;
        }
        pages.push({ url: parsed.href, name });
    }
    if (!pages.length && !invalid.length) throw new Error('Input "pages" must list at least one pricing page URL.');
    for (const key of ['concurrency']) {
        if (!Number.isInteger(input[key]) || input[key] < 1)
            throw new Error(`Input "${key}" must be a whole number of 1 or more.`);
    }
    input.concurrency = Math.min(input.concurrency, 4);
    return { ...input, pages, invalid };
}

export const competitorName = (url, name) => {
    if (name) return name;
    const host = new URL(url).hostname.replace(/^(www|sat|igcse|collegeprep|library)\./, '');
    return host.split('.').slice(0, -1).join('.') || host;
};

const historyKey = (url) => `page-${createHash('sha1').update(url).digest('hex').slice(0, 16)}`;

export async function fetchPage(url, { proxyUrl, timeoutMs = 30_000 } = {}) {
    const res = await gotScraping({
        url,
        proxyUrl,
        timeout: { request: timeoutMs },
        throwHttpErrors: false,
        headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    return { status: res.statusCode, html: res.body, finalUrl: res.url };
}

export async function run({
    input,
    pushData,
    history,
    fetch = fetchPage,
    proxyUrl,
    shouldStop = () => false,
    now = () => new Date(),
}) {
    const startedAt = now().toISOString();
    const counts = {
        pages: 0,
        ok: 0,
        blocked: 0,
        noPriceFound: 0,
        errors: 0,
        prices: 0,
        increased: 0,
        decreased: 0,
        newPlans: 0,
        gone: 0,
        firstRun: 0,
    };

    for (const bad of input.invalid) {
        await pushData({
            recordType: 'page',
            competitor: null,
            url: bad,
            status: 'invalid_input',
            statusDetail: 'Not a valid http(s) address',
            scrapedAt: now().toISOString(),
        });
        counts.errors += 1;
    }

    const queue = [...input.pages];
    const worker = async () => {
        for (let page = queue.shift(); page && !shouldStop(); page = queue.shift()) {
            counts.pages += 1;
            const competitor = competitorName(page.url, page.name);
            let result;
            let fetched = {};
            try {
                fetched = await fetch(page.url, { proxyUrl });
                result = extractPage({ status: fetched.status, html: fetched.html });
            } catch (error) {
                result = {
                    status: 'error',
                    detail: String(error?.message ?? error)
                        .split('\n')[0]
                        .slice(0, 200),
                    title: null,
                    prices: [],
                };
            }
            const scrapedAt = now().toISOString();
            const base = { competitor, url: page.url };
            const previous = await history.get(historyKey(page.url));
            let priceRows = [];
            if (result.status === 'ok') {
                const cmp = compareWithPrevious(result.prices, previous);
                priceRows = [...cmp.rows, ...cmp.gone];
                if (input.updateHistory)
                    await history.set(historyKey(page.url), { url: page.url, ...snapshotOf(cmp.rows, scrapedAt) });
            }
            for (const r of priceRows) {
                await pushData({
                    recordType: 'price',
                    ...base,
                    status: 'ok',
                    plan: r.plan,
                    price: r.price,
                    priceMax: r.priceMax,
                    currency: r.currency,
                    period: r.period,
                    unit: r.unit,
                    startingAt: r.startingAt ?? false,
                    changeStatus: r.changeStatus,
                    previousPrice: r.previousPrice,
                    change: r.change,
                    changePct: r.changePct,
                    previousScrapedAt: previous?.scrapedAt ?? null,
                    source: r.source,
                    context: r.context,
                    scrapedAt,
                });
                if (r.changeStatus === 'increased') counts.increased += 1;
                else if (r.changeStatus === 'decreased') counts.decreased += 1;
                else if (r.changeStatus === 'new_plan') counts.newPlans += 1;
                else if (r.changeStatus === 'gone') counts.gone += 1;
                else if (r.changeStatus === 'first_run') counts.firstRun += 1;
                if (r.changeStatus !== 'gone') counts.prices += 1;
            }
            await pushData({
                recordType: 'page',
                ...base,
                finalUrl: fetched.finalUrl ?? null,
                title: result.title ?? null,
                httpStatus: fetched.status ?? null,
                status: result.status,
                statusDetail: result.detail,
                pricesFound: priceRows.filter((r) => r.changeStatus !== 'gone').length,
                scrapedAt,
            });
            if (result.status === 'ok') counts.ok += 1;
            else if (result.status === 'blocked') counts.blocked += 1;
            else if (result.status === 'no_price_found') counts.noPriceFound += 1;
            else counts.errors += 1;
            log.info(
                `${competitor} ${page.url}: ${result.status}${priceRows.length ? `, ${priceRows.length} price(s)` : ''}`,
            );
            if (queue.length && input.delayBetweenPagesMs)
                await new Promise((resolve) => {
                    setTimeout(resolve, input.delayBetweenPagesMs);
                });
        }
    };
    await Promise.all(Array.from({ length: input.concurrency }, () => worker()));

    return {
        startedAt,
        finishedAt: now().toISOString(),
        ...counts,
        note: 'Prices are read from the HTML each page returns. Pages drawn by JavaScript report no_price_found, and pages that answer with a bot check report blocked: nothing is solved or bypassed. "change" compares with the last run of this Actor that read the page successfully (history store: see input).',
    };
}

async function main() {
    await Actor.init();
    let stop = false;
    Actor.on('aborting', async () => {
        stop = true;
        await new Promise((resolve) => {
            setTimeout(resolve, 1000);
        });
        await Actor.exit();
    });
    try {
        const input = readInput(await Actor.getInput());
        const store = await Actor.openKeyValueStore(input.historyStoreName);
        const proxy = input.proxyConfiguration ? await Actor.createProxyConfiguration(input.proxyConfiguration) : null;
        const summary = await run({
            input,
            pushData: (row) => Actor.pushData(row),
            history: { get: (k) => store.getValue(k), set: (k, v) => store.setValue(k, v) },
            proxyUrl: proxy ? await proxy.newUrl() : undefined,
            shouldStop: () => stop,
        });
        await Actor.setValue('OUTPUT', summary);
        log.info(
            `Done: ${summary.pages} page(s), ${summary.prices} price(s), ${summary.blocked} blocked, ${summary.noPriceFound} without prices.`,
        );
    } catch (error) {
        log.error(String(error?.message ?? error));
        await Actor.fail(String(error?.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    await main();
}
