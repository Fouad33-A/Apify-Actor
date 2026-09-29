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

import { log } from 'apify';

import { RateLimitError } from './errors.js';
import { makeCommentRow, makePostRow, makeProfileRow } from './schema.js';

export async function runMode({ mode, mod, page, input, budget, pushData, rateLimitErrors }) {
    const platform = input.platform ?? null;
    const reason = (err) =>
        String(err?.message ?? err)
            .split('\n')[0]
            .slice(0, 300);
    const {
        usernames = [],
        searchQueries = [],
        postUrls = [],
        maxResultsPerQuery = 25,
        maxRecentPosts = 25,
        fetchComments = false,
        maxCommentsPerPost = 20,
        topLevelCommentsOnly = true,
        enrichSearchAuthors = true,
    } = input;
    const shouldContinue = () => budget.canWriteMore();

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
                shouldContinue,
            });
            for (const c of comments) {
                if (!(await write('comment', c))) break;
            }
        } catch (err) {
            if (err instanceof RateLimitError) {
                rateLimitErrors.push(err.toRecord());
                log.warning(err.message);
                return true;
            }
            log.exception(err, `Comment fetch failed for ${postUrl}`);
            await write(
                'comment',
                makeCommentRow({
                    platform,
                    sourceInput,
                    postUrl,
                    status: 'error',
                    statusDetail: `Comment fetch failed: ${reason(err)}`,
                }),
            );
        }
        return false;
    }

    if (mode === 'profile') {
        for (const username of usernames) {
            if (!budget.canWriteMore()) break;
            try {
                const { profile, posts } = await mod.lookupProfile({
                    page,
                    username,
                    sourceInput: username,
                    maxRecentPosts,
                    shouldContinue,
                });
                await write('profile', profile);
                for (const post of posts) {
                    if (!(await write('post', post))) break;
                    if (fetchComments && (await collectComments(post.postUrl, username))) return;
                }
            } catch (err) {
                if (err instanceof RateLimitError) {
                    rateLimitErrors.push(err.toRecord());
                    log.warning(err.message);
                    return; // fail fast - don't keep hammering a platform that just rate-limited us
                }
                log.exception(err, `Profile lookup failed for ${username}`);
                // Never silently drop a failed lookup: report it as a row.
                await write(
                    'profile',
                    makeProfileRow({
                        platform,
                        sourceInput: username,
                        username,
                        status: 'error',
                        statusDetail: `Lookup failed: ${reason(err)}`,
                    }),
                );
            }
        }
    } else if (mode === 'search') {
        for (const q of searchQueries) {
            if (!budget.canWriteMore()) break;
            try {
                const results = await mod.searchPosts({
                    page,
                    query: q.query,
                    sortOrder: q.sortOrder || 'relevance',
                    maxResults: q.maxResults || maxResultsPerQuery,
                    dateFrom: q.dateFrom || null,
                    dateTo: q.dateTo || null,
                    sourceInput: q.query,
                    shouldContinue,
                });
                // Platforms return either a plain list of posts or { posts, profiles } (the hit authors).
                const { posts, profiles = [] } = Array.isArray(results) ? { posts: results } : results;
                const authors = new Map();
                for (const hit of profiles) {
                    if (!budget.canWriteMore()) break;
                    let row = hit;
                    if (enrichSearchAuthors && hit.username) {
                        try {
                            const { profile } = await mod.lookupProfile({
                                page,
                                username: hit.username,
                                sourceInput: q.query,
                                maxRecentPosts: 0,
                                shouldContinue,
                            });
                            if (profile.status === 'found' || profile.status === 'private') row = profile;
                            else {
                                row = {
                                    ...hit,
                                    statusDetail: `${hit.statusDetail} Profile page lookup gave status "${profile.status}".`,
                                };
                            }
                        } catch (err) {
                            if (err instanceof RateLimitError) {
                                rateLimitErrors.push(err.toRecord());
                                log.warning(err.message);
                                return;
                            }
                            row = {
                                ...hit,
                                statusDetail: `${hit.statusDetail} Profile page lookup failed: ${reason(err)}`,
                            };
                        }
                    }
                    authors.set(hit.username, row);
                    await write('profile', row);
                }
                for (const post of posts) {
                    // Give each post its author's full profile facts when the profile page was read.
                    const a = authors.get(post.username);
                    const full = a && a.status === 'found' && !a.statusDetail?.startsWith('Taken from') ? a : null;
                    const merged = full
                        ? {
                              ...post,
                              displayName: full.displayName ?? post.displayName,
                              bio: full.bio ?? post.bio,
                              externalLinks: full.externalLinks?.length ? full.externalLinks : post.externalLinks,
                              followerCount: full.followerCount ?? post.followerCount,
                              followingCount: full.followingCount ?? post.followingCount,
                              verified: full.verified ?? post.verified,
                          }
                        : post;
                    if (!(await write('post', merged))) break;
                    if (fetchComments && (await collectComments(post.postUrl, q.query))) return;
                }
            } catch (err) {
                if (err instanceof RateLimitError) {
                    rateLimitErrors.push(err.toRecord());
                    log.warning(err.message);
                    return;
                }
                log.exception(err, `Search failed for query "${q.query}"`);
                await write(
                    'post',
                    makePostRow({
                        platform,
                        sourceInput: q.query,
                        status: 'error',
                        statusDetail: `Search failed: ${reason(err)}`,
                    }),
                );
            }
        }
    } else if (mode === 'comments') {
        for (const url of postUrls) {
            if (!budget.canWriteMore()) break;
            if (await collectComments(url, url)) return;
        }
    } else {
        throw new Error(`Unknown mode "${mode}"`);
    }
}
