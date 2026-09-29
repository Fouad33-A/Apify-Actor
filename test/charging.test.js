import { describe, expect, it, vi } from 'vitest';

import { BudgetTracker } from '../src/budget.js';
import { chargeEventFor, DEFAULT_ITEM_EVENT, EVENT_NAMES, makeCharger } from '../src/charging.js';
import { runMode } from '../src/run.js';

vi.mock('apify', () => ({
    log: { warning: vi.fn(), exception: vi.fn(), info: vi.fn() },
}));

function fakeActor({ ppe = true, prices = { 'profile-scraped': 0.01 }, room = Infinity, limitReached = false } = {}) {
    const pushed = [];
    const manager = {
        getPricingInfo: () => ({ isPayPerEvent: ppe, perEventPrices: prices, maxTotalChargeUsd: 5 }),
        calculateMaxEventChargeCountWithinLimit: vi.fn(() => room),
        getMaxTotalChargeUsd: () => 5,
        getChargedEventCount: (name) => pushed.filter((p) => p.event === name).length,
    };
    return {
        pushed,
        actor: {
            getChargingManager: () => manager,
            pushData: vi.fn(async (row, event) => {
                pushed.push({ row, event });
                return { eventChargeLimitReached: limitReached };
            }),
        },
        manager,
    };
}

describe('chargeEventFor', () => {
    it.each([
        [{ recordType: 'profile', status: 'found' }, EVENT_NAMES.profile],
        [{ recordType: 'profile', status: 'private' }, EVENT_NAMES.profile],
        [{ recordType: 'post', status: 'found' }, EVENT_NAMES.post],
        [{ recordType: 'comment', status: 'found' }, EVENT_NAMES.comment],
        [{ recordType: 'profile', status: 'not_found' }, null],
        [{ recordType: 'profile', status: 'blocked' }, null],
        [{ recordType: 'post', status: 'error' }, null],
        [{ recordType: 'post', status: 'private' }, null],
        [{ recordType: 'comment', status: 'blocked' }, null],
        [{ recordType: 'other', status: 'found' }, null],
        [null, null],
    ])('%j -> %s', (row, expected) => {
        expect(chargeEventFor(row)).toBe(expected);
    });
});

describe('makeCharger', () => {
    it('charges found rows under their event and writes failed rows free of charge', async () => {
        const { actor, pushed } = fakeActor();
        const c = makeCharger({ actor, budget: new BudgetTracker(10) });
        await c.push({ recordType: 'profile', status: 'found' });
        await c.push({ recordType: 'profile', status: 'blocked' });
        await c.push({ recordType: 'post', status: 'found' });
        await c.push({ recordType: 'comment', status: 'error' });
        expect(pushed.map((p) => p.event)).toEqual(['profile-scraped', undefined, 'post-scraped', undefined]);
        expect(c.summary().chargedEvents).toEqual({ 'profile-scraped': 1, 'post-scraped': 1, 'comment-scraped': 0 });
    });

    it('a non pay-per-event run (private use, local) never charges', async () => {
        const { actor, pushed } = fakeActor({ ppe: false });
        const c = makeCharger({ actor, budget: new BudgetTracker(10) });
        expect(c.isPayPerEvent).toBe(false);
        await c.push({ recordType: 'profile', status: 'found' });
        expect(pushed[0].event).toBeUndefined();
        expect(c.summary()).toMatchObject({ isPayPerEvent: false, chargedEvents: null, maxTotalChargeUsd: null });
    });

    it('stops the run and writes nothing more once the user spending limit is used up', async () => {
        const { actor, pushed } = fakeActor({ room: 0 });
        const budget = new BudgetTracker(10);
        const c = makeCharger({ actor, budget });
        expect(await c.push({ recordType: 'post', status: 'found' })).toBe(false);
        expect(pushed).toEqual([]);
        expect(budget.summary().stopReason).toBe('max_total_charge_usd');
    });

    it('stops the run when the charge that was just made reached the limit (the row is still written)', async () => {
        const { actor, pushed } = fakeActor({ limitReached: true });
        const budget = new BudgetTracker(10);
        const c = makeCharger({ actor, budget });
        expect(await c.push({ recordType: 'post', status: 'found' })).toBe(true);
        expect(pushed).toHaveLength(1);
        expect(budget.canWriteMore()).toBe(false);
    });

    it('warns when the synthetic per-dataset-item event is still enabled (it would double-charge and bill blocked rows)', () => {
        const warn = vi.fn();
        const { actor } = fakeActor({ prices: { [DEFAULT_ITEM_EVENT]: 0.001, 'profile-scraped': 0.01 } });
        const c = makeCharger({ actor, budget: new BudgetTracker(1), warn });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(DEFAULT_ITEM_EVENT));
        expect(c.summary().warning).toMatch(/remove it/);
    });

    it('no warning when only the per-result events are defined', () => {
        const warn = vi.fn();
        const { actor } = fakeActor();
        expect(makeCharger({ actor, budget: new BudgetTracker(1), warn }).summary().warning).toBeNull();
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('runMode with the charger', () => {
    it('a row refused because the spending limit is used up is not counted and ends the run', async () => {
        const { actor, pushed, manager } = fakeActor();
        // room for exactly one charged event
        manager.calculateMaxEventChargeCountWithinLimit.mockReturnValueOnce(1).mockReturnValue(0);
        const budget = new BudgetTracker(10);
        const c = makeCharger({ actor, budget });
        const mod = {
            lookupProfile: vi.fn(async ({ username }) => ({
                profile: { recordType: 'profile', status: 'found', username },
                posts: [],
            })),
        };
        await runMode({
            mode: 'profile',
            mod,
            page: {},
            input: { usernames: ['a', 'b', 'c'] },
            budget,
            pushData: (row) => c.push(row),
            rateLimitErrors: [],
        });
        expect(pushed).toHaveLength(1);
        expect(budget.counts.profiles).toBe(1);
        expect(mod.lookupProfile).toHaveBeenCalledTimes(2); // 'c' is never looked up
        expect(budget.summary().stopReason).toBe('max_total_charge_usd');
    });
});
