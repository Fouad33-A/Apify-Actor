import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';
import { CookieJar } from 'tough-cookie';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const diagnosticOnly = input.diagnosticOnly === true;
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
        if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return null;
        const h = decodeURIComponent(u.pathname.split('/').find(x => x.startsWith('@'))?.slice(1) ?? '');
        return validHandle(h) ? h.toLowerCase() : null;
    } catch { return null; }
};
async function request(url) {
    const response = await client({ url, responseType: 'text', headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
    if (response.statusCode !== 200) throw new Error('HTTP ' + response.statusCode);
    return response.body;
}
// TikTok-native discovery, using the Comments Scraper's persistent cookie jar,
// browser-like HTTP client, msToken, JSON status validation and request pacing.
let discoveryInitialized = false;
async function initializeDiscovery() {
    if (discoveryInitialized) return;
    discoveryInitialized = true;
    const response = await client({ url: 'https://www.tiktok.com/', responseType: 'text', headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
    if (response.statusCode === 429) throw new Error('TikTok discovery bootstrap HTTP 429');
    if (response.statusCode !== 200) log.warning('TikTok bootstrap HTTP ' + response.statusCode);
}
function extractSearchHandles(json) {
    const entries = [
        ...(Array.isArray(json.user_list) ? json.user_list : []),
        ...(Array.isArray(json.userList) ? json.userList : []),
        ...(Array.isArray(json.data?.user_list) ? json.data.user_list : []),
        ...(Array.isArray(json.data?.userList) ? json.data.userList : []),
    ];
    const handles = new Set();
    for (const entry of entries) {
        const user = entry.user_info ?? entry.userInfo ?? entry.user ?? entry;
        const handle = user.unique_id ?? user.uniqueId ?? user.username ?? user.handle;
        if (typeof handle === 'string' && validHandle(handle)) handles.add(handle.toLowerCase());
    }
    return [...handles];
}
async function discover(keyword, page) {
    await initializeDiscovery();
    const api = new URL('https://www.tiktok.com/api/search/user/full/');
    api.searchParams.set('aid', '1988');
    api.searchParams.set('keyword', keyword);
    api.searchParams.set('offset', String(page * 20));
    api.searchParams.set('count', '20');
    const token = (await jar.getCookies('https://www.tiktok.com/')).find(c => c.key === 'msToken')?.value;
    if (token) api.searchParams.set('msToken', token);
    const response = await client({
        url: api.toString(), responseType: 'text',
        headers: { accept: 'application/json, text/plain, */*', referer: 'https://www.tiktok.com/search/user?q=' + encodeURIComponent(keyword) },
    });
    if (diagnosticOnly) {
        const body = String(response.body ?? '');
        const preview = body.slice(0, 300).replace(/(msToken|sessionid|sid_tt|ttwid|csrf_token|token)[=:\\s\"']+[^\\s\"'&<>]+/gi, '$1=[REDACTED]');
        await Actor.pushData({ recordType: 'HTTP_DIAGNOSTIC', endpoint: api.origin + api.pathname, keyword, httpStatus: response.statusCode, contentType: String(response.headers['content-type'] ?? ''), finalHost: (() => { try { return new URL(response.url).hostname; } catch { return null; } })(), bodyLength: body.length, bodyStartsWith: body.trimStart().slice(0, 1), responsePreview: preview });
    }
    if (diagnosticOnly) {
        const mobile = new URL(api.toString());
        mobile.hostname = 'm.tiktok.com';
        try {
            const mobileResponse = await client({ url: mobile.toString(), responseType: 'text', headers: { accept: 'application/json, text/plain, */*', referer: 'https://m.tiktok.com/search/user?q=' + encodeURIComponent(keyword) } });
            const mobileBody = String(mobileResponse.body ?? '');
            await Actor.pushData({ recordType: 'MOBILE_HTTP_DIAGNOSTIC', endpoint: mobile.origin + mobile.pathname, keyword, httpStatus: mobileResponse.statusCode, contentType: String(mobileResponse.headers['content-type'] ?? ''), finalHost: (() => { try { return new URL(mobileResponse.url).hostname; } catch { return null; } })(), bodyLength: mobileBody.length, bodyStartsWith: mobileBody.trimStart().slice(0, 1), jsonSummary: (() => { try { const j = JSON.parse(mobileBody); return { keys: Object.keys(j).slice(0, 12), status_code: j.status_code ?? null, status_msg: String(j.status_msg ?? '').slice(0, 120), user_list_length: Array.isArray(j.user_list) ? j.user_list.length : null, userList_length: Array.isArray(j.userList) ? j.userList.length : null }; } catch { return { parseError: true }; } })(), locationHeaderHost: (() => { try { return new URL(mobileResponse.headers.location).hostname; } catch { return null; } })() });
        } catch (error) { await Actor.pushData({ recordType: 'MOBILE_HTTP_DIAGNOSTIC', endpoint: mobile.origin + mobile.pathname, error: String(error.message).slice(0, 250) }); }
    }
    if (diagnosticOnly) {
        // Compare plausible TikTok-native routes with the same established session.
        // This is endpoint discovery, not evidence that any route is supported.
        const probes = [
            ['mobile-user-search', 'https://m.tiktok.com/api/search/user/full/'],
            ['mobile-general-search', 'https://m.tiktok.com/api/search/general/full/'],
            ['desktop-general-search', 'https://www.tiktok.com/api/search/general/full/'],
            ['mobile-search-page', 'https://m.tiktok.com/search/user'],
        ];
        for (const [name, base] of probes) {
            const u = new URL(base);
            if (name === 'mobile-search-page') u.searchParams.set('q', keyword);
            else {
                u.searchParams.set('aid', '1988');
                u.searchParams.set('keyword', keyword);
                u.searchParams.set('offset', '0');
                u.searchParams.set('count', '20');
                if (token) u.searchParams.set('msToken', token);
            }
            try {
                const r = await client({ url: u.toString(), responseType: 'text', followRedirect: true, headers: { accept: name === 'mobile-search-page' ? 'text/html,application/xhtml+xml' : 'application/json, text/plain, */*', referer: 'https://' + u.hostname + '/search?q=' + encodeURIComponent(keyword) } });
                const body = String(r.body ?? '');
                let parsed = null;
                try { parsed = JSON.parse(body); } catch { /* not JSON */ }
                await Actor.pushData({ recordType: 'ENDPOINT_PROBE', probe: name, host: u.hostname, path: u.pathname, httpStatus: r.statusCode, contentType: String(r.headers['content-type'] ?? ''), bodyLength: body.length, jsonParsed: parsed !== null, jsonKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 12) : [], tiktokStatusCode: parsed?.status_code ?? null, tiktokStatusMessage: String(parsed?.status_msg ?? '').slice(0, 160), handlesFound: parsed ? extractSearchHandles(parsed).length : 0, htmlTitle: !parsed ? (body.match(new RegExp('<title[^>]*>([^<]*)</title>', 'i'))?.[1] ?? '').slice(0, 120) : '' });
            } catch (e) { await Actor.pushData({ recordType: 'ENDPOINT_PROBE', probe: name, error: String(e.message).slice(0, 180) }); }
            await sleep(300);
        }
    }
    if (diagnosticOnly) {
        // Probe the user-provided TikTok One creator exploration page once.
        const exploreUrl = 'https://ads.tiktok.com/creative/creator/explore?aioChannel=SEO&aioScene=AIOEntrance&aioCode=685cefab91818007&region=us_ttp';
        try {
            const explore = await client({ url: exploreUrl, responseType: 'text', followRedirect: true, headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
            const html = String(explore.body ?? '');
            const $ = cheerio.load(html);
            const finalUrl = new URL(explore.url || exploreUrl);
            const scripts = $('script[src]').map((_, el) => $(el).attr('src')).get();
            const visibleText = $('body').text().replace(/\\s+/g, ' ').trim();
            const handles = [...new Set([...html.matchAll(new RegExp('tiktok[.]com/@([a-zA-Z0-9._]{2,24})', 'g'))].map(m => m[1].toLowerCase()).filter(validHandle))];
            // Inspect a bounded set of public JS bundles for creator-listing API route hints.
            const assets = scripts.map(src => { try { return new URL(src, finalUrl).toString(); } catch { return null; } }).filter(Boolean);
            await Actor.pushData({ recordType: 'TIKTOK_ONE_ASSET_INDEX', scriptUrls: assets.slice(0, 20).map(url => { const u = new URL(url); return { host: u.hostname, path: u.pathname.slice(0, 180) }; }), inlineScriptCount: $('script:not([src])').length, htmlRouteHints: [...new Set((html.match(new RegExp('[/][a-zA-Z0-9_/-]{0,70}(creator|influencer|marketplace)[a-zA-Z0-9_/-]{0,70}', 'gi')) || []).map(x => x.slice(0, 120)))].slice(0, 15) });
            // Prioritize the app's entry bundle and its route-module references, not SDKs.
            const selectedAssets = assets.filter(x => /\\/(main|6434|hooks|components)\\.[a-f0-9]+\\.js(?:\\?|$)/.test(x)).slice(0, 4);
            for (const asset of selectedAssets) {
                try {
                    const res = await client({ url: asset, responseType: 'text', timeout: { request: 15000 }, headers: { accept: '*/*', referer: exploreUrl } });
                    const js = String(res.body ?? '');
                    const routeCandidates = [...new Set((js.match(new RegExp('[/][a-zA-Z0-9_./-]{0,90}(creator|influencer|marketplace|search)[a-zA-Z0-9_./-]{0,90}', 'gi')) || []).filter(x => x.includes('/')).map(x => x.slice(0, 150)))].slice(0, 20);
                    const u = new URL(asset);
                    const apiPaths = [...new Set((js.match(new RegExp('[/][a-zA-Z0-9_.-]*(?:api|creator|search|explore)[a-zA-Z0-9_./-]{2,140}', 'gi')) || []).filter(x => /api|search|explore/i.test(x)).map(x => x.slice(0, 160)))].slice(0, 40);
                    const chunkNames = [...new Set((js.match(new RegExp('[a-zA-Z0-9_-]{2,80}\\\\.[a-f0-9]{8}\\\\.js', 'g')) || []))].slice(0, 30);
                    await Actor.pushData({ recordType: 'TIKTOK_ONE_ROUTE_HINTS', assetPath: u.pathname.slice(0, 160), apiPaths, chunkNames, hasExploreRoute: js.includes('creator/explore'), hasApiClient: /axios|fetch\\\\(/.test(js) });
                    await Actor.pushData({ recordType: 'TIKTOK_ONE_JS_PROBE', assetHost: u.hostname, assetPath: u.pathname.slice(0, 160), httpStatus: res.statusCode, bodyLength: js.length, routeCandidates, hasCreatorTerms: /creator|influencer/i.test(js) });
                } catch (error) { await Actor.pushData({ recordType: 'TIKTOK_ONE_JS_PROBE', error: String(error.message).slice(0, 160) }); }
                await sleep(300);
            }
            await Actor.pushData({ recordType: 'TIKTOK_ONE_DIAGNOSTIC', httpStatus: explore.statusCode, contentType: String(explore.headers['content-type'] ?? ''), finalHost: finalUrl.hostname, finalPath: finalUrl.pathname, bodyLength: html.length, title: $('title').first().text().slice(0, 160), scriptCount: scripts.length, scriptHosts: [...new Set(scripts.map(x => { try { return new URL(x, finalUrl).hostname; } catch { return ''; } }))].filter(Boolean).slice(0, 10), loginSignals: /log\\s?in|sign\\s?in|captcha|verify you are human|access denied/i.test(visibleText.slice(0, 15000)), creatorSignals: /creator marketplace|creator explore|creator search|creator discovery|followers/i.test(visibleText.slice(0, 15000)), visibleTextStart: visibleText.slice(0, 300), tiktokProfileLinksFound: handles.length, sampleHandles: handles.slice(0, 5), hasNextData: Boolean($('script#__NEXT_DATA__').length), hasUniversalState: Boolean($('script#__UNIVERSAL_DATA_FOR_REHYDRATION__').length) });
        } catch (error) { await Actor.pushData({ recordType: 'TIKTOK_ONE_DIAGNOSTIC', error: String(error.message).slice(0, 240) }); }
    }
    if (response.statusCode === 429) { diagnostics.searchBlocked++; throw new Error('TikTok search HTTP 429; stopping discovery to avoid further rate limits'); }
    if (response.statusCode !== 200) throw new Error('TikTok search HTTP ' + response.statusCode);
    let json;
    try { json = JSON.parse(response.body); } catch { diagnostics.searchBlocked++; throw new Error('TikTok search returned non-JSON response'); }
    if (json.status_code !== undefined && Number(json.status_code) !== 0) throw new Error('TikTok search status_code=' + json.status_code + (json.status_msg ? ': ' + json.status_msg : ''));
    const handles = extractSearchHandles(json);
    if (!handles.length) diagnostics.searchEmpty++;
    return handles;
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
    let discoveryRateLimited = false;
    for (let page = 0; page < (diagnosticOnly ? 1 : 5) && candidates.length < maxCandidates; page++) {
        for (const keyword of (diagnosticOnly ? keywords.slice(0, 1) : keywords)) {
            if (candidates.length >= maxCandidates) break;
            diagnostics.searchQueries++;
            try {
                const found = await discover(String(keyword), page);
                for (const h of found) if (!seen.has(h)) { seen.add(h); candidates.push(h); }
            } catch (e) {
                diagnostics.searchErrors++;
                log.warning('TikTok discovery unavailable: ' + String(e.message));
                if (String(e.message).includes('429')) { discoveryRateLimited = true; break; }
            }
            await sleep(750);
        }
        if (discoveryRateLimited) break;
    }
    for (const handle of (diagnosticOnly ? [] : candidates)) {
        if (results.length >= target) break;
        diagnostics.profilesChecked++;
        try {
            const result = await verify(handle);
            if (result.reason) diagnostics[result.reason]++;
            else { results.push(result); await Actor.pushData({ recordType: 'CREATOR', ...result }); log.info('Qualified: @' + handle); }
        } catch (e) { diagnostics.profileErrors++; log.warning('@' + handle + ': ' + String(e.message)); }
        await sleep(1250);
    }
    await Actor.pushData({ recordType: 'RUN_SUMMARY', discoveryMethod: 'TikTok native user search', discoveryRateLimited, target, qualified: results.length, candidatesDiscovered: candidates.length, criteria: { minFollowers, maxFollowers, activeWithinDays: days }, diagnostics, note: results.length < target ? 'Fewer than target could be verified from publicly available profile and recent-post data.' : 'Target reached.' });
} finally { await Actor.exit(); }
