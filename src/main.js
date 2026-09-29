import { Actor, log } from 'apify';
import { chromium } from 'playwright';

import { BudgetTracker } from './budget.js';
import { makeCharger } from './charging.js';
import { parseCookieHeader } from './cookies.js';
import { CostTracker } from './cost.js';
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
    maxProxyMegabytes = 300,
    proxyPricePerGbUsd = null,
    blockHeavyResources = false,
    standardUserAgent = false,
    fullChromium = false,
    hideAutomationFlag = false,
    sessionCookies = '',
    proxyConfiguration: proxyInput = { useApifyProxy: true },
} = input;

if (!PLATFORM_MODULES[platform]) {
    throw new Error(`Unknown platform "${platform}" - expected tiktok, instagram or facebook`);
}
const mod = PLATFORM_MODULES[platform];
const budget = new BudgetTracker(maxItemsPerRun);
const cost = new CostTracker({
    budget,
    maxProxyMegabytes: maxProxyMegabytes || null,
    proxyPricePerGbUsd,
    memoryMbytes: Number(process.env.ACTOR_MEMORY_MBYTES) || null,
});
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

// Experiments for sites that treat the default headless shell as a bot:
// - fullChromium: Chrome's full "new headless" mode (the same browser a person runs, without a window)
//   instead of the stripped-down headless shell.
// - hideAutomationFlag: do not set the "controlled by automation" blink flag (navigator.webdriver).
// Neither logs in, solves challenges, or touches any other browser property.
const browser = await chromium.launch({
    headless: true,
    ...(fullChromium ? { channel: 'chromium' } : {}),
    args: hideAutomationFlag ? ['--disable-blink-features=AutomationControlled'] : [],
    proxy: toPlaywrightProxy(proxyUrl),
});
log.info(`Browser ${browser.version()} (fullChromium=${fullChromium}, hideAutomationFlag=${hideAutomationFlag})`);
// The proxy exit country changes the page language (Facebook came back in Romanian on one run), and
// the text parsing is English-based, so ask for English like a normal browser configured for it.
// Optional: headless Chromium announces itself as "HeadlessChrome" in its user agent. With
// standardUserAgent the same browser version is announced as plain Chrome. Nothing else about the browser
// is altered or hidden.
const userAgent = standardUserAgent
    ? `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`
    : undefined;
const context = await browser.newContext({
    userAgent,
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
});

await cost.attach(context, { blockHeavyResources });

if (sessionCookies) {
    const cookies = parseCookieHeader(sessionCookies, PLATFORM_DOMAINS[platform]);
    if (cookies.length) await context.addCookies(cookies);
}

const charger = makeCharger({ actor: Actor, budget, warn: (m) => log.warning(m) });
const page = await context.newPage();

try {
    if (mode === 'probe') {
        const results = await runProbes({ context, probes: input.debugProbes });
        await Actor.setValue('PROBE_RESULTS', JSON.stringify(results, null, 2), {
            contentType: 'application/json; charset=utf-8',
        });
        log.info(`Probe run finished: ${results.length} result(s) saved to PROBE_RESULTS`);
    } else {
        await runMode({ mode, mod, page, input, budget, pushData: (row) => charger.push(row), rateLimitErrors });
    }
} finally {
    await cost.settle();
    await browser.close();
}

// The platform's own usage figure for this run. Best effort: it is aggregated after the run ends, so it can
// be missing or slightly low here; the estimate in `cost` is what this run measured itself.
let platformUsage = null;
try {
    if (process.env.ACTOR_RUN_ID) {
        const run = await Actor.apifyClient.run(process.env.ACTOR_RUN_ID).get();
        platformUsage = {
            usageTotalUsd: run?.usageTotalUsd ?? null,
            usageUsd: run?.usageUsd ?? null,
        };
    }
} catch (err) {
    log.debug(`Could not read platform usage: ${err.message}`);
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
    cost: cost.report({ platformUsage }),
    charging: charger.summary(),
    runtime: { ...runtimeInfo(), proxyUsed: Boolean(proxyUrl), proxyGroups: proxyConfiguration?.groups ?? null },
});
log.info('Run summary', summary);

await Actor.exit();
