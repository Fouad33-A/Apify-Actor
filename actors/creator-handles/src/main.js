import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const target = Math.min(100, Math.max(1, Number(input.targetCount) || 100));
const minFollowers = Number(input.minFollowers ?? 10000);
const maxFollowers = Number(input.maxFollowers ?? 150000);
const days = Number(input.activeWithinDays ?? 7);
const maxCandidates = Math.min(3000, Math.max(10, Number(input.maxCandidates) || 600));
const keywords = Array.isArray(input.keywords) && input.keywords.length ? input.keywords : ['fitness','beauty','food','travel','education','fashion','gaming','technology','lifestyle','art','sports','music'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jar = new CookieJar();
const client = gotScraping.extend({ cookieJar: jar, timeout: { request: 25000 }, retry: { limit: 1 }, throwHttpErrors: false, headers: { 'accept-language': 'en-US,en;q=0.9' } });
const seen = new Set();
const results = [];
const diagnostics = { searchQueries: 0, searchErrors: 0, searchEmpty: 0, searchBlocked: 0, profilesChecked: 0, profileErrors: 0, missingData: 0, outOfRange: 0, inactive: 0 };
const validHandle = s => /^[a-zA-Z0-9._]{2,24}$/.test(s) && !s.includes('..') && !s.startsWith('.') && !s.endsWith('.');
const getHandle = href => {
    try {
        const u = new URL(href);
        if (!/(^|\\.)tiktok\\.com$/i.test(u.hostname)) return null;
        const h = decodeURIComponent(u.pathname.split('/').find(x => x.startsWith('@'))?.slice(1) ?? '');
        return validHandle(h) ? h.toLowerCase() : null;
    } catch { return null; }
};
async function request(url) {
    const response = await client({ url, responseType: 'text', headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
    if (response.statusCode !== 200) throw new Error('HTTP ' + response.statusCode);
    return response.body;
}
async function discover(keyword, page) {
    const query = 'site:tiktok.com/@ ' + keyword + ' TikTok';
    const urls = [
        'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&first=' + (page * 10 + 1),
        'https://www.google.com/search?q=' + encodeURIComponent(query) + '&start=' + (page * 10) + '&num=10',
        'https://www.google.com/search?tbm=vid&q=' + encodeURIComponent(query) + '&start=' + (page * 10),
    ];
    const found = new Set();
    for (const url of urls) {
        let html;
        try { html = await request(url); } catch (error) { diagnostics.searchErrors++; log.warning('Search HTTP failure: ' + String(error.message)); continue; }
        const $ = cheerio.load(html);
        $('a[href]').each((_, a) => {
            const raw = $(a).attr('href') ?? '';
            let candidate = raw;
            try { const wrapped = new URL(raw, url); candidate = wrapped.searchParams.get('q') ?? wrapped.searchParams.get('url') ?? wrapped.href; } catch { /* ignore */ }
            const handle = getHandle(candidate);
            if (handle) found.add(handle);
        });
        for (const match of html.matchAll(/tiktok\\.com(?:\\/|%2F)@([a-zA-Z0-9._]{2,24})/gi)) if (validHandle(match[1])) found.add(match[1].toLowerCase());
        if (found.size) return [...found];
        diagnostics.searchEmpty++;
        if (/captcha|unusual traffic|verify you are human|automated queries/i.test(html)) diagnostics.searchBlocked++;
    }
    return [...found];
}
function embeddedState(html) {
    const $ = cheerio.load(html);
    for (const id of ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE']) {
        const raw = $('script#' + id).html();
        if (raw) try { return JSON.parse(raw); } catch { /* continue */ }
    }
    return null;
}
function findProfile(state, handle) {
    const users = state?.UserModule?.users;
    const stats = state?.UserModule?.stats;
    if (users && stats) {
        const key = Object.keys(users).find(k => k.toLowerCase() === handle || users[k]?.uniqueId?.toLowerCase() === handle);
        if (key) return { followers: stats[key]?.followerCount, userId: users[key]?.id, secUid: users[key]?.secUid };
    }
    const detail = state?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo;
    if (detail?.user?.uniqueId?.toLowerCase() === handle) return { followers: detail.stats?.followerCount, userId: detail.user.id, secUid: detail.user.secUid };
    return null;
}
function latestTimestamp(state, userId) {
    const modules = state?.ItemModule?.items;
    if (modules && typeof modules === 'object') {
        const times = Object.values(modules).filter(x => String(x?.author) === String(userId)).map(x => Number(x?.createTime)).filter(Number.isFinite);
        if (times.length) return Math.max(...times);
    }
    const scope = state?.__DEFAULT_SCOPE__ ?? {};
    const itemList = scope['webapp.user-post']?.itemList ?? scope['webapp.user-detail']?.itemList;
    if (Array.isArray(itemList)) {
        const times = itemList.map(x => Number(x?.createTime)).filter(Number.isFinite);
        if (times.length) return Math.max(...times);
    }
    return null;
}
async function verify(handle) {
    const html = await request('https://www.tiktok.com/@' + encodeURIComponent(handle));
    const state = embeddedState(html);
    const profile = findProfile(state, handle);
    if (!profile || !Number.isFinite(Number(profile.followers))) return { reason: 'missingData' };
    const followers = Number(profile.followers);
    if (followers < minFollowers || followers > maxFollowers) return { reason: 'outOfRange' };
    let latest = latestTimestamp(state, profile.userId);
    // As with the Comments Scraper, use a cookie-bearing TikTok JSON endpoint when
    // the HTML does not include the necessary records. Missing data is never a pass.
    if (!latest && profile.secUid) {
        try {
            const api = new URL('https://www.tiktok.com/api/post/item_list/');
            api.searchParams.set('aid', '1988');
            api.searchParams.set('secUid', String(profile.secUid));
            api.searchParams.set('count', '1');
            api.searchParams.set('cursor', '0');
            const token = (await jar.getCookies('https://www.tiktok.com/')).find(x => x.key === 'msToken')?.value;
            if (token) api.searchParams.set('msToken', token);
            const response = await client({ url: api.toString(), responseType: 'text', headers: { accept: 'application/json, text/plain, */*', referer: 'https://www.tiktok.com/@' + handle } });
            if (response.statusCode === 200) {
                const data = JSON.parse(response.body);
                if (Number(data.status_code ?? 0) === 0) {
                    const posts = data.itemList ?? data.item_list ?? [];
                    const times = posts.map(p => Number(p.createTime ?? p.create_time)).filter(Number.isFinite);
                    if (times.length) latest = Math.max(...times);
                }
            }
        } catch (error) { log.debug('Recent-post endpoint unavailable for @' + handle + ': ' + String(error.message)); }
    }
    // TikTok often omits the post list from profile HTML; never infer activity.
    if (!latest) return { reason: 'missingData' };
    const postedAt = new Date(latest * 1000);
    if (postedAt.getTime() > Date.now() + 3600000 || Date.now() - postedAt.getTime() > days * 86400000) return { reason: 'inactive' };
    return { handle, profileUrl: 'https://www.tiktok.com/@' + handle, followers, lastPostAt: postedAt.toISOString(), activeWithinDays: days };
}
try {
    const candidates = [];
    for (let page = 0; page < 5 && candidates.length < maxCandidates; page++) {
        for (const keyword of keywords) {
            if (candidates.length >= maxCandidates) break;
            diagnostics.searchQueries++;
            try {
                const found = await discover(String(keyword), page);
                for (const h of found) if (!seen.has(h)) { seen.add(h); candidates.push(h); }
            } catch (e) { diagnostics.searchErrors++; log.warning('Search unavailable: ' + String(e.message)); }
            await sleep(750);
        }
    }
    for (const handle of candidates) {
        if (results.length >= target) break;
        diagnostics.profilesChecked++;
        try {
            const result = await verify(handle);
            if (result.reason) diagnostics[result.reason]++;
            else { results.push(result); await Actor.pushData({ recordType: 'CREATOR', ...result }); log.info('Qualified: @' + handle); }
        } catch (e) { diagnostics.profileErrors++; log.warning('@' + handle + ': ' + String(e.message)); }
        await sleep(1250);
    }
    await Actor.pushData({ recordType: 'RUN_SUMMARY', target, qualified: results.length, candidatesDiscovered: candidates.length, criteria: { minFollowers, maxFollowers, activeWithinDays: days }, diagnostics, note: results.length < target ? 'Fewer than target could be verified from publicly available profile and recent-post data.' : 'Target reached.' });
} finally { await Actor.exit(); }
