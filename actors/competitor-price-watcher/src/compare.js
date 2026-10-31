// Change since the last run: current price rows against the rows saved for the same page.

const slug = (s) =>
    String(s ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

// A key that survives a price change: the plan wording, billing period and unit; repeated keys get a counter.
export function withKeys(rows) {
    const counts = new Map();
    return rows.map((r) => {
        const base = `${slug(r.plan)}|${r.period ?? ''}|${r.unit ?? ''}|${r.currency ?? ''}`;
        const n = (counts.get(base) ?? 0) + 1;
        counts.set(base, n);
        return { ...r, planKey: n > 1 ? `${base}#${n}` : base };
    });
}

export function compareWithPrevious(current, previous) {
    const keyed = withKeys(current);
    if (!previous?.rows?.length) {
        return {
            rows: keyed.map((r) => ({
                ...r,
                previousPrice: null,
                change: null,
                changePct: null,
                changeStatus: 'first_run',
            })),
            gone: [],
        };
    }
    const before = new Map(previous.rows.map((r) => [r.planKey, r]));
    const rows = keyed.map((r) => {
        const old = before.get(r.planKey);
        if (!old) return { ...r, previousPrice: null, change: null, changePct: null, changeStatus: 'new_plan' };
        before.delete(r.planKey);
        const change = Math.round((r.price - old.price) * 100) / 100;
        return {
            ...r,
            previousPrice: old.price,
            change,
            changePct: old.price ? Math.round((change / old.price) * 1000) / 10 : null,
            changeStatus: change > 0 ? 'increased' : change < 0 ? 'decreased' : 'unchanged',
        };
    });
    const gone = [...before.values()].map((old) => ({
        plan: old.plan,
        price: null,
        priceMax: null,
        currency: old.currency,
        period: old.period,
        unit: old.unit,
        planKey: old.planKey,
        source: 'history',
        context: null,
        previousPrice: old.price,
        change: null,
        changePct: null,
        changeStatus: 'gone',
    }));
    return { rows, gone };
}

export const snapshotOf = (rows, scrapedAt) => ({
    scrapedAt,
    rows: rows.map((r) => ({
        planKey: r.planKey,
        plan: r.plan,
        price: r.price,
        currency: r.currency,
        period: r.period,
        unit: r.unit,
    })),
});
