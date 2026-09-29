// Run orchestration, split out of main.js so it can be unit-tested (main.js
// executes at import time: Actor.init, browser launch, Actor.exit).
//
// Behaviour is unchanged from the original main.js except for two fixes:
//  1. Mode C ("comments") used to do nothing unless fetchComments was also
//     true, because the shared comment helper returned early on that flag.
//     The flag only means "attach comments to Mode A/B results"; Mode C's
//     whole purpose is comments, so it now always fetches them.
//  2. A rate limit hit while fetching comments used to be logged and then the
//     loop carried on to the next post/URL, i.e. kept hammering a platform
//     that had just blocked us. It now stops the run, same as a rate limit
//     during a profile lookup or search.

import { log } from "apify";

import { RateLimitError } from "./errors.js";

export async function runMode({ mode, mod, page, input, budget, pushData, rateLimitErrors }) {
  const {
    usernames = [],
    searchQueries = [],
    postUrls = [],
    maxResultsPerQuery = 25,
    maxRecentPosts = 25,
    fetchComments = false,
    maxCommentsPerPost = 20,
    topLevelCommentsOnly = true,
  } = input;

  async function write(recordType, row) {
    if (!budget.record(recordType)) return false;
    await pushData(row);
    return true;
  }

  // Returns true if the platform rate-limited us (caller must stop the run).
  async function collectComments(postUrl, sourceInput) {
    if (!budget.canWriteMore()) return false;
    try {
      const comments = await mod.fetchComments({
        page,
        postUrl,
        sourceInput,
        maxComments: maxCommentsPerPost,
        topLevelOnly: topLevelCommentsOnly,
      });
      for (const c of comments) {
        if (!(await write("comment", c))) break;
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        rateLimitErrors.push(err.toRecord());
        log.warning(err.message);
        return true;
      }
      log.exception(err, `Comment fetch failed for ${postUrl}`);
    }
    return false;
  }

  if (mode === "profile") {
    for (const username of usernames) {
      if (!budget.canWriteMore()) break;
      try {
        const { profile, posts } = await mod.lookupProfile({
          page,
          username,
          sourceInput: username,
          maxRecentPosts,
        });
        await write("profile", profile);
        for (const post of posts) {
          if (!(await write("post", post))) break;
          if (fetchComments && (await collectComments(post.postUrl, username))) return;
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          rateLimitErrors.push(err.toRecord());
          log.warning(err.message);
          return; // fail fast - don't keep hammering a platform that just rate-limited us
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
          if (!(await write("post", post))) break;
          if (fetchComments && (await collectComments(post.postUrl, q.query))) return;
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          rateLimitErrors.push(err.toRecord());
          log.warning(err.message);
          return;
        }
        log.exception(err, `Search failed for query "${q.query}"`);
      }
    }
  } else if (mode === "comments") {
    for (const url of postUrls) {
      if (!budget.canWriteMore()) break;
      if (await collectComments(url, url)) return;
    }
  } else {
    throw new Error(`Unknown mode "${mode}"`);
  }
}
