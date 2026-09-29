import { Actor, log } from "apify";
import { chromium } from "playwright";

import { BudgetTracker } from "./budget.js";
import { parseCookieHeader } from "./cookies.js";
import * as facebook from "./platforms/facebook.js";
import * as instagram from "./platforms/instagram.js";
import * as tiktok from "./platforms/tiktok.js";
import { toPlaywrightProxy } from "./proxy.js";
import { runMode } from "./run.js";
import { makeRunSummary } from "./schema.js";

const PLATFORM_MODULES = { instagram, tiktok, facebook };
const PLATFORM_DOMAINS = {
  instagram: "www.instagram.com",
  tiktok: ".tiktok.com",
  facebook: ".facebook.com",
};

await Actor.init();

const input = await Actor.getInput();
const {
  mode,
  platform,
  maxItemsPerRun = 2000,
  sessionCookies = "",
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
    `createProxyConfiguration result: ${proxyConfiguration ? "object returned" : "null/undefined"}${ 
      proxyConfiguration
        ? ` groups=${JSON.stringify(proxyConfiguration.groups || null)} countryCode=${proxyConfiguration.countryCode || null} isManInTheMiddle=${proxyConfiguration.isManInTheMiddle}`
        : ""}`
  );
} catch (err) {
  log.exception(err, "createProxyConfiguration threw");
}
try {
  proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
  if (proxyUrl) {
    const redacted = proxyUrl.replace(/:([^:@]*)@/, ":***@");
    const match = proxyUrl.match(/^([a-z]+):\/\/([^:@]*):([^@]*)@([^/]+)/i);
    log.info(
      `Proxy URL (redacted): ${redacted}${ 
        match
          ? ` | scheme=${match[1]} usernameLen=${match[2].length} passwordLen=${match[3].length} host=${match[4]}`
          : " | (URL did not match expected pattern)"}`
    );
  } else {
    log.info("proxyConfiguration.newUrl() returned falsy - no proxy will be used");
  }
} catch (err) {
  log.exception(err, "proxyConfiguration.newUrl() threw");
}

const browser = await chromium.launch({
  headless: true,
  proxy: toPlaywrightProxy(proxyUrl),
});
const context = await browser.newContext();

if (sessionCookies) {
  const cookies = parseCookieHeader(sessionCookies, PLATFORM_DOMAINS[platform]);
  if (cookies.length) await context.addCookies(cookies);
}

const page = await context.newPage();

try {
  await runMode({ mode, mod, page, input, budget, pushData: (row) => Actor.pushData(row), rateLimitErrors });
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
await Actor.setValue("OUTPUT", summary);
log.info("Run summary", summary);

await Actor.exit();
