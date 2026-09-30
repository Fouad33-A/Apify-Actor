// Link-in-bio pages (linktr.ee, beacons.ai, ...): creators hide their real destinations (a Stan Store, an ebook
// shop) one click behind the link in the bio. This module follows those pages and returns the destinations so
// the bio/link screening can see them. It only reads the public page; it never logs in or clicks through.

// Hosts (and their subdomains) that only exist to list a creator's links.
const LINK_IN_BIO_HOSTS = [
    'linktr.ee',
    'beacons.ai',
    'bio.link',
    'linkin.bio',
    'lnk.bio',
    'campsite.bio',
    'carrd.co',
    'taplink.cc',
    'solo.to',
    'hoo.be',
    'link.me',
    'lit.link',
    'tap.bio',
    'linkpop.com',
    'stan.store', // a store, but its page lists the products and links: follow it too
    'komi.io',
    'withkoji.com',
    'allmylinks.com',
    'direct.me',
    'fanfix.io',
    'snipfeed.co',
    'flowcode.com',
    'msha.ke',
    'milkshake.app',
    'linktree.com',
];

export function normalizeUrl(raw) {
    if (!raw) return null;
    const text = String(raw).trim();
    try {
        return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
        return null;
    }
}

export function isLinkInBioUrl(raw) {
    const u = normalizeUrl(raw);
    if (!u) return false;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return LINK_IN_BIO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

// Pure: anchors [{ href }] found on a link-in-bio page -> distinct destination URLs on OTHER hosts, tracking
// parameters dropped. Links back to the page's own host, mailto:/tel: and fragments are not destinations.
export function destinationsFromAnchors(anchors, pageUrl, { maxLinks = 40 } = {}) {
    const page = normalizeUrl(pageUrl);
    const pageHost = page ? page.hostname.toLowerCase().replace(/^www\./, '') : null;
    const out = [];
    const seen = new Set();
    for (const a of anchors ?? []) {
        let u;
        try {
            u = new URL(a.href);
        } catch {
            continue;
        }
        if (!/^https?:$/.test(u.protocol)) continue;
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        if (host === pageHost || host.endsWith(`.${pageHost}`)) continue;
        for (const k of [...u.searchParams.keys()]) {
            if (/^(utm_|fbclid|igshid|gclid|ref$)/i.test(k)) u.searchParams.delete(k);
        }
        u.hash = '';
        const href = u.href.replace(/\/$/, '');
        if (seen.has(href)) continue;
        seen.add(href);
        out.push(href);
        if (out.length >= maxLinks) break;
    }
    return out;
}

// Runs in the page.
export function domExtractAnchors() {
    return [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href }));
}

// Runs in the page: what the page says about itself, to recognise error and bot-check pages.
export function domPageInfo() {
    const text = document.body ? document.body.innerText : '';
    return { title: document.title || '', text: text.slice(0, 600), length: text.length };
}

// An error, bot-check or "not found" page is not a link list. Its own links (e.g. Cloudflare's) must never be
// read as the creator's destinations (seen live: a Beacons page answered with a Cloudflare 5xx page).
const ERROR_PAGE = [
    /\bcloudflare\b/i,
    /\b(error\s*)?(5\d\d|4(0[0-9]|29))\b.*\b(error|forbidden|gateway|unavailable|timeout|too many)/i,
    /access denied/i,
    /just a moment/i,
    /attention required/i,
    /verify you are (a )?human/i,
    /captcha/i,
    /bad gateway|service unavailable|gateway time-?out|too many requests/i,
    /page (could not be|was not|isn't|is not) found|this page (doesn't|does not) exist|404/i,
];

export function looksLikeErrorPage({ title = '', text = '', length = text.length } = {}) {
    // Error pages are short; a real link list that happens to contain the word "404" or "captcha" is not one.
    return ERROR_PAGE.some((re) => re.test(title) || (length < 500 && re.test(text)));
}

// Follows up to maxPages link-in-bio URLs from a profile's links. Returns { targets, warnings }:
// targets are the destination URLs found; warnings say which pages could not be read (so a screening pass is
// never claimed for a link that was not actually looked at).
export async function resolveBioLinks({ page, links, maxPages = 2, maxLinks = 40, settleMs = 1500 }) {
    const pages = (links ?? []).filter(isLinkInBioUrl).slice(0, maxPages);
    const targets = [];
    const warnings = [];
    for (const link of pages) {
        const url = normalizeUrl(link).href;
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await page.waitForTimeout(settleMs);
            const info = await page.evaluate(domPageInfo);
            if (looksLikeErrorPage(info)) {
                warnings.push(
                    `link-in-bio page ${url} answered with an error or bot-check page ("${(info.title || info.text).replace(/\s+/g, ' ').slice(0, 80)}"): its links were NOT read`,
                );
                continue;
            }
            const anchors = await page.evaluate(domExtractAnchors);
            const found = destinationsFromAnchors(anchors, page.url(), { maxLinks });
            if (!found.length)
                warnings.push(`link-in-bio page ${url} showed no outgoing links (empty, blocked or not rendered)`);
            for (const t of found) if (!targets.includes(t)) targets.push(t);
        } catch (err) {
            warnings.push(
                `link-in-bio page ${url} could not be read: ${String(err?.message ?? err)
                    .split('\n')[0]
                    .slice(0, 120)}`,
            );
        }
    }
    return { targets: targets.slice(0, maxLinks), warnings };
}
