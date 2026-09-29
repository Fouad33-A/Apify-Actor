import { Actor, log } from 'apify';
import { chromium } from 'playwright';

import { BudgetTracker } from './budget.js';
import { parseCookieHeader } from './cookies.js';
import { runtimeInfo } from './diagnostics.js';
import * as facebook from './platforms/facebook.js';
import * as instagram from './platforms/instagram.js';
import * as tiktok from './platforms/tiktok.js';
import { runProbes } from './probes.js';
import { toPlaywrightProxy } from './proxy.js';
import { runMode } from './run.js';
import { makeRunSummary } from './schema.js';

const PLATFORM_MODULES = { instagram, tiktok, facebook };
const PLATFORM_DOMAINS = {
    instagram: 'www.instagram.com',
    tiktok: '.tiktok.com',
    facebook: '.facebook.com',
};

await Actor.init();

const input = await Actor.getInput();
const {
    mode,
    platform,
    maxItemsPerRun = 2000,
    sessionCookies = '',
    proxyConfiguration: proxyInput = { useApifyProxy: true },
} = input;

if (!PLATFORM_MODULES[platform]) {
    throw new Error(`Unknown platform "${platform}" - expected tiktok, instagram or facebook`);
}
const mod = PLATFORM_MODULES[platform];
const budget = new BudgetTracker(maxItemsPerRun);
const rateLimitErrors = [];
const startedAt = new Date().toISOString();

log.info(`Proxy input (raw): ${JSON.stringify(proxyInput)}`);
let proxyConfiguration;
let proxyUrl;
try {
    proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
    log.info(
        `createProxyConfiguration result: ${proxyConfiguration ? 'object returned' : 'null/undefined'}${
            proxyConfiguration
                ? ` groups=${JSON.stringify(proxyConfiguration.groups || null)} countryCode=${proxyConfiguration.countryCode || null} isManInTheMiddle=${proxyConfiguration.isManInTheMiddle}`
                : ''
        }`,
    );
} catch (err) {
    log.exception(err, 'createProxyConfiguration threw');
}
try {
    proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
    if (proxyUrl) {
        const redacted = proxyUrl.replace(/:([^:@]*)@/, ':***@');
        const match = proxyUrl.match(/^([a-z]+):\/\/([^:@]*):([^@]*)@([^/]+)/i);
        log.info(
            `Proxy URL (redacted): ${redacted}${
                match
                    ? ` | scheme=${match[1]} usernameLen=${match[2].length} passwordLen=${match[3].length} host=${match[4]}`
                    : ' | (URL did not match expected pattern)'
            }`,
        );
    } else {
        log.info('proxyConfiguration.newUrl() returned falsy - no proxy will be used');
    }
} catch (err) {
    log.exception(err, 'proxyConfiguration.newUrl() threw');
}

if (proxyInput?.useApifyProxy && !proxyUrl) {
    throw new Error(
        'Apify Proxy was requested but no proxy URL could be created (see the log above). Refusing to continue without it: ' +
            'requests would go out directly from the Apify servers.',
    );
}

const browser = await chromium.launch({
    headless: true,
    proxy: toPlaywrightProxy(proxyUrl),
});
// The proxy exit country changes the page language (Facebook came back in Romanian on one run), and
// the text parsing is English-based, so ask for English like a normal browser configured for it.
const context = await browser.newContext({
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
});

if (sessionCookies) {
    const cookies = parseCookieHeader(sessionCookies, PLATFORM_DOMAINS[platform]);
    if (cookies.length) await context.addCookies(cookies);
}

const page = await context.newPage();

try {
    if (mode === 'probe') {
        const results = await runProbes({ context, probes: input.debugProbes });
        await Actor.setValue('PROBE_RESULTS', JSON.stringify(results, null, 2), {
            contentType: 'application/json; charset=utf-8',
        });
        log.info(`Probe run finished: ${results.length} result(s) saved to PROBE_RESULTS`);
    } else {
        await runMode({ mode, mod, page, input, budget, pushData: (row) => Actor.pushData(row), rateLimitErrors });
    }
} finally {
    await browser.close();
}

const summary = makeRunSummary({
    mode,
    platform,
    startedAt,
    counts: budget.counts,
    budget: budget.summary(),
    errors: rateLimitErrors,
});
await Actor.setValue('OUTPUT', {
    ...summary,
    runtime: { ...runtimeInfo(), proxyUsed: Boolean(proxyUrl), proxyGroups: proxyConfiguration?.groups ?? null },
});
log.info('Run summary', summary);

await Actor.exit();
