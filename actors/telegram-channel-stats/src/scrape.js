// Network part: reads one channel through Telegram's public pages, with retries and a polite delay.

import { gotScraping } from 'got-scraping';

import { channelMetrics } from './metrics.js';
import { parsePreviewPage, parseProfileCard } from './parse.js';

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

// Default page fetcher. Returns { status, url, body }. Never throws for HTTP errors; network errors are retried.
export async function fetchPage(url, { proxyUrl, timeoutMs = 30_000, retries = 2 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await gotScraping({
                url,
                proxyUrl,
                timeout: { request: timeoutMs },
                retry: { limit: 0 },
                throwHttpErrors: false,
                followRedirect: true,
                headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'], locales: ['en-US'] },
            });
            if (res.statusCode === 429 || res.statusCode >= 500) {
                lastError = new Error(`HTTP ${res.statusCode}`);
                await sleep(1500 * (attempt + 1));
                continue;
            }
            return { status: res.statusCode, url: res.url, body: res.body };
        } catch (error) {
            lastError = error;
            await sleep(1000 * (attempt + 1));
        }
    }
    return { status: 0, url, body: '', error: lastError?.message ?? 'request failed' };
}

/**
 * Reads one channel. Returns { username, status, ...channel facts, posts }.
 *
 * status: ok | not_found | preview_disabled | not_a_channel | blocked | error
 *   preview_disabled: the channel exists and shows its member count, but Telegram does not publish its posts
 *   not_a_channel: the address is a person or a bot
 * `wantMembers` filters (minMembers / maxMembers) are applied by the caller from the first page.
 */
export async function readChannel(username, options = {}) {
    const {
        fetch = fetchPage,
        maxPosts = 100,
        windowDays = 30,
        delayMs = 600,
        maxPages = 15,
        minMembers = null,
        maxMembers = null,
        freshHours = 24,
        now = Date.now(),
        fetchOptions = {},
    } = options;

    const result = { username, status: 'ok', statusDetail: null, posts: [], pagesFetched: 0 };

    const first = await fetch(`https://t.me/s/${username}`, fetchOptions);
    result.pagesFetched += 1;
    if (!first.status) return { ...result, status: 'error', statusDetail: first.error ?? 'request failed' };
    if (first.status === 429 || first.status === 403) {
        return { ...result, status: 'blocked', statusDetail: `Telegram answered HTTP ${first.status}` };
    }

    let page = first.status === 200 ? parsePreviewPage(first.body) : null;
    if (!page?.found) {
        // No preview: ask the profile card whether the address exists at all.
        const card = await fetch(`https://t.me/${username}`, fetchOptions);
        if (!card.status) return { ...result, status: 'error', statusDetail: card.error ?? 'request failed' };
        const profile = card.status === 200 ? parseProfileCard(card.body) : null;
        if (!profile || (!profile.kind && !profile.members)) {
            return {
                ...result,
                status: 'not_found',
                statusDetail: 'No public Telegram channel or group with this name',
            };
        }
        const base = { ...result, title: profile.title, description: profile.description, members: profile.members };
        if (profile.kind === 'user' || profile.kind === 'bot') {
            return {
                ...base,
                status: 'not_a_channel',
                statusDetail: `This address is a ${profile.kind}, not a channel`,
            };
        }
        return {
            ...base,
            kind: profile.kind,
            status: 'preview_disabled',
            statusDetail:
                'The channel exists but does not publish a public post preview, so posts and views cannot be read',
        };
    }

    result.title = page.title;
    result.description = page.description;
    result.verified = page.verified;
    result.members = page.members;
    result.memberLabel = page.memberLabel;
    result.counters = page.counters;
    result.kind = page.memberLabel?.startsWith('member') ? 'group' : 'channel';

    if (page.members != null) {
        if (minMembers != null && page.members < minMembers) {
            return { ...result, status: 'filtered', statusDetail: `${page.members} members is below ${minMembers}` };
        }
        if (maxMembers != null && page.members > maxMembers) {
            return { ...result, status: 'filtered', statusDetail: `${page.members} members is above ${maxMembers}` };
        }
    }

    const posts = [...page.posts];
    let exhausted = false;
    const windowStart = now - windowDays * 86_400_000;
    while (posts.length < maxPosts && result.pagesFetched < maxPages) {
        const oldestDate = Math.min(...posts.map((p) => (p.date ? Date.parse(p.date) : Infinity)));
        if (Number.isFinite(oldestDate) && oldestDate < windowStart && posts.length >= 20) break;
        // Telegram shows the "load more" link only while older posts exist.
        const before = page.nextBefore;
        if (!before || before <= 1) {
            exhausted = true;
            break;
        }
        await sleep(delayMs);
        const next = await fetch(`https://t.me/s/${username}?before=${before}`, fetchOptions);
        result.pagesFetched += 1;
        if (next.status !== 200) {
            result.statusDetail = `Older posts stopped loading (HTTP ${next.status || next.error}); the figures use the posts read so far`;
            break;
        }
        page = parsePreviewPage(next.body);
        const fresh = page.posts.filter((p) => !posts.some((q) => q.id === p.id));
        if (!fresh.length) {
            exhausted = true;
            break;
        }
        posts.push(...fresh);
    }

    const trimmed = posts.sort((a, b) => b.id - a.id).slice(0, maxPosts);
    // The preview shows the newest posts first; if we stopped because the limit was reached, older posts exist.
    result.posts = trimmed;
    result.metrics = channelMetrics(trimmed, {
        members: result.members,
        windowDays,
        freshHours,
        exhausted,
        now,
        self: username.toLowerCase(),
    });
    return result;
}
