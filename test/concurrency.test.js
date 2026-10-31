import { describe, expect, it, vi } from 'vitest';

import { slotDecision, waitForSlot } from '../src/concurrency.js';

const run = (id, status, startedAt) => ({ id, status, startedAt });
const T = (n) => new Date(1_790_000_000_000 + n * 1000).toISOString();

describe('slotDecision', () => {
    it('goes when fewer than `limit` earlier runs are active', () => {
        const runs = [run('me', 'RUNNING', T(10)), run('a', 'RUNNING', T(5)), run('b', 'SUCCEEDED', T(1))];
        expect(slotDecision({ runs, selfRunId: 'me', limit: 2 })).toEqual({ go: true, ahead: 1 });
    });

    it('waits when `limit` earlier runs are active', () => {
        const runs = [run('me', 'RUNNING', T(10)), run('a', 'RUNNING', T(5)), run('b', 'READY', T(6))];
        expect(slotDecision({ runs, selfRunId: 'me', limit: 2 })).toEqual({ go: false, ahead: 2 });
    });

    it('later runs do not hold an earlier one back (no deadlock: the oldest always goes first)', () => {
        const runs = [run('me', 'RUNNING', T(1)), run('a', 'RUNNING', T(5)), run('b', 'RUNNING', T(6))];
        expect(slotDecision({ runs, selfRunId: 'me', limit: 1 }).go).toBe(true);
    });

    it('finished, failed and aborted runs do not count', () => {
        const runs = [
            run('me', 'RUNNING', T(10)),
            run('a', 'FAILED', T(1)),
            run('b', 'ABORTED', T(2)),
            run('c', 'TIMED-OUT', T(3)),
        ];
        expect(slotDecision({ runs, selfRunId: 'me', limit: 1 }).go).toBe(true);
    });

    it('limit 0 means no limit', () => {
        expect(slotDecision({ runs: [run('a', 'RUNNING', T(1))], selfRunId: 'me', limit: 0 }).go).toBe(true);
    });
});

describe('waitForSlot', () => {
    const clientWith = (...lists) => {
        const list = vi.fn();
        for (const l of lists) list.mockResolvedValueOnce({ items: l });
        list.mockResolvedValue({ items: lists[lists.length - 1] });
        return { client: { actor: () => ({ runs: () => ({ list }) }) }, list };
    };
    const busy = [run('me', 'RUNNING', T(10)), run('a', 'RUNNING', T(1)), run('b', 'RUNNING', T(2))];
    const free = [run('me', 'RUNNING', T(10)), run('a', 'SUCCEEDED', T(1))];

    it('returns at once when a slot is free', async () => {
        const { client } = clientWith(free);
        const r = await waitForSlot({
            client,
            actorId: 'x',
            selfRunId: 'me',
            limit: 2,
            maxWaitMs: 1000,
            sleep: async () => {},
        });
        expect(r).toMatchObject({ waited: false, gaveUp: false });
    });

    it('waits, polling, until a slot frees up', async () => {
        const { client, list } = clientWith(busy, busy, free);
        const sleep = vi.fn(async () => {});
        const r = await waitForSlot({
            client,
            actorId: 'x',
            selfRunId: 'me',
            limit: 2,
            maxWaitMs: 60_000,
            pollMs: 5,
            sleep,
            now: () => 0,
        });
        expect(r).toMatchObject({ waited: true, gaveUp: false });
        expect(list).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('gives up after maxWaitMs', async () => {
        const { client } = clientWith(busy);
        let t = 0;
        const r = await waitForSlot({
            client,
            actorId: 'x',
            selfRunId: 'me',
            limit: 2,
            maxWaitMs: 100,
            pollMs: 60,
            sleep: async () => {
                t += 60;
            },
            now: () => t,
        });
        expect(r.gaveUp).toBe(true);
    });

    it('never blocks a run because the run list could not be read', async () => {
        const client = { actor: () => ({ runs: () => ({ list: vi.fn().mockRejectedValue(new Error('api down')) }) }) };
        const log = vi.fn();
        const r = await waitForSlot({
            client,
            actorId: 'x',
            selfRunId: 'me',
            limit: 2,
            maxWaitMs: 1000,
            sleep: async () => {},
            log,
        });
        expect(r.gaveUp).toBe(false);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('api down'));
    });

    it('does nothing without a run id (local runs) or with limit 0', async () => {
        const { client, list } = clientWith(busy);
        expect((await waitForSlot({ client, actorId: 'x', selfRunId: undefined, limit: 2, maxWaitMs: 1 })).waited).toBe(
            false,
        );
        expect((await waitForSlot({ client, actorId: 'x', selfRunId: 'me', limit: 0, maxWaitMs: 1 })).waited).toBe(
            false,
        );
        expect(list).not.toHaveBeenCalled();
    });
});
