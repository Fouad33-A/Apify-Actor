import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

import {
    exploreRequest,
    exploreUrl,
    findWidgets,
    parseTrendsJson,
    relatedFrom,
    summarise,
    widgetUrl,
} from './trends.js';

const DEFAULTS = {
    geos: [''],
    timeRange: 'today 12-m',
    category: 0,
    property: '',
    compareTogether: false,
    includeTimeline: false,
    includeRelatedQueries: true,
    language: 'en-US',
    delayBetweenRequestsMs: 2500,
    maxItems: null,
    runLabel: null,
    sinceDate: null,
};
const TIME = /^(now \d+-[Hd]|today \d+-[mdy]|all|\d{4}-\d{2}-\d{2} \d{4}-\d{2}-\d{2})$/;
const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export function readInput(raw) {
    const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)) };
    const keywords = [...new Set((input.keywords ?? []).map((k) => String(k).trim()).filter(Boolean))];
    if (!keywords.length) throw new Error('Give at least one keyword in "keywords".');
    const geos = (input.geos?.length ? input.geos : ['']).map((g) => String(g).trim().toUpperCase());
    for (const g of geos)
        if (g && !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(g))
            throw new Error(`"${g}" is not a country code such as AE, SA, GB or US.`);
    if (!TIME.test(input.timeRange))
        throw new Error(
            '"timeRange" must look like "today 12-m", "today 5-y", "now 7-d", "all" or "2025-01-01 2025-12-31".',
        );
    if (input.maxItems != null && (!Number.isInteger(input.maxItems) || input.maxItems < 1))
        throw new Error('"maxItems" must be a positive whole number.');
    if (input.sinceDate != null && (!/^\d{4}-\d{2}-\d{2}$/.test(input.sinceDate)
        || Number.isNaN(Date.parse(input.sinceDate))
        || new Date(input.sinceDate).toISOString().slice(0, 10) !== input.sinceDate))
        throw new Error('"sinceDate" must be a valid YYYY-MM-DD date.');
    return { ...input, keywords, geos, sinceMs: input.sinceDate ? Date.parse(input.sinceDate) : null };
}

// groups of keywords asked together: alone (own 0-100 scale) or up to 5 together (one shared scale)
export const groupsOf = (keywords, together) =>
    together
        ? Array.from({ length: Math.ceil(keywords.length / 5) }, (_, i) => keywords.slice(i * 5, i * 5 + 5))
        : keywords.map((k) => [k]);

export async function makeClient() {
    const jar = new CookieJar();
    const client = gotScraping.extend({
        cookieJar: jar,
        throwHttpErrors: false,
        timeout: { request: 30_000 },
        headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    await client({ url: 'https://trends.google.com/trends/' }); // the page sets its own cookie, as in a browser
    return (url) =>
        client({ url, headers: { referer: 'https://trends.google.com/trends/explore' } }).then((r) => ({
            status: r.statusCode,
            body: r.body,
        }));
}

// one request, a "too many requests" answer is waited out
async function ask(get, url, { backoffMs = 30_000, retries = 2 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
        const res = await get(url);
        if (res.status === 429 && attempt < retries) {
            await sleep(backoffMs);
            continue;
        }
        if (res.status === 429)
            return {
                error: 'rate_limited',
                detail: 'Google Trends answered "too many requests" after waiting; try again later with a longer delay',
            };
        if (res.status !== 200) return { error: 'http_error', detail: `HTTP ${res.status}` };
        try {
            return { json: parseTrendsJson(res.body) };
        } catch {
            return { error: 'unreadable', detail: 'the answer was not Trends JSON' };
        }
    }
}

export async function run({
    input,
    pushData,
    get,
    shouldStop = () => false,
    now = () => new Date(),
    backoffMs = 30_000,
}) {
    const counts = { requests: 0, rows: 0, failed: 0, noData: 0, dateExcluded: 0, suppressedRows: 0 };
    let stoppedBecause = 'completed';
    let processedJobs = 0;
    const jobs = [];
    for (const geo of input.geos)
        for (const keywords of groupsOf(input.keywords, input.compareTogether)) jobs.push({ geo, keywords });
    const base = { timeRange: input.timeRange, property: input.property || 'web', category: input.category };
    const atCap = () => input.maxItems != null && counts.rows >= input.maxItems;
    const push = async (row) => {
        if (atCap()) { counts.suppressedRows++; stoppedBecause = 'maxItems'; return false; }
        counts.rows += 1;
        if (row.status === 'no_data') counts.noData++;
        const sourceUrl = 'https://trends.google.com/trends/explore';
        await pushData({ ...row, scrapedAt: now().toISOString(), sourceUrl, runLabel: input.runLabel ?? null });
        return true;
    };
    for (const { geo, keywords } of jobs) {
        if (shouldStop() || atCap()) { stoppedBecause = shouldStop() ? 'aborted' : 'maxItems'; break; }
        processedJobs++;
        const where = geo || 'worldwide';
        const fail = async (stage, e) => {
            counts.failed += 1;
            for (const keyword of keywords)
                await push({
                    recordType: 'interest',
                    keyword,
                    geo: where,
                    ...base,
                    status: e.error,
                    statusDetail: `${stage}: ${e.detail}`,
                });
            log.warning(`${keywords.join(', ')} (${where}): ${e.error}`);
        };
        const req = exploreRequest({
            keywords,
            geo,
            time: input.timeRange,
            category: input.category,
            property: input.property,
        });
        counts.requests += 1;
        const explore = await ask(get, exploreUrl({ req, hl: input.language }), { backoffMs });
        if (explore.error) {
            await fail('explore', explore);
            continue;
        }
        const widgets = findWidgets(explore.json, keywords.length);
        if (!widgets.timeseries) {
            await fail('explore', { error: 'no_data', detail: 'Trends returned no chart for this request' });
            continue;
        }
        await sleep(input.delayBetweenRequestsMs);
        counts.requests += 1;
        const series = await ask(
            get,
            widgetUrl({ kind: 'multiline', widget: widgets.timeseries, hl: input.language }),
            { backoffMs },
        );
        if (series.error) {
            await fail('interest over time', series);
            continue;
        }
        const allTimeline = series.json?.default?.timelineData ?? [];
        const timeline = input.sinceMs == null ? allTimeline : allTimeline.filter((p) => Number(p.time) * 1000 >= input.sinceMs);
        counts.dateExcluded += allTimeline.length - timeline.length;
        for (const [i, keyword] of keywords.entries()) {
            if (atCap()) { stoppedBecause = 'maxItems'; break; }
            const s = summarise(timeline, i);
            const { points, ...summary } = s;
            await push({
                recordType: 'interest',
                keyword,
                geo: where,
                ...base,
                comparedWith: keywords.length > 1 ? keywords.filter((k) => k !== keyword) : [],
                status: s.hasData ? 'ok' : 'no_data',
                ...summary,
            });
            if (input.includeTimeline)
                for (const p of points) {
                    if (atCap()) { stoppedBecause = 'maxItems'; break; }
                    await push({
                        recordType: 'timeline',
                        keyword,
                        geo: where,
                        ...base,
                        date: p.date,
                        value: p.value,
                        isPartial: p.partial,
                        status: 'ok',
                    });
                }
            const rel = widgets.related[i];
            if (input.includeRelatedQueries && rel && !atCap()) {
                await sleep(input.delayBetweenRequestsMs);
                counts.requests += 1;
                const related = await ask(
                    get,
                    widgetUrl({ kind: 'relatedsearches', widget: rel, hl: input.language }),
                    { backoffMs },
                );
                if (related.error) log.warning(`related queries for "${keyword}" (${where}): ${related.error}`);
                else
                    for (const q of relatedFrom(related.json)) {
                        if (atCap()) { stoppedBecause = 'maxItems'; break; }
                        await push({
                            recordType: 'relatedQuery',
                            keyword,
                            geo: where,
                            ...base,
                            relatedType: q.type,
                            query: q.query,
                            value: q.value,
                            status: 'ok',
                        });
                    }
            }
        }
        await sleep(input.delayBetweenRequestsMs);
    }
    return {
        ...counts,
        searches: jobs.length,
        jobsProcessed: processedJobs,
        stoppedBecause,
        status: stoppedBecause !== 'completed' || counts.failed > 0 ? 'partial' : 'completed',
        runLabel: input.runLabel ?? null,
        sinceDate: input.sinceDate ?? null,
        note: 'Values are Google Trends\' 0-100 index (100 = the peak for that keyword and place in the period), not search counts. With "compare together" off each keyword has its own scale, so do not compare numbers between keywords.',
    };
}

async function main() {
    await Actor.init();
    let stop = false;
    Actor.on('aborting', async () => {
        stop = true;
        await sleep(1000);
        await Actor.exit();
    });
    try {
        const input = readInput(await Actor.getInput());
        const summary = await run({
            input,
            pushData: (r) => Actor.pushData(r),
            get: await makeClient(),
            shouldStop: () => stop,
        });
        await Actor.setValue('OUTPUT', summary);
        await Actor.setValue('SUMMARY', { ...summary, exactInput: input, scrapedAt: new Date().toISOString() });
        log.info(`Done: ${summary.rows} row(s), ${summary.failed} search(es) failed.`);
    } catch (error) {
        log.error(String(error?.message ?? error));
        await Actor.fail(String(error?.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
