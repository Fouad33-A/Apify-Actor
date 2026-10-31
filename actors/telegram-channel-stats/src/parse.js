// Pure parsing of Telegram's public web pages (no network). Two pages are used:
//   https://t.me/s/<channel>   the public preview: channel header + the latest posts, each with its view count
//   https://t.me/<channel>     the public profile card: title, description and the member / subscriber count
// Nothing is guessed: a figure the page does not show is null.

import * as cheerio from 'cheerio';

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

// "1.2K" -> 1200, "3.4M" -> 3400000, "12 345" / "12,345" -> 12345. Anything else -> null.
export function parseCount(value) {
    if (value == null) return null;
    const text = String(value).trim(); // \s below also matches non-breaking and thin spaces
    const match = /^(\d[\d\s.,]*?)\s*([KkMmBb])?$/.exec(text);
    if (!match) return null;
    const [, digits, suffix] = match;
    if (suffix) {
        const n = Number(digits.replace(/\s/g, '').replace(',', '.'));
        if (!Number.isFinite(n)) return null;
        const factor = { k: 1e3, m: 1e6, b: 1e9 }[suffix.toLowerCase()];
        return Math.round(n * factor);
    }
    const n = Number(digits.replace(/[\s,.]/g, ''));
    return Number.isFinite(n) ? n : null;
}

// Accepts "name", "@name", "t.me/name", "https://t.me/s/name", "https://t.me/name/123".
// Returns { username } or { error: 'invite_link' | 'invalid' }.
export function normalizeChannel(input) {
    let text = String(input ?? '').trim();
    if (!text) return { error: 'invalid' };
    text = text.replace(/^https?:\/\//i, '').replace(/^(www\.)?(t|telegram)\.me\//i, '');
    if (/^(\+|joinchat\/)/i.test(text)) return { error: 'invite_link' };
    text = text.replace(/^s\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
    return USERNAME.test(text) ? { username: text } : { error: 'invalid' };
}

const clean = (s) =>
    String(s ?? '')
        .replace(/\s+/g, ' ')
        .trim();

// t.me/<name> may be a person, a bot, a group or a channel; the member line tells which.
export function parseProfileCard(html) {
    const $ = cheerio.load(html);
    const title = clean($('.tgme_page_title').first().text()) || null;
    const extra = clean($('.tgme_page_extra').first().text());
    const description = clean($('.tgme_page_description').first().text()) || null;
    const counted = /^([\d\s.,]+)\s*(subscribers?|members?)\b/i.exec(extra);
    const members = counted ? parseCount(counted[1]) : null;
    let kind = null;
    if (counted) kind = /^subscriber/i.test(counted[2]) ? 'channel' : 'group';
    else if (/monthly users?/i.test(extra)) kind = 'bot';
    else if (extra.startsWith('@')) kind = 'user';
    const online = /(\d[\d\s.,]*?)\s*online\b/i.exec(extra);
    return {
        title,
        description,
        members,
        onlineMembers: online ? parseCount(online[1]) : null,
        kind,
        hasPreviewLink: $('.tgme_page_context_link, a[href*="/s/"]').length > 0,
    };
}

const MENTION_URL =
    /(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:s\/)?(@?[A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_])/gi;
const MENTION_AT = /(?:^|[^\w@/])@([A-Za-z][A-Za-z0-9_]{3,31})(?![\w@])/g;

// Other Telegram channels or groups a text points at (t.me links and @names), lower-cased, without the author.
export function mentionedAccounts(text, links = []) {
    const found = new Set();
    for (const href of links) {
        for (const m of String(href).matchAll(MENTION_URL)) found.add(m[1].replace(/^@/, '').toLowerCase());
    }
    for (const m of String(text ?? '').matchAll(MENTION_URL)) found.add(m[1].replace(/^@/, '').toLowerCase());
    for (const m of String(text ?? '').matchAll(MENTION_AT)) found.add(m[1].toLowerCase());
    // addresses that are Telegram features, not channels
    for (const word of ['joinchat', 'addstickers', 'share', 'proxy', 'socks', 'login', 'iv']) found.delete(word);
    return [...found];
}

function parseReactions($, el) {
    const items = $(el).find('.tgme_widget_message_reactions .tgme_reaction');
    if (!items.length) return null;
    let total = 0;
    let counted = false;
    items.each((_, r) => {
        const n = parseCount(clean($(r).text()).replace(/^\D+/u, ''));
        if (n != null) {
            total += n;
            counted = true;
        }
    });
    return counted ? total : null;
}

// The public preview page. `found` is false when the page has neither a channel header nor posts
// (Telegram sends such addresses to the profile card instead).
export function parsePreviewPage(html) {
    const $ = cheerio.load(html);
    const header = $('.tgme_channel_info');
    const messages = $('.tgme_widget_message[data-post]');
    const found = header.length > 0 || messages.length > 0;

    const counters = {};
    $('.tgme_channel_info_counter').each((_, c) => {
        const type = clean($(c).find('.counter_type').text()).toLowerCase();
        const value = parseCount(clean($(c).find('.counter_value').text()));
        if (type) counters[type] = value;
    });
    const subscribers = counters.subscribers ?? counters.subscriber ?? counters.members ?? counters.member ?? null;
    const memberLabel = Object.keys(counters).find((k) => /^(subscriber|member)/.test(k)) ?? null;

    const posts = [];
    messages.each((_, el) => {
        const post = $(el);
        const [channel, idText] = String(post.attr('data-post')).split('/');
        const id = Number(idText);
        if (!Number.isInteger(id)) return;
        const textNode = post.find('.tgme_widget_message_text').first();
        const links = textNode
            .find('a[href]')
            .map((__, a) => $(a).attr('href'))
            .get();
        const text = clean(textNode.text()) || null;
        const dateEl = post.find('.tgme_widget_message_date time[datetime]').first();
        const datetime = dateEl.attr('datetime');
        const date = datetime && Number.isFinite(Date.parse(datetime)) ? new Date(datetime).toISOString() : null;
        const viewsText = clean(post.find('.tgme_widget_message_views').first().text());
        const mediaClasses = [
            ['photo', '.tgme_widget_message_photo_wrap'],
            ['video', '.tgme_widget_message_video_wrap, .tgme_widget_message_roundvideo_wrap'],
            ['document', '.tgme_widget_message_document_wrap'],
            ['voice', '.tgme_widget_message_voice'],
            ['poll', '.tgme_widget_message_poll'],
        ];
        const mediaTypes = mediaClasses.filter(([, sel]) => post.find(sel).length).map(([name]) => name);
        posts.push({
            channel,
            id,
            url: `https://t.me/${channel}/${id}`,
            date,
            text,
            views: viewsText ? parseCount(viewsText) : null,
            reactions: parseReactions($, el),
            forwarded: post.find('.tgme_widget_message_forwarded_from').length > 0,
            forwardedFrom: clean(post.find('.tgme_widget_message_forwarded_from_name').first().text()) || null,
            isReply: post.find('.tgme_widget_message_reply').length > 0,
            mediaTypes,
            mentions: mentionedAccounts(text, links),
        });
    });

    // The "load more" link of the preview asks for the posts before the oldest one shown.
    const moreHref = $('a.tme_messages_more[data-before], link[rel="prev"]').first();
    const beforeAttr = moreHref.attr('data-before');
    const fromHref = /[?&]before=(\d+)/.exec(moreHref.attr('href') ?? '');
    const nextBefore = Number(beforeAttr ?? fromHref?.[1]) || null;

    return {
        found,
        username: clean(header.find('.tgme_channel_info_header_username').first().text()).replace(/^@/, '') || null,
        title: clean(header.find('.tgme_channel_info_header_title').first().text()) || null,
        description: clean(header.find('.tgme_channel_info_description').first().text()) || null,
        verified: header.find('.verified-icon').length > 0,
        members: subscribers,
        memberLabel,
        counters,
        posts,
        nextBefore,
    };
}
