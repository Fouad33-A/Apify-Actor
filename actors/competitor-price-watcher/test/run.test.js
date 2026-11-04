import { describe, expect, it } from 'vitest';

import { competitorName, readInput, run } from '../src/main.js';

const page = (price) =>
    `<html><head><title>Plans</title></head><body><div><h2>Pro</h2><span>$${price}</span><span>/month</span></div></body></html>`;
const memory = () => {
    const m = new Map();
    return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), m };
};

describe('readInput / competitorName', () => {
    it('needs pages, accepts strings and objects, and keeps bad addresses visible', () => {
        expect(() => readInput({})).toThrow(/at least one/);
        const input = readInput({
            pages: ['https://a.com/p', { url: 'https://sat.magoosh.com/plans', name: 'Magoosh' }, 'not a url'],
        });
        expect(input.pages).toEqual([
            { url: 'https://a.com/p', name: null },
            { url: 'https://sat.magoosh.com/plans', name: 'Magoosh' },
        ]);
        expect(input.invalid).toEqual(['not a url']);
        expect(competitorName('https://www.savemyexams.com/join/', null)).toBe('savemyexams');
        expect(competitorName('https://igcse.revisionvillage.com/x', null)).toBe('revisionvillage');
    });
});

describe('run', () => {
    it('reports first_run, then the change, and keeps blocked pages out of the history', async () => {
        const history = memory();
        const rows = [];
        const pushData = async (r) => void rows.push(r);
        let price = 29;
        const fetch = async (url) => {
            if (url.includes('blocked')) return { status: 403, html: '', finalUrl: url };
            if (url.includes('js'))
                return { status: 200, html: '<html><body><div id="root"></div></body></html>', finalUrl: url };
            return { status: 200, html: page(price), finalUrl: url };
        };
        const input = readInput({
            pages: ['https://one.com/pricing', 'https://blocked.com/pricing', 'https://js.com/pricing'],
            delayBetweenPagesMs: 0,
            concurrency: 1,
        });
        const first = await run({ input, pushData, history, fetch });
        expect(first).toMatchObject({ pages: 3, ok: 1, blocked: 1, noPriceFound: 1, firstRun: 1 });
        expect(history.m.size).toBe(1);

        rows.length = 0;
        price = 35;
        const second = await run({ input, pushData, history, fetch });
        expect(second).toMatchObject({ increased: 1 });
        const priceRow = rows.find((r) => r.recordType === 'price');
        expect(priceRow).toMatchObject({
            competitor: 'one',
            plan: 'Pro',
            price: 35,
            previousPrice: 29,
            change: 6,
            changeStatus: 'increased',
            status: 'ok',
        });
        expect(
            rows
                .filter((r) => r.recordType === 'page')
                .map((r) => r.status)
                .sort(),
        ).toEqual(['blocked', 'no_price_found', 'ok']);
        expect(rows.every((r) => r.scrapedAt && r.status)).toBe(true);
    });

    it('does not replace the baseline when updateHistory is off', async () => {
        const history = memory();
        const input = readInput({ pages: ['https://one.com/p'], delayBetweenPagesMs: 0, updateHistory: false });
        await run({
            input,
            pushData: async () => {},
            history,
            fetch: async (url) => ({ status: 200, html: page(5), finalUrl: url }),
        });
        expect(history.m.size).toBe(0);
    });
});
