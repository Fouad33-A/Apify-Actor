import { Actor, log } from 'apify';

import { lookupApp, readAppleReviews, searchApps } from './apple.js';
import { parseAppRef } from './apps.js';
import { lookupPlayApp, readPlayReviews, searchPlayApps } from './play.js';
import { appRow, reviewRow } from './rows.js';
import { buildClassifier } from './themes.js';

const DEFAULTS = {
    searchStores: ['apple', 'google'],
    maxAppsPerSearch: 5,
    countries: ['us'],
    language: 'en',
    maxReviewsPerApp: 200,
    maxRating: 2,
    minReviewLength: 15,
    themedOnly: false,
    includeReviews: true,
    maxReviewRows: 5000,
};

export function readInput(raw) {
    const input = { ...DEFAULTS, ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)) };
    const apps = (input.apps ?? []).filter(Boolean);
    const searchKeywords = (input.searchKeywords ?? []).filter(Boolean);
    if (!apps.length && !searchKeywords.length) {
        throw new Error(
            'Give at least one app in "apps" (App Store id/link or Google Play package/link) or one "searchKeywords".',
        );
    }
    input.countries = [
        ...new Set(
            (input.countries ?? []).map((c) => String(c).trim().toLowerCase()).filter((c) => /^[a-z]{2}$/.test(c)),
        ),
    ];
    if (!input.countries.length) throw new Error('"countries" needs at least one two-letter country code such as us.');
    for (const key of ['maxReviewsPerApp', 'maxAppsPerSearch', 'maxReviewRows']) {
        if (!Number.isInteger(input[key]) || input[key] < 1)
            throw new Error(`Input "${key}" must be a whole number of 1 or more.`);
    }
    if (!Number.isInteger(input.maxRating) || input.maxRating < 1 || input.maxRating > 5) {
        throw new Error('Input "maxRating" must be 1-5 (5 reads every rating).');
    }
    return { ...input, apps, searchKeywords };
}

// Builds the filter applied to each review before it is kept.
export function makeAccept(input, now = Date.now()) {
    const keywords = (input.keywords ?? []).map((k) => String(k).toLowerCase()).filter(Boolean);
    const since = input.recentDays ? now - input.recentDays * 86_400_000 : null;
    return (review) => {
        if (review.rating > input.maxRating) return false;
        const body = `${review.title ?? ''} ${review.text ?? ''}`.trim();
        if (body.length < input.minReviewLength) return false;
        if (since && review.date && Date.parse(review.date) < since) return false;
        if (keywords.length && !keywords.some((k) => body.toLowerCase().includes(k))) return false;
        return true;
    };
}

export async function run({ input, pushData, apple = {}, play = {}, now = Date.now(), shouldStop = () => false }) {
    const a = { lookupApp, readAppleReviews, searchApps, ...apple };
    const p = { lookupPlayApp, readPlayReviews, searchPlayApps, ...play };
    const classify = buildClassifier(input.customThemes);
    const accept = makeAccept(input, now);
    const targets = [];
    const seen = new Set();
    const problems = [];
    const add = (store, appId, country, via) => {
        const key = `${store}:${appId}:${country}`;
        if (seen.has(key)) return;
        seen.add(key);
        targets.push({ store, appId, country, via });
    };

    for (const raw of input.apps) {
        const ref = parseAppRef(raw);
        if (ref.error) {
            problems.push({ input: raw, problem: ref.error });
            await pushData({ recordType: 'app', input: raw, status: 'invalid_input', statusDetail: ref.error });
            continue;
        }
        for (const country of ref.country ? [ref.country] : input.countries) add(ref.store, ref.appId, country, null);
    }

    for (const term of input.searchKeywords) {
        try {
            if (input.searchStores.includes('apple')) {
                const { apps } = await a.searchApps(term, input.countries[0], input.maxAppsPerSearch);
                for (const app of apps) for (const country of input.countries) add('apple', app.appId, country, term);
            }
            if (input.searchStores.includes('google')) {
                const apps = await p.searchPlayApps(term, {
                    country: input.countries[0],
                    lang: input.language,
                    limit: input.maxAppsPerSearch,
                });
                for (const app of apps) for (const country of input.countries) add('google', app.appId, country, term);
            }
        } catch (error) {
            problems.push({ input: term, problem: `search failed: ${String(error?.message ?? error)}` });
        }
    }

    let reviewRows = 0;
    let appsRead = 0;
    let stoppedBecause = 'completed';
    for (const target of targets) {
        if (shouldStop()) {
            stoppedBecause = 'aborted';
            break;
        }
        if (reviewRows >= input.maxReviewRows) {
            stoppedBecause = 'maxReviewRows';
            break;
        }
        const budget = Math.min(input.maxReviewsPerApp, input.maxReviewRows - reviewRows);
        let details = null;
        let result = null;
        let status = 'ok';
        let statusDetail = null;
        try {
            if (target.store === 'apple') {
                details = (await a.lookupApp(target.appId, target.country)).app;
                if (!details) {
                    status = 'not_found';
                    statusDetail = 'Apple does not list this app in this country';
                } else {
                    result = await a.readAppleReviews(target.appId, target.country, { maxReviews: budget, accept });
                }
            } else {
                details = await p.lookupPlayApp(target.appId, { country: target.country, lang: input.language });
                const stars = input.maxRating >= 5 ? [] : Array.from({ length: input.maxRating }, (_, i) => i + 1);
                result = await p.readPlayReviews(target.appId, {
                    country: target.country,
                    lang: input.language,
                    maxReviews: budget,
                    stars,
                    accept,
                });
            }
        } catch (error) {
            const message = String(error?.message ?? error);
            status = /404|not found/i.test(message) ? 'not_found' : 'error';
            statusDetail = message;
        }

        const app = { ...target, name: details?.name };
        const kept = (result?.reviews ?? [])
            .map((review) => ({ review, hits: classify(`${review.title ?? ''} ${review.text ?? ''}`) }))
            .filter((k) => !input.themedOnly || k.hits.length);
        if (input.includeReviews) {
            for (const k of kept) {
                await pushData(reviewRow(k.review, app, k.hits));
                reviewRows += 1;
            }
        } else {
            reviewRows += kept.length;
        }
        await pushData(appRow(app, details, result, kept, { maxRating: input.maxRating, status, statusDetail }));
        appsRead += 1;
        log.info(`${target.store} ${target.appId} (${target.country}): ${status}, ${kept.length} reviews kept`);
    }

    return { appsRead, reviewRows, problems, stoppedBecause, targets: targets.length };
}

async function main() {
    await Actor.init();
    let stop = false;
    Actor.on('aborting', async () => {
        stop = true;
        await new Promise((resolve) => {
            setTimeout(resolve, 1000);
        });
        await Actor.exit();
    });
    try {
        const input = readInput(await Actor.getInput());
        const summary = await run({ input, pushData: (row) => Actor.pushData(row), shouldStop: () => stop });
        await Actor.setValue('OUTPUT', {
            ...summary,
            note: 'Apple: the public reviews feed shows the 500 most recent reviews per app and country, so complaints are taken from those. Google Play: read through the google-play-scraper library, filtered by star rating by Google Play itself. Themes are keyword matches, not a model; a review can have several.',
        });
        log.info(`Done: ${summary.appsRead} app/country pairs, ${summary.reviewRows} review rows.`);
    } catch (error) {
        log.error(String(error?.message ?? error));
        await Actor.fail(String(error?.message ?? error));
        return;
    }
    await Actor.exit();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    await main();
}
