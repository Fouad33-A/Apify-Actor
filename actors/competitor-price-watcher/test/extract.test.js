import { describe, expect, it } from 'vitest';

import { compareWithPrevious, snapshotOf } from '../src/compare.js';
import { classifyResponse, extractPage, pricesFromJsonLd, pricesFromText } from '../src/extract.js';

// Wordings taken from the live pages (Fiveable, Revision Village, UWorld, Albert) when this Actor was built.
const FIVEABLE = 'Auto-renews yearly, cancel anytime. $79 /year or $29 /month get started → Includes everything';
const RV =
    'Explore the essentials Free $ 0 Forever No Credit Card Required Single Course Gold $ 249 / Billed only once $10.38 a month 7 day money back';
const UWORLD = 'SAT Prep Course Starting at $ 299 Buy Now SAT Question Bank Starting at $ 99 Buy Now';
const ALBERT = 'Advanced Placement® $79 per subject All AP® subjects ACT® $196 ($49 per subject) 6,400+ total';

describe('pricesFromText', () => {
    it('reads yearly and monthly prices with their period', () => {
        const rows = pricesFromText(FIVEABLE);
        expect(rows.map((r) => [r.price, r.currency, r.period])).toEqual([
            [79, 'USD', 'year'],
            [29, 'USD', 'month'],
        ]);
    });

    it('reads "$ 249 / Billed only once" as a one-off price and "Free $ 0" as zero', () => {
        const rows = pricesFromText(RV);
        const byPrice = Object.fromEntries(rows.map((r) => [r.price, r]));
        expect(byPrice[0].plan).toMatch(/Free/);
        expect(byPrice[249]).toMatchObject({ period: 'once' });
        expect(byPrice[249].plan).toMatch(/Single Course Gold/);
        expect(byPrice[10.38].period).toBe('month');
    });

    it('marks "Starting at" prices', () => {
        const rows = pricesFromText(UWORLD);
        expect(rows.map((r) => [r.plan, r.price, r.startingAt])).toEqual([
            ['SAT Prep Course', 299, true],
            ['SAT Question Bank', 99, true],
        ]);
    });

    it('reads a per-subject unit and a price range', () => {
        const rows = pricesFromText(ALBERT);
        expect(rows[0]).toMatchObject({ price: 79, unit: 'subject' });
        const range = pricesFromText('Students $ 39-79 per subject');
        expect(range[0]).toMatchObject({ price: 39, priceMax: 79, unit: 'subject' });
        expect(pricesFromText('AED 1,299 per year')[0]).toMatchObject({ price: 1299, currency: 'AED', period: 'year' });
    });
});

describe('JSON-LD offers', () => {
    it('reads Offer and AggregateOffer prices', () => {
        const html = `<script type="application/ld+json">${JSON.stringify({
            '@type': 'Product',
            offers: [
                { '@type': 'Offer', name: 'Pro', price: '19.99', priceCurrency: 'GBP' },
                { '@type': 'AggregateOffer', lowPrice: 5, highPrice: 9, priceCurrency: 'USD' },
            ],
        })}</script>`;
        expect(pricesFromJsonLd(html).map((r) => [r.plan, r.price, r.priceMax, r.currency, r.source])).toEqual([
            ['Pro', 19.99, null, 'GBP', 'json-ld'],
            [null, 5, 9, 'USD', 'json-ld'],
        ]);
    });
});

describe('extractPage', () => {
    it('reads prices from visible text only (not scripts)', () => {
        const html = `<html><head><title>Pricing</title></head><body><script>var p="$1 million"</script><div><h2>Pro</h2><span>$29</span><span>/month</span></div></body></html>`;
        const res = extractPage({ status: 200, html });
        expect(res.status).toBe('ok');
        expect(res.prices.map((p) => [p.plan, p.price, p.period])).toEqual([['Pro', 29, 'month']]);
    });

    it('says so when the page holds no prices, is missing, or shows a bot check', () => {
        expect(extractPage({ status: 200, html: '<html><body><div id="root"></div></body></html>' }).status).toBe(
            'no_price_found',
        );
        expect(extractPage({ status: 404, html: '' }).status).toBe('not_found');
        expect(extractPage({ status: 403, html: '' }).status).toBe('blocked');
        expect(
            extractPage({
                status: 200,
                html: '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>',
            }).status,
        ).toBe('blocked');
        expect(classifyResponse({ status: 500 }).status).toBe('http_error');
    });
});

describe('compareWithPrevious', () => {
    const now = [
        { plan: 'Pro', price: 29, currency: 'USD', period: 'month', unit: null },
        { plan: 'Team', price: 99, currency: 'USD', period: 'month', unit: null },
    ];
    it('marks every price first_run without history', () => {
        const { rows, gone } = compareWithPrevious(now, null);
        expect(rows.map((r) => r.changeStatus)).toEqual(['first_run', 'first_run']);
        expect(gone).toEqual([]);
    });

    it('finds increases, decreases, new and vanished plans', () => {
        const previous = snapshotOf(
            compareWithPrevious(
                [
                    { plan: 'Pro', price: 25, currency: 'USD', period: 'month', unit: null },
                    { plan: 'Team', price: 120, currency: 'USD', period: 'month', unit: null },
                    { plan: 'Old', price: 10, currency: 'USD', period: 'month', unit: null },
                ],
                null,
            ).rows,
            '2026-10-01T00:00:00.000Z',
        );
        const { rows, gone } = compareWithPrevious(
            [...now, { plan: 'Fresh', price: 5, currency: 'USD', period: 'month', unit: null }],
            previous,
        );
        const by = Object.fromEntries(rows.map((r) => [r.plan, r]));
        expect(by.Pro).toMatchObject({ changeStatus: 'increased', previousPrice: 25, change: 4, changePct: 16 });
        expect(by.Team).toMatchObject({ changeStatus: 'decreased', change: -21 });
        expect(by.Fresh.changeStatus).toBe('new_plan');
        expect(gone).toMatchObject([{ plan: 'Old', changeStatus: 'gone', previousPrice: 10 }]);
    });
});
