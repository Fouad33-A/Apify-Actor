// Facebook: Mode A (Page lookup, incl. the post(s) an anonymous visitor sees) and a best-effort
// Mode C (comments visible without login). Mode B is not built.
//
// Live probes (2026-09-29, residential proxy, no login, no cookies) showed https://www.facebook.com/<Page>
// renders fully for anonymous visitors: name, follower/following links, an Intro block (bio, category,
// contact email, websites), and the latest post with a few comments. Structure (from a DOM outline of
// a real Page, language-independent selectors):
//   [role=main] > ... <h1>Page name</h1>, <a href=".../followers/"><strong>28M</strong> followers</a>,
//                     <a href=".../following/"><strong>52</strong> following</a>
//   Intro: <span>bio</span> + <ul> with a [role=button] (<span>· Category<strong>Page</strong></span>),
//          contact lines (an email as plain text) and outbound links wrapped in l.facebook.com/l.php?u=...
//   Posts: [role=article]; a time link (relative text like "1d", no machine-readable date), a caption div
//          (may end with "See more"), "All reactions:" followed by the total. Comments are nested
//          [role=article] with aria-label "Comment by <name> ..." / "Reply by <name> ...".
// Text matching is English: the browser context asks for en-US (the proxy country otherwise changes
// the language). Facebook exposes no exact post timestamps, so publishDate stays null.
//
// Anonymous visitors see only the latest post and a few comments; more needs login (not used here).

import { saveDiagnostics } from '../diagnostics.js';
import { assertNotRateLimited } from '../errors.js';
import { extractEmails, makeCommentRow, makePostRow, makeProfileRow, parseAbbrevCount } from '../schema.js';

const DOMAIN = 'www.facebook.com';
const NOT_FOUND_RE = /this (content|page) isn'?t available|page not found|the link you followed may be broken/i;

export function unwrapFacebookLink(href) {
    try {
        const u = new URL(href);
        if (u.hostname === 'l.facebook.com' && u.pathname.startsWith('/l.php')) {
            return u.searchParams.get('u') || href;
        }
    } catch {
        // not a URL: fall through
    }
    return href;
}

// Runs inside the page (serialised by page.evaluate: keep it self-contained).
export function domExtractProfile() {
    const main = document.querySelector('[role="main"]');
    if (!main) return null;
    const h1 = main.querySelector('h1');
    const pageName = h1 ? h1.innerText.trim() : '';
    if (!pageName) return null;

    const parseAbbrev = (text) => {
        if (text == null) return null;
        const m = String(text)
            .replace(/[,\s]/g, '')
            .match(/^([\d.]+)([KMB])?$/i);
        if (!m) return null;
        const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
        return Math.round(parseFloat(m[1]) * mult);
    };
    const statText = (suffix) => {
        const a = main.querySelector(`a[href$="/${suffix}/"]`);
        const strong = a ? a.querySelector('strong') : null;
        return strong ? strong.innerText.trim() : null;
    };
    const followersText = statText('followers');
    const followingText = statText('following');
    // A personal profile shows friends instead of followers: not supported, so do not guess.
    if (!followersText && !followingText) return null;

    // og:description carries the exact count ("28,729,285 followers · ..."); the visible one is rounded ("28M").
    const ogDesc = document.querySelector('meta[property="og:description"]');
    const exactMatch = ogDesc ? ogDesc.content.match(/([\d,]+)\s+followers/i) : null;
    const followerCount = exactMatch ? parseInt(exactMatch[1].replace(/,/g, ''), 10) : parseAbbrev(followersText);

    // The verified badge is an svg <title>; look only near the Page name, not in posts by other authors.
    const top = main.children[0] || main;
    const verified = [...top.querySelectorAll('svg title')].some((t) => /verified/i.test(t.textContent || ''));

    const introList = [...main.querySelectorAll('ul')].find(
        (ul) =>
            !ul.closest('footer') &&
            !ul.closest('[role="article"]') &&
            ul.querySelector('a[href*="l.facebook.com/l.php"], [role="button"] strong'),
    );

    let bio = null;
    let category = null;
    let introText = '';
    const externalLinks = [];
    if (introList) {
        introText = introList.innerText;
        // Wrapper divs can sit between the bio <span> and the list (seen live), so climb until a previous sibling exists.
        let anchor = introList;
        while (anchor.parentElement && anchor.parentElement !== main && !anchor.previousElementSibling) {
            anchor = anchor.parentElement;
        }
        // Skip elements that are not visible content (style/script/svg...) when looking for the bio.
        const notContent = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'LINK', 'META']);
        let candidate = anchor.previousElementSibling;
        while (candidate && notContent.has(candidate.tagName.toUpperCase()))
            candidate = candidate.previousElementSibling;
        // The bio may be a <span> or a wrapper <div> around one. The heading before it is "Intro", so a Page
        // with no bio (whose nearest earlier sibling is that heading) yields null.
        // Non-HTML siblings (an <svg>, <style>) have no innerText: treat them as "no bio here", never throw.
        const candidateText = candidate && typeof candidate.innerText === 'string' ? candidate.innerText.trim() : '';
        bio = candidateText && !/^intro$/i.test(candidateText) ? candidateText : null;

        const catButton = [...introList.querySelectorAll('[role="button"]')].find((b) => b.querySelector('strong'));
        if (catButton) {
            const span = catButton.querySelector('span') || catButton;
            const clone = span.cloneNode(true);
            clone.querySelectorAll('strong').forEach((n) => n.remove());
            category =
                clone.textContent
                    .replace(/^[\s·•]+/, '')
                    .replace(/\s+/g, ' ')
                    .trim() || null;
        }
        for (const a of introList.querySelectorAll('a[href*="l.facebook.com/l.php"]')) {
            externalLinks.push(a.getAttribute('href'));
        }
    }

    return {
        pageName,
        followerCount,
        followingCount: parseAbbrev(followingText),
        bio,
        category,
        verified,
        externalLinks,
        introText,
    };
}

// Runs inside the page. Top-level posts an anonymous visitor can see (not the comments nested in them).
export function domExtractPosts(maxPosts) {
    const main = document.querySelector('[role="main"]');
    if (!main || !(maxPosts > 0)) return [];

    const parseAbbrev = (text) => {
        const m = String(text ?? '')
            .replace(/[,\s]/g, '')
            .match(/^([\d.]+)([KMB])?$/i);
        if (!m) return null;
        const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
        return Math.round(parseFloat(m[1]) * mult);
    };
    const ownText = (el) =>
        [...el.childNodes]
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

    const articles = [...main.querySelectorAll('[role="article"]')].filter(
        (a) => !a.parentElement.closest('[role="article"]'),
    );
    const out = [];
    for (const article of articles) {
        if (out.length >= maxPosts) break;
        const mine = (el) => el.closest('[role="article"]') === article;

        const links = [...article.querySelectorAll('a[href]')].filter(mine);
        const postAnchor = links.find((a) =>
            /facebook\.com\/(reel|watch|photo|videos)\b|\/posts\/|\/permalink|story_fbid|\/photos?\//.test(a.href),
        );
        let postUrl = null;
        if (postAnchor) {
            const u = new URL(postAnchor.href);
            const keep = ['story_fbid', 'id', 'fbid', 'v'];
            const kept = [...u.searchParams].filter(([k]) => keep.includes(k));
            u.search = '';
            for (const [k, v] of kept) u.searchParams.set(k, v);
            u.hash = '';
            postUrl = u.href;
        }
        // Cards without a post link (events, "plans to go live", ads) are not posts.
        if (!postUrl) continue;
        const relativeTime = postAnchor
            ? postAnchor.getAttribute('aria-label') || postAnchor.innerText.trim() || null
            : null;

        const divs = [...article.querySelectorAll('div')].filter(mine);
        const label = divs.find((d) => /^all reactions:?$/i.test(ownText(d)));
        let caption = null;
        let truncated = false;
        for (const d of divs) {
            if (d === label) break;
            const t = ownText(d);
            if (t.length >= 10) {
                caption = t;
                truncated = [...d.querySelectorAll('[role="button"]')].some((b) =>
                    /^see more$/i.test(b.innerText.trim()),
                );
                if (truncated) caption = caption.replace(/\s*(…|\.\.\.)\s*$/, '');
                break;
            }
        }

        let reactions = null;
        if (label && label.parentElement) {
            const text = label.parentElement.innerText.replace(label.innerText, '').trim();
            reactions = parseAbbrev(text.split(/\s+/)[0]);
        }
        // Accounts linked from the post (tagged Pages/people, collaborators): hrefs without tracking parameters.
        const mentionedHrefs = [
            ...new Set(
                links
                    .filter((a) => a !== postAnchor && a.closest('[role="button"]') === null)
                    .map((a) => a.href.split('?')[0].split('#')[0]),
            ),
        ];
        out.push({ postUrl, caption, captionTruncated: truncated, relativeTime, reactions, mentionedHrefs });
    }
    return out;
}

// Runs inside the Page plugin's page (facebook.com/plugins/page.php?tabs=timeline, the public embed of a Page's
// timeline, visible without login). Each post carries an exact timestamp (abbr data-utime), its text, and the
// reaction / comment / share counts (seen live 2026-10-01). A count that is not shown stays null.
export function domExtractPluginPosts(maxPosts) {
    const feed = document.querySelector('[role="feed"]');
    if (!feed || !(maxPosts > 0)) return [];
    const parseAbbrev = (text) => {
        const m = String(text ?? '')
            .replace(/[,\s]/g, '')
            .match(/^([\d.]+)([KMB])?$/i);
        if (!m) return null;
        const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
        return Math.round(parseFloat(m[1]) * mult);
    };
    let blocks = [...feed.children].filter((el) => el.querySelector('abbr[data-utime]'));
    if (!blocks.length) {
        // layout variation: climb from each timestamp to the element that holds one post
        blocks = [...feed.querySelectorAll('abbr[data-utime]')].map((abbr) => {
            let el = abbr;
            while (
                el.parentElement &&
                el.parentElement !== feed &&
                el.parentElement.querySelectorAll('abbr[data-utime]').length === 1
            ) {
                el = el.parentElement;
            }
            return el;
        });
    }
    const out = [];
    for (const block of blocks) {
        if (out.length >= maxPosts) break;
        const abbr = block.querySelector('abbr[data-utime]');
        const utime = Number(abbr.getAttribute('data-utime'));
        const anchor =
            abbr.closest('a') || block.querySelector('a[href*="/posts/"], a[href*="/reel/"], a[href*="/videos/"]');
        let postUrl = null;
        if (anchor && anchor.href) {
            const u = new URL(anchor.href);
            u.search = '';
            u.hash = '';
            postUrl = u.href;
        }
        const message = block.querySelector('[data-testid="post_message"]');
        let caption = message ? message.innerText.replace(/\s+/g, ' ').trim() : null;
        const truncated = Boolean(caption && /(…|\.\.\.)?\s*See more$/i.test(caption));
        if (caption) caption = caption.replace(/\s*(…|\.\.\.)?\s*See more$/i, '').trim() || null;
        const count = (title) => {
            const el = [...block.querySelectorAll('[title]')].find((e) => e.getAttribute('title') === title);
            return el ? parseAbbrev(el.textContent) : null;
        };
        out.push({
            postUrl,
            publishDate: Number.isFinite(utime) && utime > 0 ? new Date(utime * 1000).toISOString() : null,
            caption,
            captionTruncated: truncated,
            reactions: count('Like'),
            commentCount: count('Comment'),
            shareCount: count('Share'),
        });
    }
    return out;
}

// Opens the Page plugin for a Page and returns its posts (empty when the plugin is not shown for that Page).
export async function fetchPluginPosts({ page, pageUrl, maxPosts }) {
    const href = encodeURIComponent(String(pageUrl).split('?')[0].split('#')[0]);
    const url = `https://${DOMAIN}/plugins/page.php?href=${href}&tabs=timeline&width=500&height=3000&small_header=false&adapt_container_width=true&hide_cover=true&show_facepile=false`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForSelector('[role="feed"]', { timeout: 6000 }).catch(() => {
        // no timeline in the plugin for this Page: the caller falls back to the Page itself
    });
    await assertNotRateLimited(page, 'facebook', 'plugin');
    return page.evaluate(domExtractPluginPosts, maxPosts);
}

// Runs inside the page. Comments/replies currently rendered (aria-label "Comment by X ..." / "Reply by X ...").
export function domExtractComments({ maxComments, postPathHint = null }) {
    const timeRe = /^(just now|\d+\s?(s|m|mins?|h|hrs?|d|w|y|mo)|yesterday.*|[A-Z][a-z]+ \d{1,2}(, \d{4})?.*)$/i;
    const parseAbbrev = (text) => {
        const m = String(text ?? '')
            .replace(/[,\s]/g, '')
            .match(/^([\d.]+)([KMB])?$/i);
        if (!m) return null;
        const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
        return Math.round(parseFloat(m[1]) * mult);
    };
    // When a post path is given, only look inside the top-level article that links to that post.
    const scopes = postPathHint
        ? [...document.querySelectorAll('[role="article"]')].filter(
              (a) =>
                  !a.parentElement.closest('[role="article"]') &&
                  [...a.querySelectorAll('a[href]')].some((x) => x.href.includes(postPathHint)),
          )
        : [document];
    const nodes = scopes
        .flatMap((sc) => [...sc.querySelectorAll('[role="article"][aria-label]')])
        .filter((a) => /^(comment|reply) by /i.test(a.getAttribute('aria-label')));
    const out = [];
    const seen = new Set();
    for (const node of nodes) {
        const allLines = node.innerText
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
        // Badges ("Author", "Top fan", ...) can precede the commenter's name; they are not part of it.
        const badgeRe = /^(author|top fan|top contributor|rising fan|new fan|admin|moderator)$/i;
        const lines = allLines
            .slice(0, 3)
            .filter((l) => !badgeRe.test(l))
            .concat(allLines.slice(3));
        if (lines.length < 3) continue;
        let timeIdx = -1;
        for (let i = lines.length - 1; i >= 1; i -= 1) {
            if (timeRe.test(lines[i])) {
                timeIdx = i;
                break;
            }
        }
        if (timeIdx < 2) continue;
        const text = lines.slice(1, timeIdx).join('\n');
        const key = `${lines[0]}|${text}`;
        if (!text || seen.has(key)) continue;
        seen.add(key);
        // The commenter's profile link is the anchor whose text is their name.
        const authorLink = [...node.querySelectorAll('a[href]')].find((a) => a.innerText.trim() === lines[0]);
        out.push({
            author: lines[0],
            authorHref: authorLink ? authorLink.href : null,
            text,
            isReply: /^reply by /i.test(node.getAttribute('aria-label')),
            relativeTime: lines[timeIdx],
            likeCount: /^\d[\d,.]*\s?[KMB]?$/i.test(lines[timeIdx + 1] ?? '') ? parseAbbrev(lines[timeIdx + 1]) : null,
        });
        if (out.length >= maxComments) break;
    }
    return out;
}

const NOT_A_HANDLE = new Set([
    'profile.php',
    'people',
    'groups',
    'watch',
    'photo',
    'photo.php',
    'permalink.php',
    'story.php',
    'reel',
    'share',
    'login',
    'l.php',
    'hashtag',
    'events',
    'pages',
    'marketplace',
    'gaming',
    'stories',
    'help',
    'policies',
    'business',
    'ads',
    'about',
    'privacy',
    'public',
    'sharer',
    'sharer.php',
    'plugins',
    'dialog',
]);

// A commenter's profile link -> their @handle (vanity URL) and a clean profile URL. Accounts without a vanity
// URL only have a numeric id: the handle stays null and the id is in the URL (never invented).
export function parseFacebookProfileHref(href) {
    if (!href) return { username: null, profileUrl: null };
    let url;
    try {
        url = new URL(href, 'https://www.facebook.com');
    } catch {
        return { username: null, profileUrl: null };
    }
    if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return { username: null, profileUrl: null };
    const first = url.pathname.split('/').filter(Boolean)[0] ?? null;
    if (first === 'profile.php') {
        const id = url.searchParams.get('id');
        return { username: null, profileUrl: id ? `https://www.facebook.com/profile.php?id=${id}` : null };
    }
    if (!first || !/^[A-Za-z0-9._-]+$/.test(first) || NOT_A_HANDLE.has(first.toLowerCase()))
        return { username: null, profileUrl: null };
    return { username: first, profileUrl: `https://www.facebook.com/${first}` };
}

// Reel/video pages put views, reactions and the FULL caption in og:title:
//   '193K views · 1.7K reactions | <caption> | <Page name>'
// Anything unreadable stays null.
export function parseFacebookOgTitle(title) {
    const empty = { viewCount: null, reactions: null, caption: null };
    if (!title) return empty;
    const m = title.match(/^(?:([\d.,]+\s*[KMB]?)\s+views?\s*·\s*)?([\d.,]+\s*[KMB]?)\s+reactions?\s*\|\s*/i);
    if (!m) return empty;
    const parts = title.slice(m[0].length).split(/\s+\|\s+/);
    if (parts.length > 1) parts.pop(); // trailing "| <Page name>"
    const caption = parts.join(' | ').trim();
    return { viewCount: parseAbbrevCount(m[1]), reactions: parseAbbrevCount(m[2]), caption: caption || null };
}

// A post page shows, in visible text: "<time>", "·", the FULL caption, "All reactions:", the reaction total,
// then labelled "22 comments" / "60 shares". A post without a caption has nothing between "·" and "All reactions:".
// Anything absent stays null.
export function parseFacebookPostPageText(text) {
    const empty = { caption: null, reactions: null, commentCount: null, shareCount: null };
    if (!text) return empty;
    const lines = String(text)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    const allIdx = lines.findIndex((l) => /^all reactions:?$/i.test(l));
    if (allIdx === -1) return empty;

    let dot = -1;
    for (let i = allIdx - 1; i >= 0; i -= 1) {
        if (lines[i] === '·') {
            dot = i;
            break;
        }
    }
    const caption =
        dot === -1
            ? null
            : lines
                  .slice(dot + 1, allIdx)
                  .join('\n')
                  .trim() || null;

    let commentCount = null;
    let shareCount = null;
    for (const l of lines.slice(allIdx + 1, allIdx + 6)) {
        const c = l.match(/^([\d.,]+\s*[KMB]?)\s+comments?$/i);
        const sh = l.match(/^([\d.,]+\s*[KMB]?)\s+shares?$/i);
        if (c) commentCount = parseAbbrevCount(c[1]);
        if (sh) shareCount = parseAbbrevCount(sh[1]);
    }
    return { caption, reactions: parseAbbrevCount(lines[allIdx + 1]), commentCount, shareCount };
}

export async function lookupProfile({ page, username, sourceInput, maxRecentPosts }) {
    const url = `https://${DOMAIN}/${encodeURIComponent(username)}`;
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(1500);
    await assertNotRateLimited(page, 'facebook', 'profile');

    const status = response?.status();
    // Visible text only: the raw HTML carries strings like "This content isn't available" in script bundles.
    const visible = await page.evaluate(() => (document.body ? document.body.innerText : ''));

    if (status === 404 || NOT_FOUND_RE.test(visible)) {
        return {
            profile: makeProfileRow({
                platform: 'facebook',
                sourceInput,
                username,
                status: 'not_found',
                statusDetail: `HTTP ${status ?? 'unknown'}`,
            }),
            posts: [],
        };
    }

    const dom = await page.evaluate(domExtractProfile);

    if (dom) {
        const externalLinks = [...new Set(dom.externalLinks.map(unwrapFacebookLink))];
        const profile = makeProfileRow({
            platform: 'facebook',
            sourceInput,
            username: dom.pageName || username,
            displayName: dom.pageName,
            bio: dom.bio,
            externalLinks,
            contactEmails: extractEmails(`${dom.introText}\n${dom.bio ?? ''}`),
            followerCount: dom.followerCount,
            followingCount: dom.followingCount,
            postCount: null, // Facebook Pages don't expose a total post count in this layout
            totalLikes: null, // "N followers" replaced Page like-counts in the current UI
            verified: dom.verified,
            accountCreatedDate: null,
            status: 'found',
            statusDetail: dom.category ? `Category: ${dom.category}` : null,
        });

        const rawPosts = maxRecentPosts > 0 ? await page.evaluate(domExtractPosts, maxRecentPosts) : [];

        // The Page plugin (the public embed of the timeline) lists the latest posts with exact dates and labelled
        // reaction / comment / share counts: much more than an anonymous visitor sees on the Page itself.
        if (maxRecentPosts > 0) {
            let plugin = [];
            try {
                plugin = await fetchPluginPosts({ page, pageUrl: page.url(), maxPosts: maxRecentPosts });
            } catch (err) {
                if (err?.name === 'RateLimitError') throw err;
                // the plugin did not load: fall back to what the Page itself showed (let the failed navigation settle)
                await page.waitForTimeout(500);
            }
            if (plugin.length) {
                const posts = plugin.map((p) =>
                    makePostRow({
                        platform: 'facebook',
                        sourceInput,
                        username: dom.pageName || username,
                        displayName: dom.pageName,
                        bio: dom.bio,
                        externalLinks,
                        followerCount: dom.followerCount,
                        followingCount: dom.followingCount,
                        verified: dom.verified,
                        postUrl: p.postUrl,
                        caption: p.caption,
                        publishDate: p.publishDate,
                        likeCount: p.reactions,
                        commentCount: p.commentCount,
                        shareCount: p.shareCount,
                        viewCount: null,
                        isSponsored: null,
                        statusDetail: [
                            'from the Page plugin (public embed of the timeline)',
                            p.reactions != null ? 'likeCount is the total reactions, rounded as displayed' : null,
                            p.captionTruncated ? 'caption is truncated ("See more")' : null,
                        ]
                            .filter(Boolean)
                            .join('; '),
                    }),
                );
                return { profile, posts };
            }
        }

        // The post page is more complete than the truncated card on the Page: full caption, labelled
        // comment/share counts (reels put views, reactions and the caption in og:title instead).
        for (const p of rawPosts) {
            try {
                await page.goto(p.postUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
                await page.waitForTimeout(2500);
                await assertNotRateLimited(page, 'facebook', 'post');
                const { ogTitle, text } = await page.evaluate(() => {
                    const el = document.querySelector('meta[property="og:title"]');
                    return { ogTitle: el ? el.content : null, text: document.body ? document.body.innerText : '' };
                });
                const og = parseFacebookOgTitle(ogTitle);
                const pg = parseFacebookPostPageText(text);
                const caption = og.caption ?? pg.caption;
                if (caption) {
                    p.caption = caption;
                    p.captionTruncated = false;
                }
                p.reactions = og.reactions ?? pg.reactions ?? p.reactions;
                p.viewCount = og.viewCount;
                p.commentCount = pg.commentCount;
                p.shareCount = pg.shareCount;
                p.enriched = true;
            } catch (err) {
                if (err?.name === 'RateLimitError') throw err;
                // keep what the Page card showed
            }
        }

        const ownHandle = String(username ?? '').toLowerCase();
        const posts = rawPosts.map((p) => {
            const mentionedAccounts = [
                ...new Set(
                    (p.mentionedHrefs ?? [])
                        .map((h) => parseFacebookProfileHref(h).username)
                        .filter((h) => h && h.toLowerCase() !== ownHandle)
                        .map((h) => h.toLowerCase()),
                ),
            ];
            const notes = [
                'Anonymous visitors see only the latest post(s)',
                p.relativeTime ? `posted "${p.relativeTime}" (relative time; no exact date is exposed)` : null,
                p.captionTruncated ? 'caption is truncated ("See more")' : null,
                p.reactions != null ? 'likeCount is the total reactions, rounded as displayed' : null,
                p.commentCount != null || p.shareCount != null ? 'comment/share counts are from the post page' : null,
            ].filter(Boolean);
            return makePostRow({
                platform: 'facebook',
                sourceInput,
                username: dom.pageName || username,
                displayName: dom.pageName,
                bio: dom.bio,
                externalLinks,
                followerCount: dom.followerCount,
                followingCount: dom.followingCount,
                verified: dom.verified,
                postUrl: p.postUrl,
                caption: p.caption,
                publishDate: null,
                likeCount: p.reactions,
                // On the Page card the numbers have no labels, so they are only used when the post page labels them.
                commentCount: p.commentCount ?? null,
                shareCount: p.shareCount ?? null,
                viewCount: p.viewCount ?? null,
                isSponsored: null,
                mentionedAccounts,
                statusDetail: notes.join('; '),
            });
        });

        return { profile, posts };
    }

    const html = await page.content();
    await saveDiagnostics(page, html, `profile_${username}`, { httpStatus: status });

    const looksLikeLoginWall = /name="pass"/i.test(html) && /log in/i.test(visible);

    return {
        profile: makeProfileRow({
            platform: 'facebook',
            sourceInput,
            username,
            status: looksLikeLoginWall ? 'blocked' : 'not_found',
            statusDetail: looksLikeLoginWall
                ? 'Facebook served a login wall instead of the Page (no session cookie provided, or this IP/session was challenged)'
                : 'Page loaded but no Page header (name + followers/following links) was found - may be a personal profile URL (not supported) or a layout change (see DIAG_profile record)',
        }),
        posts: [],
    };
}

// Comments an anonymous visitor can see on a post page. Facebook shows only a few without login;
// nothing is fetched beyond what is rendered, and no exact timestamps exist (relativeTime is noted in statusDetail).
export async function fetchComments({ page, postUrl, sourceInput, maxComments, topLevelOnly }) {
    const cap = Math.max(maxComments * 2, maxComments);
    let hint = null;
    try {
        hint = new URL(postUrl).pathname.replace(/\/$/, '') || null;
    } catch {
        // not a URL: no path hint
    }

    await page.goto(postUrl, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(1500);
    await assertNotRateLimited(page, 'facebook', 'comments');
    let raw = await page.evaluate(domExtractComments, { maxComments: cap });

    // Anonymous post pages (reels especially) usually render no comments, but the Page's own profile shows
    // its latest post with a few. When the source is a Page name, look there for this post's comments.
    if (raw.length === 0 && hint && sourceInput && !/^https?:/i.test(String(sourceInput))) {
        try {
            await page.goto(`https://${DOMAIN}/${encodeURIComponent(sourceInput)}`, {
                waitUntil: 'networkidle',
                timeout: 60_000,
            });
            await page.waitForTimeout(1500);
            await assertNotRateLimited(page, 'facebook', 'comments');
            raw = await page.evaluate(domExtractComments, { maxComments: cap, postPathHint: hint });
        } catch (err) {
            if (err?.name === 'RateLimitError') throw err;
            // the fallback is best-effort: no comments rather than a failed call
        }
    }

    return raw
        .filter((c) => !(topLevelOnly && c.isReply))
        .slice(0, maxComments)
        .map((c) => {
            const { username, profileUrl } = parseFacebookProfileHref(c.authorHref);
            return makeCommentRow({
                platform: 'facebook',
                sourceInput,
                postUrl,
                commenterUsername: username,
                commenterDisplayName: c.author,
                commenterProfileUrl: profileUrl,
                commentText: c.text,
                likeCount: c.likeCount,
                commentDate: null,
                isReply: c.isReply,
                statusDetail: `Commented "${c.relativeTime}" (relative time; no exact date is exposed); ${
                    username ? '' : 'commenter has no public @handle (see commenterProfileUrl / commenterDisplayName); '
                }anonymous visitors see only some comments`,
            });
        });
}

// Mode B (keyword search) is not built: Facebook's search results page has a different layout from a Page
// and generally needs a login.
export async function searchPosts() {
    throw new Error(
        'Facebook keyword search needs a logged-in session (logged-out probe 2026-09-29: the search pages return "Not Found"); this Actor does not log in. Use mode=profile with Page names instead',
    );
}
