// Limits how many runs of this Actor work at the same time. Parallel browser runs on the same proxy pool made
// page loads time out (seen live: a 60 s seed lookup timeout), so a new run waits its turn.
//
// Fairness without a lock: a run waits while `limit` or more OTHER runs that started before it are still
// active, so the oldest runs always go first and two runs can never wait on each other forever.

const ACTIVE = new Set(['READY', 'RUNNING']);

// runs: [{ id, status, startedAt }] (this Actor's recent runs, incl. this one). Returns { go, ahead }.
export function slotDecision({ runs, selfRunId, limit }) {
    if (!(limit > 0)) return { go: true, ahead: 0 };
    const self = runs.find((r) => r.id === selfRunId);
    const selfStart = self?.startedAt ? new Date(self.startedAt).getTime() : Infinity;
    const ahead = runs.filter(
        (r) => r.id !== selfRunId && ACTIVE.has(r.status) && new Date(r.startedAt ?? 0).getTime() <= selfStart,
    ).length;
    return { go: ahead < limit, ahead };
}

// Polls until there is a free slot. Returns { waited: boolean, gaveUp: boolean, waitedMs }.
// A failure to read the run list never blocks a run (it proceeds with a warning).
export async function waitForSlot({
    client,
    actorId,
    selfRunId,
    limit,
    maxWaitMs,
    pollMs = 10_000,
    sleep = (ms) =>
        new Promise((r) => {
            setTimeout(r, ms);
        }),
    log = () => {},
    now = Date.now,
}) {
    if (!(limit > 0) || !actorId || !selfRunId) return { waited: false, gaveUp: false, waitedMs: 0 };
    const started = now();
    let waited = false;
    for (;;) {
        let decision;
        try {
            const list = await client.actor(actorId).runs().list({ desc: true, limit: 50 });
            decision = slotDecision({ runs: list.items ?? [], selfRunId, limit });
        } catch (err) {
            log(`Could not read the run list (${err?.message}); not limiting concurrency for this run`);
            return { waited, gaveUp: false, waitedMs: now() - started };
        }
        if (decision.go) return { waited, gaveUp: false, waitedMs: now() - started };
        waited = true;
        if (now() - started >= maxWaitMs) return { waited, gaveUp: true, waitedMs: now() - started };
        log(`${decision.ahead} other run(s) of this Actor are active (limit ${limit}); waiting for a free slot`);
        await sleep(pollMs);
    }
}
