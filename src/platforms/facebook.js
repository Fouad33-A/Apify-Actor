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
        const candidate = anchor.previousElementSibling;
        // The bio is a <span>; the heading before it ("Intro") is a <div>, so a Page without a bio yields null.
        const before = candidate && candidate.tagName === 'SPAN' ? candidate : null;
        const bioText = before ? before.innerText.trim() : '';
        bio = bioText || null;

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
        out.push({ postUrl, caption, captionTruncated: truncated, relativeTime, reactions });
    }
    return out;
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
        const lines = node.innerText
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
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
        out.push({
            author: lines[0],
            text,
            isReply: /^reply by /i.test(node.getAttribute('aria-label')),
            relativeTime: lines[timeIdx],
            likeCount: /^\d[\d,.]*\s?[KMB]?$/i.test(lines[timeIdx + 1] ?? '') ? parseAbbrev(lines[timeIdx + 1]) : null,
        });
        if (out.length >= maxComments) break;
    }
    return out;
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

        // The post page's own metadata is more complete than the truncated card on the Page.
        for (const p of rawPosts) {
            try {
                await page.goto(p.postUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
                await page.waitForTimeout(1200);
                await assertNotRateLimited(page, 'facebook', 'post');
                const ogTitle = await page.evaluate(() => {
                    const el = document.querySelector('meta[property="og:title"]');
                    return el ? el.content : null;
                });
                const og = parseFacebookOgTitle(ogTitle);
                if (og.caption) {
                    p.caption = og.caption;
                    p.captionTruncated = false;
                }
                if (og.reactions != null) p.reactions = og.reactions;
                p.viewCount = og.viewCount;
            } catch (err) {
                if (err?.name === 'RateLimitError') throw err;
                // keep what the Page card showed
            }
        }
        const posts = rawPosts.map((p) => {
            const notes = [
                'Anonymous visitors see only the latest post(s)',
                p.relativeTime ? `posted "${p.relativeTime}" (relative time; no exact date is exposed)` : null,
                p.captionTruncated ? 'caption is truncated ("See more")' : null,
                p.reactions != null ? 'likeCount is the total reactions, rounded as displayed' : null,
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
                commentCount: null, // the number is shown but its label is not, so it is not guessed
                shareCount: null,
                viewCount: p.viewCount ?? null,
                isSponsored: null,
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
        .map((c) =>
            makeCommentRow({
                platform: 'facebook',
                sourceInput,
                postUrl,
                commenterUsername: c.author,
                commentText: c.text,
                likeCount: c.likeCount,
                commentDate: null,
                isReply: c.isReply,
                statusDetail: `Commenter is the display name; commented "${c.relativeTime}" (relative time; no exact date is exposed); anonymous visitors see only some comments`,
            }),
        );
}

// Mode B (keyword search) is not built: Facebook's search results page has a different layout from a Page
// and generally needs a login.
export async function searchPosts() {
    throw new Error('Facebook Mode B (search) not yet implemented - see README pending list');
}
