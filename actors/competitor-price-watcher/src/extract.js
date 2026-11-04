// Reads prices out of a pricing page: JSON-LD offers first, then amounts written in the visible text. Pure functions,
// no network. A page that is rendered only by JavaScript has no prices in its HTML; it is reported as "no_price_found"
// and nothing is guessed.

import * as cheerio from 'cheerio';

const CURRENCY = { $: 'USD', US$: 'USD', USD: 'USD', '£': 'GBP', GBP: 'GBP', '€': 'EUR', EUR: 'EUR', AED: 'AED' };
const AMOUNT =
    /(US\$|[$£€]|AED|USD|GBP|EUR)\s?(\d{1,3}(?:,\d{3})+|\d{1,5})(?:\.(\d{1,2}))?(?:\s?[-–]\s?(?:[$£€]\s?)?(\d{1,3}(?:,\d{3})+|\d{1,5})(?:\.(\d{1,2}))?)?/g;
const MAX_PRICES = 60;

const clean = (t) =>
    String(t ?? '')
        .replace(/\s+/g, ' ')
        .trim();
const num = (whole, cents) => Number(`${String(whole).replace(/,/g, '')}${cents ? `.${cents}` : ''}`);

export function visibleText(html) {
    const spaced = String(html ?? '').replace(
        /<\/(p|div|li|ul|h[1-6]|span|a|td|tr|section|button|label|b|strong)>|<br\s*\/?>/gi,
        '$& ',
    );
    const $ = cheerio.load(spaced);
    $('script, style, noscript, svg, template, head').remove();
    return {
        text: clean($('body').text()),
        title: clean(
            cheerio
                .load(String(html ?? ''))('title')
                .first()
                .text(),
        ),
    };
}

function periodAfter(after) {
    const a = after.toLowerCase();
    if (/^\s*(?:\/|per|a|each)?\s*(?:month|mo\b|mth)/.test(a)) return 'month';
    if (/^\s*(?:\/|per|a|each)?\s*(?:year|yr\b|annum|yearly)/.test(a)) return 'year';
    if (/^\s*(?:\/|per|a|each)?\s*week/.test(a)) return 'week';
    if (/^\s*(?:\/|per|a|each)?\s*day/.test(a)) return 'day';
    if (/billed (?:only )?once|one[- ]time|lifetime|no auto-renewal|pay once/.test(a.slice(0, 60))) return 'once';
    if (/(?:annually|yearly|per year)/.test(a.slice(0, 40))) return 'year';
    if (/(?:monthly|per month)/.test(a.slice(0, 40))) return 'month';
    return null;
}

function unitAfter(after) {
    const a = after.toLowerCase().slice(0, 40);
    const m =
        /\b(?:per|\/|each)\s*(subject|student|user|seat|course)\b/.exec(a) ??
        /\((?:\$?\d+ )?per (subject|student|course)\)/.exec(a);
    return m ? m[1] : /\beach\b/.test(a) ? 'each' : null;
}

// the words just before an amount: a plan name or a short label, cut at the previous sentence or amount
function labelBefore(text, index, previousEnd) {
    let before = text.slice(Math.max(previousEnd, index - 90), index);
    const cut = Math.max(
        before.lastIndexOf('. '),
        before.lastIndexOf('! '),
        before.lastIndexOf('? '),
        before.lastIndexOf(' | '),
        before.lastIndexOf(' • '),
    );
    if (cut >= 0) before = before.slice(cut + 2);
    const startingAt = /\b(starting at|from|as low as|only)\s*$/i.test(before);
    before = before.replace(/\b(starting at|from|as low as|only|just|for|now|was|save)\s*$/i, '');
    // button text between two plan blocks is not part of the next plan's name
    before = before.replace(
        /^.*\b(?:buy now|get started|sign up|learn more|subscribe|start (?:free )?trial|view options|join now|add to cart)\b[\s→>:-]*/i,
        '',
    );
    const words = before.split(' ').filter(Boolean);
    return {
        label:
            words
                .slice(-6)
                .join(' ')
                .replace(/[:\-–—,]+$/, '')
                .trim() || null,
        startingAt,
    };
}

export function pricesFromText(text) {
    const out = [];
    const seen = new Set();
    let previousEnd = 0;
    for (const m of String(text ?? '').matchAll(AMOUNT)) {
        const price = num(m[2], m[3]);
        const priceMax = m[4] ? num(m[4], m[5]) : null;
        if (priceMax != null && priceMax <= price) continue;
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 80);
        const { label, startingAt } = labelBefore(text, m.index, previousEnd);
        previousEnd = m.index + m[0].length;
        const row = {
            plan: label,
            price,
            priceMax,
            currency: CURRENCY[m[1]] ?? m[1],
            period: periodAfter(after),
            unit: unitAfter(after),
            startingAt,
            source: 'text',
            context: clean(text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 40)),
        };
        const key = `${row.plan}|${row.price}|${row.priceMax}|${row.period}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
        if (out.length >= MAX_PRICES) break;
    }
    return out;
}

function* walk(node) {
    if (Array.isArray(node)) for (const n of node) yield* walk(n);
    else if (node && typeof node === 'object') {
        yield node;
        for (const v of Object.values(node)) yield* walk(v);
    }
}

export function pricesFromJsonLd(html) {
    const $ = cheerio.load(String(html ?? ''));
    const out = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        let json;
        try {
            json = JSON.parse($(el).contents().text());
        } catch {
            return;
        }
        for (const node of walk(json)) {
            const type = [node['@type']].flat().join(' ');
            if (!/Offer/.test(type)) continue;
            const low = Number(node.price ?? node.lowPrice);
            if (!Number.isFinite(low)) continue;
            const high = Number(node.highPrice);
            out.push({
                plan: clean(node.name ?? node.sku ?? '') || null,
                price: low,
                priceMax: Number.isFinite(high) && high > low ? high : null,
                currency: CURRENCY[node.priceCurrency] ?? node.priceCurrency ?? null,
                period: null,
                unit: null,
                startingAt: /AggregateOffer/.test(type),
                source: 'json-ld',
                context: clean(JSON.stringify(node)).slice(0, 200),
            });
        }
    });
    return out;
}

// What does the answer look like? Pure: used before the prices are read.
export function classifyResponse({ status, title = '', text = '' }) {
    if (status === 404 || status === 410) return { status: 'not_found', detail: `HTTP ${status}` };
    if (status === 401 || status === 403 || status === 429 || status === 503)
        return { status: 'blocked', detail: `HTTP ${status}: the site did not give the page to this request` };
    if (status >= 400) return { status: 'http_error', detail: `HTTP ${status}` };
    if (
        /just a moment|attention required|access denied|are you a robot|verify you are human/i.test(title) ||
        (text.length < 3000 && /captcha|checking your browser|unusual traffic/i.test(text))
    )
        return { status: 'blocked', detail: 'the site answered with a bot check; nothing was solved or bypassed' };
    return { status: 'ok', detail: null };
}

export function extractPage({ status, html }) {
    const { text, title } = visibleText(html);
    const verdict = classifyResponse({ status, title, text });
    if (verdict.status !== 'ok') return { ...verdict, title, prices: [] };
    const ld = pricesFromJsonLd(html);
    const fromText = pricesFromText(text);
    const known = new Set(ld.map((p) => `${p.price}|${p.currency}`));
    const prices = [...ld, ...fromText.filter((p) => !known.has(`${p.price}|${p.currency}`))].slice(0, MAX_PRICES);
    if (!prices.length)
        return {
            status: 'no_price_found',
            detail: 'the page loaded but its HTML holds no prices (it may be drawn by JavaScript, or the address is not a pricing page)',
            title,
            prices,
        };
    return { status: 'ok', detail: null, title, prices };
}
