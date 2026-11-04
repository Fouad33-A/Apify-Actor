// Creator-site scan: opens the creator's OWN website (the destination behind the bio link) and reads what a visitor
// sees first - title, description, headings and menu/button labels - plus any public contact e-mail. The screening
// patterns can then catch what the profile never says ("Courses", "Work with me as a coach", "My book"), and a
// contact e-mail listed on the site fills the gap left by Instagram's hidden Contact button. Public pages only:
// nothing is logged into, filled in or clicked through, and nothing is inferred.

import { looksLikeErrorPage, normalizeUrl } from './linkinbio.js';
import { extractEmails } from './schema.js';

// Hosts that are a platform or a tracker, not the creator's own site.
const NOT_OWN_SITE = [
    'instagram.com',
    'facebook.com',
    'fb.com',
    'fb.me',
    'tiktok.com',
    'youtube.com',
    'youtu.be',
    'twitter.com',
    'x.com',
    'threads.com',
    'threads.net',
    'linkedin.com',
    'pinterest.com',
    'snapchat.com',
    'spotify.com',
    'apple.com',
    'google.com',
    'amazon.com',
    'amazon.co.uk',
    'amzn.to',
    'amzn.eu',
    'bit.ly',
    'tinyurl.com',
    't.co',
    'ow.ly',
    'patreon.com',
    'calendly.com',
    'tally.so',
    'typeform.com',
    'forms.gle',
    'paypal.com',
    'paypal.me',
    'wa.me',
    'whatsapp.com',
    't.me',
    'discord.gg',
    'shopltk.com',
    'liketoknow.it',
    'sjv.io',
    'awin1.com',
    'shareasale.com',
    'rstyle.me',
    'go.magik.ly',
    'geolink.xtb.com',
    'etoro.com',
];

const hostOf = (u) => u.hostname.toLowerCase().replace(/^www\./, '');
const matchesHost = (host, list) => list.some((h) => host === h || host.endsWith(`.${h}`));

// Pure: from every link of a profile (bio links and link-in-bio destinations) choose up to `max` distinct sites
// worth reading. Platforms, trackers and link-in-bio pages are skipped; a host that contains the creator's handle
// comes first (their own domain before a sponsor's); each site is read at its home page.
export function pickSiteUrls(links, username, max = 2, isLinkInBio = () => false) {
    const handle = String(username ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    const seen = new Set();
    const sites = [];
    (links ?? []).forEach((raw, index) => {
        const u = normalizeUrl(raw);
        if (!u || !/^https?:$/.test(u.protocol)) return;
        const host = hostOf(u);
        if (!host.includes('.') || seen.has(host)) return;
        if (matchesHost(host, NOT_OWN_SITE) || isLinkInBio(u.href)) return;
        seen.add(host);
        const own = handle.length >= 4 && host.replace(/[^a-z0-9]/g, '').includes(handle);
        sites.push({ url: `${u.protocol}//${u.host}/`, rank: own ? 0 : 1, index });
    });
    return sites
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .slice(0, max)
        .map((s) => s.url);
}

const JUNK_EMAIL =
    /\.(png|jpe?g|gif|webp|svg|css|js)$|^(example|email|name|you|your|yourname|user|test|domain)@|@(example|email|domain|yourdomain|sentry|wixpress)\.|sentry/i;

// Pure: e-mail addresses written out in public page text or mailto links; image names and placeholders dropped.
export function cleanEmails(list) {
    return [...new Set((list ?? []).flatMap((t) => extractEmails(String(t).replace(/^mailto:/i, ''))))].filter(
        (e) => !JUNK_EMAIL.test(e),
    );
}

const PARKED =
    /(this |the )?domain( name)? (is |may be |might be )?(for sale|available)|buy this domain|domain (is )?parked|parked (free|domain|page)|hugedomains|sedo\.com|afternic|dan\.com\b|make an offer on this domain|sponsored listings/i;

// Pure: true when a page is a parked / for-sale domain rather than a creator's site.
export function looksParked({ title = '', text = '' } = {}) {
    return PARKED.test(title) || PARKED.test(text);
}

// Runs in the page: what a first-time visitor sees, plus contact e-mails and likely contact-page links.
export function domSiteInfo() {
    const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
    const labels = (selector, max) =>
        [...new Set([...document.querySelectorAll(selector)].map((e) => clean(e.innerText)))]
            .filter((t) => t && t.length <= 80)
            .slice(0, max);
    const meta = (name) => clean(document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.content);
    const body = document.body ? document.body.innerText : '';
    const anchors = [...document.querySelectorAll('a[href]')];
    const contactLinks = anchors
        .filter((a) => {
            try {
                const u = new URL(a.href);
                return (
                    u.origin === location.origin &&
                    /contact|work-?with|collab|partner|press|media|hire|enquir|inquir/i.test(
                        `${u.pathname} ${clean(a.innerText)}`,
                    )
                );
            } catch {
                return false;
            }
        })
        .map((a) => a.href);
    return {
        title: clean(document.title),
        description: meta('description') || meta('og:description'),
        headings: labels('h1, h2, h3', 12),
        menu: labels('nav a, header a, [role="navigation"] a, a[class*="button"], a[class*="btn"], button', 25),
        mailtos: anchors
            .filter((a) => /^mailto:/i.test(a.getAttribute('href') || ''))
            .map((a) => a.getAttribute('href')),
        bodyEmails: body.slice(0, 40_000),
        pageStart: body.slice(0, 600),
        pageLength: body.length,
        contactLinks: [...new Set(contactLinks)].slice(0, 3),
    };
}

// Pure: the compact "what this site says" text kept on the row (and matched against the site patterns).
export function siteText(info) {
    const parts = [...(info.headings ?? []), ...(info.menu ?? [])];
    return [...new Set(parts)].join(' | ').slice(0, 500);
}

async function load(page, url) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    } catch (first) {
        if (!/timeout/i.test(String(first?.message))) throw first;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    }
    await page.waitForTimeout(1200);
}

// Reads up to `max` sites. Returns { sites, emails, warnings }: sites = [{ url, title, description, text }],
// emails = public contact e-mails found, warnings = what could not be read or looks parked. One contact page per
// site is read only when the home page shows no e-mail.
export async function scanCreatorSites({ page, urls, max = 2 }) {
    const sites = [];
    const emails = [];
    const emailSources = [];
    const warnings = [];
    for (const url of (urls ?? []).slice(0, max)) {
        try {
            await load(page, url);
            const info = await page.evaluate(domSiteInfo);
            const gist = { title: info.title, text: info.pageStart, length: info.pageLength };
            if (looksLikeErrorPage(gist)) {
                warnings.push(`creator site ${url} answered with an error or bot-check page: it was NOT read`);
                continue;
            }
            if (looksParked({ title: info.title, text: info.pageStart })) {
                warnings.push(`creator site ${url} looks parked or for sale: nothing to read there`);
                continue;
            }
            let found = cleanEmails([...info.mailtos, info.bodyEmails]);
            if (!found.length && info.contactLinks.length) {
                try {
                    await load(page, info.contactLinks[0]);
                    const more = await page.evaluate(domSiteInfo);
                    found = cleanEmails([...more.mailtos, more.bodyEmails]);
                } catch {
                    // the contact page did not load: the home page result stands
                }
            }
            for (const e of found) {
                if (emails.includes(e)) continue;
                emails.push(e);
                emailSources.push({ email: e, source: 'site', url });
            }
            sites.push({
                url,
                title: info.title || null,
                description: (info.description || '').slice(0, 250) || null,
                text: siteText(info),
            });
        } catch (err) {
            warnings.push(
                `creator site ${url} could not be read: ${String(err?.message ?? err)
                    .split('\n')[0]
                    .slice(0, 120)}`,
            );
        }
    }
    return { sites, emails, emailSources, warnings };
}
