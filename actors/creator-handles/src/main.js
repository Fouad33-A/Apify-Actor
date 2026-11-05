import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const target = Math.min(100, Math.max(1, Number(input.targetCount) || 100));
const minFollowers = Number(input.minFollowers ?? 10000);
const maxFollowers = Number(input.maxFollowers ?? 150000);
const days = Number(input.activeWithinDays ?? 7);
const maxCandidates = Math.min(3000, Math.max(10, Number(input.maxCandidates) || 600));
const keywords = Array.isArray(input.keywords) && input.keywords.length ? input.keywords : ['fitness','beauty','food','travel','education','fashion','gaming','technology','lifestyle','art','sports','music'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const seen = new Set();
const results = [];
const diagnostics = { searchQueries: 0, searchErrors: 0, profilesChecked: 0, profileErrors: 0, missingData: 0, outOfRange: 0, inactive: 0 };
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
    const response = await gotScraping({ url, timeout: { request: 18000 }, retry: { limit: 1 }, headers: { 'accept-language': 'en-US,en;q=0.9' }, throwHttpErrors: false });
    if (response.statusCode !== 200) throw new Error('HTTP ' + response.statusCode);
    return response.body;
}
async function discover(keyword, page) {
    const query = 'site:tiktok.com/@ ' + keyword + ' TikTok';
    const html = await request('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&first=' + (page * 10 + 1));
    const $ = cheerio.load(html);
    const handles = [];
    $('a[href]').each((_, a) => {
        const h = getHandle($(a).attr('href'));
        if (h) handles.push(h);
    });
    // Search engines may wrap URLs inside query parameters.
    for (const match of html.matchAll(/https?(?:%3A%2F%2F|:\/\/)(?:www\\.)?tiktok\\.com(?:%2F|\/)@([a-zA-Z0-9._]{2,24})/gi)) {
        if (validHandle(match[1])) handles.push(match[1].toLowerCase());
    }
    return [...new Set(handles)];
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
    const latest = latestTimestamp(state, profile.userId);
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
