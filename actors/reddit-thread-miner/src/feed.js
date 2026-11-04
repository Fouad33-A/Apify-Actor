// Reddit's public Atom (RSS) feeds, read without logging in. A feed holds up to 100 entries and carries title, link,
// author, date and the post text; it does not carry scores or comment counts, so those stay null. Pure parsing here.
import * as cheerio from 'cheerio';

const enc = encodeURIComponent;
const BASE = 'https://www.reddit.com';

export const subredditFeed = (sub, { after } = {}) =>
    `${BASE}/r/${enc(sub)}/new/.rss?limit=100${after ? `&after=${after}` : ''}`;
export const searchFeed = (sub, q, { after } = {}) =>
    `${BASE}/r/${enc(sub)}/search.rss?q=${enc(q)}&restrict_sr=1&sort=new&t=all&limit=100${after ? `&after=${after}` : ''}`;
export const threadFeed = (threadUrl) => `${String(threadUrl).replace(/\/?(\?.*)?$/, '/')}.rss?limit=100&sort=top`;

export function htmlToText(html) {
    const $ = cheerio.load(`<div id="r">${String(html ?? '')}</div>`);
    $('table').remove(); // the "submitted by ... [link] [comments]" footer
    $('br').replaceWith('\n');
    $('p, li, div.md > *').each((_, el) => {
        $(el).append('\n');
    });
    return $('#r')
        .text()
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\[link\]|\[comments\]/g, '')
        .trim();
}

export function parseAtom(xml) {
    const $ = cheerio.load(String(xml ?? ''), { xmlMode: true });
    const entries = [];
    $('entry').each((_, el) => {
        const e = $(el);
        const id = e.children('id').text().trim();
        const author = e
            .find('author > name')
            .first()
            .text()
            .trim()
            .replace(/^\/?u\//, '');
        entries.push({
            id,
            kind: id.startsWith('t1_') ? 'comment' : 'post',
            title: e.children('title').text().trim(),
            url: e.children('link').attr('href') ?? null,
            author: author || null,
            subreddit: e.children('category').attr('term') ?? null,
            updated: e.children('updated').text().trim() || e.children('published').text().trim() || null,
            text: htmlToText(e.children('content').text()),
        });
    });
    return entries;
}

export function classifyResponse(status, body) {
    if (status === 200 && /<feed[\s>]/.test(String(body ?? ''))) return { status: 'ok' };
    if (status === 429) return { status: 'rate_limited', detail: 'Reddit answered "too many requests"' };
    if (status === 403 || status === 401)
        return { status: 'blocked', detail: `HTTP ${status}: Reddit does not give the feed to this request` };
    if (status === 404) return { status: 'not_found', detail: 'no such subreddit or thread, or it is private' };
    if (status === 200) return { status: 'unreadable', detail: 'the answer was not an RSS feed' };
    return { status: 'http_error', detail: `HTTP ${status}` };
}
