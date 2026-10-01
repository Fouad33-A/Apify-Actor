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
import { applyScreening, extractMentions, normalizeHandle, rankCandidates } from './expand.js';
import { isLinkInBioUrl, resolveBioLinks } from './linkinbio.js';
import { computeReach } from './reach.js';
import { makeCommentRow, makePostRow, makeProfileRow } from './schema.js';
import { DEFAULT_SCORECARD, postStats, scoreRow, warnHits } from './scorecard.js';
import { pickSiteUrls, scanCreatorSites } from './sitescan.js';
import { DEFAULT_ENGINES, discoverByWebSearch, orderCandidates, parseFollowerHint } from './websearch.js';

export async function runMode({
    mode,
    mod,
    mods = {},
    serpProxyUrl = null,
    meter = () => 0,
    page,
    input,
    budget,
    pushData,
    rateLimitErrors,
    report = {},
}) {
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
        minFollowers = null,
        maxFollowers = null,
        requireContactEmail = false,
        excludeBioPatterns = [],
        excludeCategoryPatterns = [],
        onlyPassing = false,
        excludeUsernames = [],
        maxCandidates = 30,
        followLinkInBio = true,
        reachPosts = 0,
        minReachPercent = null,
        followCreatorSite = false,
        excludeSitePatterns = [],
        maxSitePages = 2,
        searchKeywords = [],
        excludeWords = [],
        discoverPlatforms = ['instagram', 'facebook', 'tiktok'],
        searchEngines = DEFAULT_ENGINES,
        maxSearchPages = 2,
        maxSearchSeconds = 600,
        maxFullLookups = 20,
        maxTiktokLookups = 6,
        searchModifiers = [],
        readTiktokPosts = false,
        scorecard = false,
        minScore = null,
        agencyEmailPatterns = DEFAULT_SCORECARD.agencyEmailPatterns,
        monetisationPatterns = DEFAULT_SCORECARD.monetisationPatterns,
        warnPatterns = [],
        maxSponsoredPosts = DEFAULT_SCORECARD.maxSponsoredPosts,
        unknownFullScorePlatforms = DEFAULT_SCORECARD.unknownFullScorePlatforms,
    } = input;
    // The score needs the latest 10 posts: sample them even when reachPosts was left at 0.
    const wantedPosts = scorecard ? Math.max(reachPosts, 10) : reachPosts;
    const scoreConfig = {
        minScore,
        agencyEmailPatterns,
        monetisationPatterns,
        warnPatterns,
        maxSponsoredPosts,
        unknownFullScorePlatforms,
    };
    const shouldContinue = () => budget.canWriteMore();
    // Where the proxy traffic goes: bytes moved by each kind of step, summed per step and platform (MB in the report).
    const traffic = {};
    async function metered(label, fn) {
        const before = meter();
        try {
            return await fn();
        } finally {
            traffic[label] = (traffic[label] ?? 0) + (meter() - before);
        }
    }
    // A platform throttle noticed inside the staged screen: the row is still written, then the run stops.
    let pendingRateLimit = null;
    const criteria = {
        minFollowers,
        maxFollowers,
        requireContactEmail,
        excludeBioPatterns,
        excludeSitePatterns,
        excludeCategoryPatterns,
        agencyEmailPatterns: scorecard ? agencyEmailPatterns : [],
        minReachPercent,
    };
    // Adds the optional screening verdict (facts vs the given criteria; null when no criteria were given).
    // The first screen has no reach numbers yet; the final one includes them.
    // deferEmail: the creator's website may still supply the e-mail, so a missing one is not judged yet.
    const screenRow = (row, { includeReach = false, deferEmail = false } = {}) => {
        const used = deferEmail ? { ...criteria, requireContactEmail: false } : criteria;
        const { passes, failures } = applyScreening(row, used, { includeReach });
        return { ...row, passesFilters: passes, filterFailures: failures };
    };
    // The staged screen, cheapest first, each costly step only for profiles that have not failed yet:
    //  1. followers / bio e-mail / bio+link text (no extra page loads)
    //  2. link-in-bio pages, so a Stan Store one click behind a Linktree is seen (only when bio patterns are set)
    //  3. the creator's own website (followCreatorSite): what it sells, and a public contact e-mail
    //  4. the reach rule: the latest posts' median likes/views vs followers (only when reachPosts > 0)
    // `handle` is the address the account is opened with (Facebook's row.username is the Page's display name).
    async function finishProfile(
        profile,
        { mod: m = mod, platformName = platform, preloadedPosts = null, handle = profile.username } = {},
    ) {
        // Where each e-mail came from (the Agent wants "e-mail found and where"). A3 judges only the bio ones.
        const sources = (profile.contactEmails ?? []).map((email) => ({ email, source: 'bio' }));
        let row = screenRow({ ...profile, contactEmailSources: sources }, { deferEmail: followCreatorSite });
        const alive = () => row.status === 'found' && row.passesFilters !== false;
        const addEmails = (found, source, url = null) => {
            const known = new Set((row.contactEmails ?? []).map((e) => e.toLowerCase()));
            const fresh = (found ?? []).filter((e) => !known.has(e.toLowerCase()));
            return {
                contactEmails: [...(row.contactEmails ?? []), ...fresh],
                contactEmailSources: [
                    ...(row.contactEmailSources ?? []),
                    ...fresh.map((email) => ({ email, source, ...(url ? { url } : {}) })),
                ],
            };
        };
        if (
            alive() &&
            followLinkInBio !== false &&
            excludeBioPatterns.length &&
            (row.externalLinks ?? []).some(isLinkInBioUrl)
        ) {
            const { targets, emails, warnings } = await metered('link-in-bio pages', () =>
                resolveBioLinks({ page, links: row.externalLinks }),
            );
            row = screenRow({
                ...row,
                ...addEmails(emails, 'link-in-bio'),
                bioLinkTargets: targets,
                screeningWarnings: [...(row.screeningWarnings ?? []), ...warnings],
            });
        }
        if (alive() && followCreatorSite) {
            const urls = pickSiteUrls(
                [...(row.externalLinks ?? []), ...(row.bioLinkTargets ?? [])],
                handle,
                maxSitePages,
                isLinkInBioUrl,
            );
            if (urls.length) {
                const { sites, emails, emailSources, warnings } = await metered('creator websites', () =>
                    scanCreatorSites({ page, urls, max: maxSitePages }),
                );
                const fromSite = addEmails(emails, 'site');
                // keep the site each e-mail was read on
                fromSite.contactEmailSources = [
                    ...(row.contactEmailSources ?? []),
                    ...fromSite.contactEmailSources
                        .slice((row.contactEmailSources ?? []).length)
                        .map((x) => ({ ...x, url: emailSources?.find((e) => e.email === x.email)?.url ?? null })),
                ];
                row = screenRow({
                    ...row,
                    creatorSites: sites,
                    siteContactEmails: emails,
                    ...fromSite,
                    screeningWarnings: [...(row.screeningWarnings ?? []), ...warnings],
                });
            } else {
                row = screenRow({
                    ...row,
                    screeningWarnings: [
                        ...(row.screeningWarnings ?? []),
                        'no website of the creator found behind the bio links: nothing to read there',
                    ],
                });
            }
        }
        let sampled = null;
        if (alive() && wantedPosts > 0) {
            const looked = preloadedPosts
                ? { posts: preloadedPosts }
                : await metered(`posts (${platformName})`, () =>
                      m.lookupProfile({
                          page,
                          username: handle,
                          sourceInput: row.sourceInput,
                          maxRecentPosts: wantedPosts,
                          shouldContinue,
                      }),
                  );
            sampled = looked.posts ?? [];
            row = {
                ...row,
                ...computeReach(sampled, row.followerCount),
                ...postStats(sampled, row.followerCount),
            };
            const failedLoads = sampled.filter((p) => /could not be loaded/.test(p.statusDetail ?? '')).length;
            if (failedLoads) {
                row.screeningWarnings = [
                    ...(row.screeningWarnings ?? []),
                    `${failedLoads} of ${sampled.length} post pages could not be loaded (timeout or block)`,
                ];
            }
            if (looked.rateLimit) pendingRateLimit = looked.rateLimit;
        }
        let done = screenRow(row, { includeReach: true });
        if (
            !scorecard &&
            row.reachPctOfFollowers == null &&
            reachPosts > 0 &&
            row.status === 'found' &&
            done.passesFilters !== false
        ) {
            done.screeningWarnings = [
                ...(done.screeningWarnings ?? []),
                'reach not computed (likes hidden by the creator, or too few posts read): check the reach by hand',
            ];
        }
        if (scorecard && done.status === 'found' && done.passesFilters !== false) {
            const scored = scoreRow(done, { platform: platformName, config: scoreConfig });
            const hits = warnHits(done, scoreConfig.warnPatterns);
            done = {
                ...done,
                scorecard: scored.scorecard,
                scoreTotal: scored.scoreTotal,
                scoreMax: scored.scoreMax,
                scoreUnknownRules: scored.scoreUnknownRules,
                scoreUnknownTreatedAsFull: scored.scoreUnknownTreatedAsFull,
                screeningWarnings: [
                    ...(done.screeningWarnings ?? []),
                    ...scored.scoreWarnings,
                    ...hits.map((w) => `"${w}" appears in the bio, links or website: check the fit by hand`),
                ],
            };
            if (scored.failures.length) {
                done.filterFailures = [...(done.filterFailures ?? []), ...scored.failures];
                done.passesFilters = false;
            }
        }
        return done;
    }
    // onlyPassing hides profiles that were read fine but do not meet the criteria. Rows that are not `found`
    // (blocked, error, ...) are still written: a failed lookup is never dropped silently.
    const hiddenByFilter = (row) => onlyPassing && row.status === 'found' && row.passesFilters === false;
    // Comments are only fetched for posts that were really read (a blocked/not-found row has no usable URL).
    const canComment = (post) => Boolean(post.postUrl) && (post.status ?? 'found') === 'found';

    async function write(recordType, row) {
        if (!budget.record(recordType)) return false;
        // pushData may report false when it did not write (spending limit reached): do not count that row.
        if ((await pushData(row)) === false) {
            budget.unrecord(recordType);
            return false;
        }
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
                const { profile, posts, rateLimit } = await mod.lookupProfile({
                    page,
                    username,
                    sourceInput: username,
                    maxRecentPosts,
                    shouldContinue,
                });
                const screened = await finishProfile(profile, { handle: username });
                if (!hiddenByFilter(screened)) await write('profile', screened);
                for (const post of posts) {
                    if (!(await write('post', post))) break;
                    if (fetchComments && canComment(post) && (await collectComments(post.postUrl, username))) return;
                }
                if (rateLimit || pendingRateLimit) {
                    // The rows above were written first; now stop, do not keep hitting a platform that throttled us.
                    const rl = rateLimit ?? pendingRateLimit;
                    rateLimitErrors.push(rl.toRecord());
                    log.warning(rl.message);
                    return;
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
                    if (fetchComments && canComment(post) && (await collectComments(post.postUrl, q.query))) return;
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
    } else if (mode === 'expand') {
        // Discovery from known-good creators (seeds): who do they mention, and who interacts with their posts?
        const seeds = usernames.map((u) => normalizeHandle(u)).filter(Boolean);
        const events = [];
        let stopped = false;
        // What happened per seed, so a run that finds nothing explains itself in OUTPUT.expand.
        const seedReports = [];
        const expandReport = { seeds: seedReports, sightings: 0, candidates: 0, lookedUp: 0, preScreened: 0 };
        Object.assign(report, { expand: expandReport });
        for (const seed of seeds) {
            if (stopped || !shouldContinue()) break;
            const sr = {
                seed,
                profileStatus: null,
                postsRead: 0,
                captionMentions: 0,
                postPagesWithComments: 0,
                commentsRead: 0,
                commenterSightings: 0,
                commentErrors: 0,
            };
            seedReports.push(sr);
            try {
                const { profile, posts, rateLimit } = await mod.lookupProfile({
                    page,
                    username: seed,
                    sourceInput: seed,
                    maxRecentPosts,
                    shouldContinue,
                });
                sr.profileStatus = profile.status;
                sr.postsRead = posts.length;
                if (profile.status !== 'found') {
                    await write('profile', {
                        ...profile,
                        statusDetail: `Seed could not be read (${profile.status}): ${profile.statusDetail ?? 'no detail'}`,
                    });
                }
                if (rateLimit) {
                    rateLimitErrors.push(rateLimit.toRecord());
                    log.warning(rateLimit.message);
                    stopped = true;
                    break;
                }
                for (const post of posts) {
                    for (const handle of [...extractMentions(post.caption), ...(post.mentionedAccounts ?? [])]) {
                        events.push({ handle, signal: 'mention', seed, postUrl: post.postUrl });
                        sr.captionMentions += 1;
                    }
                }
                for (const post of posts.filter(canComment).slice(0, maxRecentPosts)) {
                    if (!shouldContinue()) break;
                    try {
                        const comments = await mod.fetchComments({
                            page,
                            postUrl: post.postUrl,
                            sourceInput: seed,
                            maxComments: maxCommentsPerPost,
                            topLevelOnly: false,
                            shouldContinue,
                        });
                        sr.postPagesWithComments += 1;
                        for (const c of comments.filter((x) => (x.status ?? 'found') === 'found')) {
                            sr.commentsRead += 1;
                            if (c.commenterUsername) {
                                sr.commenterSightings += 1;
                                events.push({
                                    handle: c.commenterUsername,
                                    signal: 'commenter',
                                    seed,
                                    postUrl: post.postUrl,
                                });
                            }
                            for (const handle of extractMentions(c.commentText)) {
                                events.push({ handle, signal: 'mention', seed, postUrl: post.postUrl });
                            }
                        }
                    } catch (err) {
                        if (err instanceof RateLimitError) throw err;
                        sr.commentErrors += 1;
                        log.warning(`Comments for ${post.postUrl} unavailable: ${reason(err)}`);
                    }
                }
            } catch (err) {
                if (err instanceof RateLimitError) {
                    rateLimitErrors.push(err.toRecord());
                    log.warning(err.message);
                    stopped = true;
                    break;
                }
                log.exception(err, `Seed ${seed} failed`);
                await write(
                    'profile',
                    makeProfileRow({
                        platform,
                        sourceInput: seed,
                        username: seed,
                        status: 'error',
                        statusDetail: `Seed lookup failed: ${reason(err)}`,
                    }),
                );
            }
        }
        const ranked = rankCandidates(events, { seeds, exclude: excludeUsernames }).slice(0, maxCandidates);
        expandReport.sightings = events.length;
        expandReport.candidates = ranked.length;
        log.info(`Expand: ${events.length} sightings -> ${ranked.length} candidate(s) to look up`);
        for (const cand of ranked) {
            if (stopped || !shouldContinue()) break;
            expandReport.lookedUp += 1;
            try {
                // Cheap pre-screen: when a follower range was given and the light embed page already shows the
                // count outside it, the full profile (bio, links, e-mail) is not read.
                if ((minFollowers != null || maxFollowers != null) && typeof mod.quickProfile === 'function') {
                    const quick = await mod.quickProfile({
                        page,
                        username: cand.handle,
                        sourceInput: cand.seeds.join(', '),
                    });
                    const n = quick?.followerCount;
                    if (
                        quick &&
                        quick.status === 'found' &&
                        n != null &&
                        ((minFollowers != null && n < minFollowers) || (maxFollowers != null && n > maxFollowers))
                    ) {
                        expandReport.preScreened += 1;
                        const light = screenRow({
                            ...quick,
                            sourceInput: cand.seeds.join(', '),
                            discoveredFrom: cand.seeds,
                            discoverySignals: cand.signals,
                            timesSeen: cand.timesSeen,
                            discoveryExamples: cand.examples,
                            statusDetail:
                                'Follower count read from the public embed page and outside the requested range: the full profile (bio, links, e-mail) was not read',
                        });
                        if (!hiddenByFilter(light)) await write('profile', light);
                        continue;
                    }
                }
                const { profile, rateLimit } = await mod.lookupProfile({
                    page,
                    username: cand.handle,
                    sourceInput: cand.seeds.join(', '),
                    maxRecentPosts: 0,
                    shouldContinue,
                });
                const row = await finishProfile(
                    {
                        ...profile,
                        sourceInput: cand.seeds.join(', '),
                        discoveredFrom: cand.seeds,
                        discoverySignals: cand.signals,
                        timesSeen: cand.timesSeen,
                        discoveryExamples: cand.examples,
                    },
                    { handle: cand.handle },
                );
                if (!hiddenByFilter(row)) await write('profile', row);
                if (rateLimit || pendingRateLimit) {
                    const rl = rateLimit ?? pendingRateLimit;
                    rateLimitErrors.push(rl.toRecord());
                    log.warning(rl.message);
                    break;
                }
            } catch (err) {
                if (err instanceof RateLimitError) {
                    rateLimitErrors.push(err.toRecord());
                    log.warning(err.message);
                    break;
                }
                log.exception(err, `Candidate ${cand.handle} failed`);
                await write(
                    'profile',
                    makeProfileRow({
                        platform,
                        sourceInput: cand.seeds.join(', '),
                        username: cand.handle,
                        discoveredFrom: cand.seeds,
                        discoverySignals: cand.signals,
                        timesSeen: cand.timesSeen,
                        status: 'error',
                        statusDetail: `Lookup failed: ${reason(err)}`,
                    }),
                );
            }
        }
    } else if (mode === 'discover') {
        // Web-search discovery: keywords -> public search engines -> account handles on Instagram / Facebook /
        // TikTok -> every account opened and screened/scored like any other profile.
        if (!searchKeywords.length)
            throw new Error('mode "discover" needs at least one search keyword (searchKeywords)');
        const discoveryReport = {
            keywords: searchKeywords,
            excludeWords,
            platforms: discoverPlatforms,
            lookedUp: 0,
            preScreened: 0,
            blockedPlatforms: [],
            // filled in while searching, so a run that is stopped still reports what it did
            search: { queries: [], enginesBlocked: [], totalHits: 0 },
        };
        Object.assign(report, { discovery: discoveryReport });
        const found = await discoverByWebSearch({
            page,
            keywords: searchKeywords,
            excludeWords,
            platforms: discoverPlatforms,
            engines: searchEngines,
            maxPages: maxSearchPages,
            serpProxyUrl,
            maxSeconds: maxSearchSeconds,
            modifiers: searchModifiers,
            report: discoveryReport.search,
            shouldContinue,
            log: (m) => log.info(m),
        });
        const { ordered, skippedDuplicates } = orderCandidates(found.candidates, {
            exclude: excludeUsernames,
            limit: maxCandidates,
            platforms: discoverPlatforms,
            range: { min: minFollowers, max: maxFollowers },
        });
        Object.assign(discoveryReport, {
            candidatesFound: found.candidates.length,
            toLookUp: ordered.length,
            skippedDuplicates,
        });
        log.info(`Discover: ${found.candidates.length} account(s) found by web search, ${ordered.length} to look up`);
        // Two separate budgets: `maxCandidates` is how many accounts are examined at all (the cheap follower look
        // included); `maxFullLookups` is how many are opened in full (posts, links, website). Accounts ruled out by the
        // cheap look do not use up the second one, so the run's effort goes to accounts inside the range.
        let fullLookups = 0;
        let tiktokOpened = 0; // TikTok has no cheap look and its pages are the heaviest: at most maxTiktokLookups per run
        const funnel = {
            found: found.candidates.length,
            examined: 0,
            preScreenedOutOfRange: 0,
            notOpenedByHint: 0,
            openedInFull: 0,
            passedHardFilters: 0,
            failedFollowerRange: 0,
            failedWordLists: 0,
            failedScore: 0,
            failedOther: 0,
        };
        discoveryReport.funnel = funnel;
        const countFailure = (row) => {
            if (row.status !== 'found') {
                funnel.failedOther += 1;
                return;
            }
            if (row.passesFilters) {
                funnel.passedHardFilters += 1;
                return;
            }
            const first = (row.filterFailures ?? [])[0] ?? '';
            if (/^followers /.test(first)) funnel.failedFollowerRange += 1;
            else if (/^score /.test(first)) funnel.failedScore += 1;
            else if (/contains|mentions|management\/agency|category/.test(first)) funnel.failedWordLists += 1;
            else funnel.failedOther += 1;
        };
        const stoppedPlatforms = new Set();
        const stopPlatform = (platformName, rl) => {
            rateLimitErrors.push(rl.toRecord());
            log.warning(rl.message);
            stoppedPlatforms.add(platformName);
            discoveryReport.blockedPlatforms.push(platformName);
        };
        for (const cand of ordered) {
            if (!shouldContinue()) break;
            if (fullLookups >= maxFullLookups) {
                discoveryReport.stoppedBecause = `${maxFullLookups} accounts opened in full (maxFullLookups)`;
                break;
            }
            const m = mods[cand.platform];
            if (!m || stoppedPlatforms.has(cand.platform)) continue;
            discoveryReport.lookedUp += 1;
            funnel.examined += 1;
            const sightings = {
                discoveredFrom: cand.queries,
                discoverySignals: ['web-search', ...cand.engines],
                timesSeen: cand.timesSeen,
                searchSnippet: cand.snippet,
                searchFollowerHint: cand.hint,
            };
            const sourceInput = cand.queries.join(' | ');
            try {
                // TikTok has no cheap first look and its profile pages are the heaviest to load. When the search snippet
                // shows a follower figure far outside the range (more than 3x beyond either end), the profile is not
                // opened; the row says so. The figure is only a hint, so the margin is wide.
                const hintN = parseFollowerHint(cand.hint);
                if (
                    cand.platform === 'tiktok' &&
                    hintN != null &&
                    ((minFollowers != null && hintN < minFollowers / 3) ||
                        (maxFollowers != null && hintN > maxFollowers * 3))
                ) {
                    discoveryReport.skippedByHint = (discoveryReport.skippedByHint ?? 0) + 1;
                    funnel.notOpenedByHint += 1;
                    const skipped = {
                        ...makeProfileRow({
                            platform: 'tiktok',
                            sourceInput,
                            username: cand.handle,
                            status: 'not_checked',
                            statusDetail: `Not opened: the search result showed about ${cand.hint} followers, far outside the wanted range (a hint from the search result, not a measurement)`,
                            ...sightings,
                        }),
                        passesFilters: false,
                        filterFailures: [
                            `search result showed about ${cand.hint} followers, far outside the range (profile not opened)`,
                        ],
                    };
                    await write('profile', skipped);
                    continue;
                }
                // Cheap pre-screen (Instagram's public embed page shows the exact follower count): an account outside
                // the follower range is not opened in full.
                if ((minFollowers != null || maxFollowers != null) && typeof m.quickProfile === 'function') {
                    const quick = await metered(`cheap follower look (${cand.platform})`, () =>
                        m.quickProfile({ page, username: cand.handle, sourceInput }),
                    );
                    const n = quick?.followerCount;
                    if (
                        quick?.status === 'found' &&
                        n != null &&
                        ((minFollowers != null && n < minFollowers) || (maxFollowers != null && n > maxFollowers))
                    ) {
                        discoveryReport.preScreened += 1;
                        funnel.preScreenedOutOfRange += 1;
                        const light = screenRow({
                            ...quick,
                            ...sightings,
                            sourceInput,
                            statusDetail:
                                'Follower count read from the public embed page and outside the requested range: the full profile (bio, links, e-mail) was not read',
                        });
                        if (!hiddenByFilter(light)) await write('profile', light);
                        continue;
                    }
                }
                // TikTok's recent posts come with the same page load, but reading them is slow and costly (autoplaying
                // videos) and TikTok hides most post data logged out anyway: off unless readTiktokPosts is set. Without
                // them TikTok's post-based rules are unknown and take the full points (unknownFullScorePlatforms).
                if (cand.platform === 'tiktok') {
                    if (tiktokOpened >= maxTiktokLookups) {
                        discoveryReport.tiktokNotOpened = (discoveryReport.tiktokNotOpened ?? 0) + 1;
                        funnel.examined -= 1;
                        discoveryReport.lookedUp -= 1;
                        continue;
                    }
                    tiktokOpened += 1;
                }
                fullLookups += 1;
                funnel.openedInFull += 1;
                const tiktokNoPosts = cand.platform === 'tiktok' && !readTiktokPosts;
                const readNow = cand.platform === 'tiktok' && !tiktokNoPosts;
                const wantNow = readNow ? wantedPosts : 0;
                const { profile, posts, rateLimit } = await metered(`profile page (${cand.platform})`, () =>
                    m.lookupProfile({
                        page,
                        username: cand.handle,
                        sourceInput,
                        maxRecentPosts: wantNow,
                        shouldContinue,
                    }),
                );
                const row = await finishProfile(
                    { ...profile, ...sightings, sourceInput },
                    {
                        mod: m,
                        platformName: cand.platform,
                        preloadedPosts: (tiktokNoPosts && []) || (readNow ? (posts ?? []) : null),
                        handle: cand.handle,
                    },
                );
                countFailure(row);
                discoveryReport.trafficMB = Object.fromEntries(
                    Object.entries(traffic).map(([k, v]) => [k, Number((v / 1e6).toFixed(2))]),
                );
                if (!hiddenByFilter(row)) await write('profile', row);
                const rl = rateLimit ?? pendingRateLimit;
                pendingRateLimit = null;
                if (rl) stopPlatform(cand.platform, rl);
            } catch (err) {
                if (err instanceof RateLimitError) {
                    stopPlatform(cand.platform, err);
                    continue;
                }
                log.exception(err, `Candidate ${cand.platform}:${cand.handle} failed`);
                await write(
                    'profile',
                    makeProfileRow({
                        platform: cand.platform,
                        sourceInput,
                        username: cand.handle,
                        ...sightings,
                        status: 'error',
                        statusDetail: `Lookup failed: ${reason(err)}`,
                    }),
                );
            }
        }
    } else if (mode === 'posts') {
        // Post metrics for known post URLs (no profile page needed), optionally with comments.
        for (const url of postUrls) {
            if (!budget.canWriteMore()) break;
            try {
                if (typeof mod.fetchPost !== 'function') {
                    throw new Error(`Reading a single post URL is not supported for ${platform}`);
                }
                const post = await mod.fetchPost({ page, postUrl: url, sourceInput: url });
                if (!(await write('post', post))) break;
                if (fetchComments && canComment(post) && (await collectComments(url, url))) return;
            } catch (err) {
                if (err instanceof RateLimitError) {
                    rateLimitErrors.push(err.toRecord());
                    log.warning(err.message);
                    return;
                }
                log.exception(err, `Post fetch failed for ${url}`);
                await write(
                    'post',
                    makePostRow({
                        platform,
                        sourceInput: url,
                        postUrl: url,
                        status: 'error',
                        statusDetail: `Post fetch failed: ${reason(err)}`,
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
