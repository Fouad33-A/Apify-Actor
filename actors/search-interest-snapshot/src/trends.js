// Google Trends through the JSON endpoints the Trends page itself calls (no login, plain HTTP): "explore" returns a token
// per widget, "widgetdata" returns the numbers. Values are Google's 0-100 index (100 = the peak for that keyword and
// place in the chosen period), not search counts. Pure helpers live here; the requests are made in main.js.

const PREFIX = /^\)\]\}',?\s*/;

export function parseTrendsJson(body) {
    return JSON.parse(String(body ?? '').replace(PREFIX, ''));
}

export function exploreRequest({ keywords, geo, time, category = 0, property = '' }) {
    return {
        comparisonItem: keywords.map((keyword) => ({ keyword, geo: geo || '', time })),
        category,
        property,
    };
}

export const exploreUrl = ({ req, hl = 'en-US', tz = -240 }) =>
    `https://trends.google.com/trends/api/explore?hl=${hl}&tz=${tz}&req=${encodeURIComponent(JSON.stringify(req))}`;

export const widgetUrl = ({ kind, widget, hl = 'en-US', tz = -240 }) =>
    `https://trends.google.com/trends/api/widgetdata/${kind}?hl=${hl}&tz=${tz}&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${widget.token}`;

export function findWidgets(explore, count) {
    const widgets = explore?.widgets ?? [];
    return {
        timeseries: widgets.find((w) => w.id === 'TIMESERIES') ?? null,
        related: Array.from(
            { length: count },
            (_, i) =>
                widgets.find((w) => w.id === `RELATED_QUERIES_${i}`) ??
                (count === 1 ? widgets.find((w) => w.id === 'RELATED_QUERIES') : null) ??
                null,
        ),
    };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// timelineData -> one summary per keyword (index i of each point's "value" array)
export function summarise(timelineData, index) {
    const points = (timelineData ?? []).map((p) => ({
        date: new Date(Number(p.time) * 1000).toISOString().slice(0, 10),
        value: Number(p.value?.[index] ?? 0),
        partial: Boolean(p.isPartial),
    }));
    const complete = points.filter((p) => !p.partial);
    const used = complete.length >= 3 ? complete : points;
    if (!used.length || used.every((p) => p.value === 0))
        return {
            hasData: false,
            dataPoints: points.length,
            average: 0,
            latest: used.at(-1)?.value ?? null,
            peak: 0,
            peakDate: null,
            trend: null,
            trendPct: null,
            points,
        };
    const third = Math.max(1, Math.floor(used.length / 3));
    const early = mean(used.slice(0, third).map((p) => p.value));
    const late = mean(used.slice(-third).map((p) => p.value));
    const peak = used.reduce((a, b) => (b.value > a.value ? b : a));
    const trendPct = early ? round(((late - early) / early) * 100) : null;
    return {
        hasData: true,
        dataPoints: points.length,
        average: round(mean(used.map((p) => p.value))),
        latest: used.at(-1).value,
        peak: peak.value,
        peakDate: peak.date,
        earlyAverage: round(early),
        lateAverage: round(late),
        trend: trendPct == null ? null : trendPct > 15 ? 'rising' : trendPct < -15 ? 'falling' : 'flat',
        trendPct,
        points,
    };
}

// relatedsearches -> [{ type: "top" | "rising", query, value }]
export function relatedFrom(json) {
    const lists = json?.default?.rankedList ?? [];
    const out = [];
    ['top', 'rising'].forEach((type, i) => {
        for (const k of lists[i]?.rankedKeyword ?? [])
            out.push({ type, query: k.query, value: k.formattedValue ?? String(k.value) });
    });
    return out;
}
