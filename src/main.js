import { Actor, log } from "apify";
import { chromium } from "playwright";
import { BudgetTracker } from "./budget.js";
import { RateLimitError } from "./errors.js";
import { parseCookieHeader } from "./cookies.js";
import { makeRunSummary } from "./schema.js";

import * as instagram from "./platforms/instagram.js";
import * as tiktok from "./platforms/tiktok.js";
import * as facebook from "./platforms/facebook.js";

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
  usernames = [],
  searchQueries = [],
  postUrls = [],
  maxResultsPerQuery = 25,
  maxRecentPosts = 25,
  fetchComments = false,
  maxCommentsPerPost = 20,
  topLevelCommentsOnly = true,
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
    `createProxyConfiguration result: ${proxyConfiguration ? "object returned" : "null/undefined"}` +
      (proxyConfiguration
        ? ` groups=${JSON.stringify(proxyConfiguration.groups || null)} countryCode=${proxyConfiguration.countryCode || null} isManInTheMiddle=${proxyConfiguration.isManInTheMiddle}`
        : "")
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
      `Proxy URL (redacted): ${redacted}` +
        (match
          ? ` | scheme=${match[1]} usernameLen=${match[2].length} passwordLen=${match[3].length} host=${match[4]}`
          : " | (URL did not match expected pattern)")
    );
  } else {
    log.info("proxyConfiguration.newUrl() returned falsy - no proxy will be used");
  }
} catch (err) {
  log.exception(err, "proxyConfiguration.newUrl() threw");
}

const browser = await chromium.launch({
  headless: true,
  proxy: proxyUrl ? { server: proxyUrl } : undefined,
});
const context = await browser.newContext();

if (sessionCookies) {
  const cookies = parseCookieHeader(sessionCookies, PLATFORM_DOMAINS[platform]);
  if (cookies.length) await context.addCookies(cookies);
}

const page = await context.newPage();

async function writeProfile(profile) {
  if (!budget.record("profile")) return false;
  await Actor.pushData(profile);
  return true;
}
async function writePost(post) {
  if (!budget.record("post")) return false;
  await Actor.pushData(post);
  return true;
}
async function writeComment(comment) {
  if (!budget.record("comment")) return false;
  await Actor.pushData(comment);
  return true;
}

async function handleCommentsForPost(postUrl, sourceInput) {
  if (!fetchComments) return;
  if (!budget.canWriteMore()) return;
  try {
    const comments = await mod.fetchComments({
      page,
      postUrl,
      sourceInput,
      maxComments: maxCommentsPerPost,
      topLevelOnly: topLevelCommentsOnly,
    });
    for (const c of comments) {
      if (!(await writeComment(c))) break;
    }
  } catch (err) {
    if (err instanceof RateLimitError) {
      rateLimitErrors.push(err.toRecord());
      log.warning(err.message);
    } else {
      log.exception(err, `Comment fetch failed for ${postUrl}`);
    }
  }
}

try {
  if (mode === "profile") {
    for (const username of usernames) {
      if (!budget.canWriteMore()) break;
      try {
        const { profile, posts } = await mod.lookupProfile({
          page, username, sourceInput: username, maxRecentPosts,
        });
        await writeProfile(profile);
        for (const post of posts) {
          if (!(await writePost(post))) break;
          await handleCommentsForPost(post.postUrl, username);
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          rateLimitErrors.push(err.toRecord());
          log.warning(err.message);
          break; // fail fast - don't keep hammering a platform that just rate-limited us
        }
        log.exception(err, `Profile lookup failed for ${username}`);
      }
    }
  } else if (mode === "search") {
    for (const q of searchQueries) {
      if (!budget.canWriteMore()) break;
      try {
        const results = await mod.searchPosts({
          page,
          query: q.query,
          sortOrder: q.sortOrder || "relevance",
          maxResults: q.maxResults || maxResultsPerQuery,
          dateFrom: q.dateFrom || null,
          dateTo: q.dateTo || null,
          sourceInput: q.query,
        });
        for (const post of results) {
          if (!(await writePost(post))) break;
          await handleCommentsForPost(post.postUrl, q.query);
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          rateLimitErrors.push(err.toRecord());
          log.warning(err.message);
          break;
        }
        log.exception(err, `Search failed for query "${q.query}"`);
      }
    }
  } else if (mode === "comments") {
    for (const url of postUrls) {
      if (!budget.canWriteMore()) break;
      await handleCommentsForPost(url, url);
    }
  } else {
    throw new Error(`Unknown mode "${mode}"`);
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
await Actor.setValue("OUTPUT", summary);
log.info("Run summary", summary);

await Actor.exit();
