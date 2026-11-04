import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

await Actor.init();

const VERSION = '2026-11-05-v5.2';
const input = (await Actor.getInput()) ?? {};
const ALLOWED_KEYS = new Set(['postUrls', 'videoUrls', 'maxCommentsPerPost', 'includeReplies', 'minAskers', 'minVideos', 'languages', 'creatorVideos']);
const unknownKeys = Object.keys(input).filter((key) => !ALLOWED_KEYS.has(key));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PAGE_SIZE = 20;
const MAX_PAGES_SAFETY = 500;

function normalizeInputUrl(item) {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object' && typeof item.url === 'string') return item.url.trim();
    return '';
}

function collectUrls() {
    if (unknownKeys.length) {
        throw new Error(`Unknown input field(s): ${unknownKeys.join(', ')}. Supported fields: postUrls, videoUrls, maxCommentsPerPost, includeReplies, minAskers, minVideos, languages, creatorVideos.`);
    }

    const rawPostUrls = input.postUrls === undefined ? [] : input.postUrls;
    const rawVideoUrls = input.videoUrls === undefined ? [] : input.videoUrls;

    if (!Array.isArray(rawPostUrls)) throw new Error('postUrls must be an array of strings or objects shaped like {"url":"https://www.tiktok.com/@user/video/123..."}.');
    if (!Array.isArray(rawVideoUrls)) throw new Error('videoUrls must be an array of TikTok video URL strings.');

    const creatorGroups = input.creatorVideos ?? [];
    if (!Array.isArray(creatorGroups)) throw new Error('creatorVideos must be an array.');
    const explicitCreatorByVideo = new Map();
    for (const group of creatorGroups) {
        if (!group || typeof group.creator !== 'string' || !/^[\w.]{1,40}$/.test(group.creator.replace(/^@/, '')) || !Array.isArray(group.videoUrls)) throw new Error('Each creatorVideos item needs creator and videoUrls.');
        for (const url of group.videoUrls) {
            if (typeof url !== 'string') throw new Error('creatorVideos videoUrls must be strings.');
            const id = getVideoId(url);
            if (!id) throw new Error('creatorVideos requires direct TikTok video URLs.');
            const creator = group.creator.replace(/^@/, '').toLowerCase();
            if (explicitCreatorByVideo.has(id) && explicitCreatorByVideo.get(id) !== creator) throw new Error('Conflicting creators for video ' + id);
            explicitCreatorByVideo.set(id, creator);
        }
    }
    collectUrls.explicitCreatorByVideo = explicitCreatorByVideo;
    const normalized = [];
    for (const group of creatorGroups) normalized.push(...group.videoUrls);
    for (const item of rawPostUrls) {
        const url = normalizeInputUrl(item);
        if (!url) throw new Error('Every postUrls item must be a URL string or an object with a non-empty url property.');
        normalized.push(url);
    }
    for (const item of rawVideoUrls) {
        if (typeof item !== 'string' || !item.trim()) throw new Error('Every videoUrls item must be a non-empty URL string.');
        normalized.push(item.trim());
    }

    const deduped = [...new Set(normalized)];
    if (!deduped.length) throw new Error('Input must contain at least one URL in postUrls or videoUrls.');
    for (const url of deduped) {
        let parsed;
        try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
        const host = parsed.hostname.toLowerCase();
        if (!(host === 'tiktok.com' || host.endsWith('.tiktok.com'))) throw new Error(`Only TikTok URLs are supported: ${url}`);
    }
    return deduped;
}

const minAskers = Math.max(3, Math.floor(Number(input.minAskers) || 3));
const minVideos = Math.max(2, Math.floor(Number(input.minVideos) || 2));
const allowedLanguages = Array.isArray(input.languages) ? input.languages.map(x => String(x).toLowerCase()) : [];
const inputUrls = collectUrls();
const explicitCreatorByVideo = collectUrls.explicitCreatorByVideo;
const maxCommentsPerPost = Math.max(1, Math.min(10000, Number(input.maxCommentsPerPost) || 100));
const includeReplies = input.includeReplies === true;

function getVideoId(url) {
    return String(url).match(/\/video\/(\d+)/)?.[1] ?? null;
}

async function getMsToken(jar) {
    const cookies = await jar.getCookies('https://www.tiktok.com/');
    return cookies.find((cookie) => cookie.key === 'msToken')?.value ?? null;
}

function buildCommentUrl({ videoId, cursor, msToken }) {
    const url = new URL('https://www.tiktok.com/api/comment/list/');
    url.searchParams.set('aid', '1988');
    url.searchParams.set('aweme_id', videoId);
    url.searchParams.set('count', String(PAGE_SIZE));
    url.searchParams.set('cursor', String(cursor));
    if (msToken) url.searchParams.set('msToken', msToken);
    return url.toString();
}

function isQuestionText(text) {
    const value = String(text ?? '').trim();
    if (!value) return false;
    if (value.includes('?') || value.includes('？')) return true;
    return /^(who|what|when|where|why|how|which|can|could|would|should|do|does|did|is|are|am|was|were|will|have|has|had|may|might)(?![\p{L}\p{M}\p{N}_])/iu.test(value);
}

function normalizeQuestion(text) {
    return String(text ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/@[\w.]+/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const CLUSTER_STOPWORDS = new Set([
    'a','an','the','and','or','but','if','then','than','to','of','in','on','at','for','from','with','as','by',
    'is','are','am','was','were','be','been','being','do','does','did','doing','have','has','had','having',
    'can','could','would','should','will','may','might','must','i','me','my','mine','we','our','ours','you',
    'your','yours','he','she','it','they','them','their','this','that','these','those','what','whats','which',
    'who','whom','whose','when','where','why','how','please','just','really','also','so','too','very','much',
    'many','get','got','getting','use','using','used','not','there','here','off','go','going','went','best','better','year','years','cover','covered','covering','plan','plans','about','add','video','one','any','needed','never','next','week','weeks','option','options','month','months',
]);

const GENERIC_CLUSTER_TOKENS = new Set([
    'go','best','better','year','cover','plan','pay','make','take','want','need','needed','know','think','look','work','help','good','bad','thing','way','time','about','add','video','one','any','never','next','week','option','month','insurance','wife',
]);

function isTopicToken(token) {
    return token.length >= 3 && !GENERIC_CLUSTER_TOKENS.has(token);
}

const TOKEN_ALIASES = new Map([
    ['buying','buy'],['bought','buy'],['buys','buy'],['debts','debt'],['loans','loan'],['weeks','week'],
    ['months','month'],['accounts','account'],['savings','saving'],['saved','save'],['paying','pay'],['paid','pay'],
    ['payments','payment'],['liking','like'],['liked','like'],['works','work'],['working','work'],['hsas','hsa'],
    ['pulldowns','pulldown'],['pull-downs','pulldown'],['lats','lat'],['activating','activate'],['activation','activate'],['engaging','engage'],
]);

function creatorFromVideoUrl(videoUrl) {
    const match = String(videoUrl ?? '').match(/tiktok\.com\/@([^/]+)/i);
    return match?.[1]?.toLowerCase() ?? null;
}

function clusterTokens(text) {
    const normalized = normalizeQuestion(text);
    if (!normalized) return [];
    const tokens = normalized.split(' ')
        .map((token) => TOKEN_ALIASES.get(token) ?? token)
        .filter((token) => token.length > 1 && !CLUSTER_STOPWORDS.has(token));
    // Narrow semantic equivalence for exercise-muscle activation questions.
    // Keep other subjects and question intents separate to avoid false positives.
    const hasPulldown = tokens.includes('pulldown');
    const activation = tokens.some(t => ['feel', 'activate', 'engage', 'target'].includes(t));
    if (hasPulldown && activation && tokens.some(t => ['lat', 'back'].includes(t))) {
        return ['exercise:pulldown', 'muscle:lat', 'intent:activation'];
    }
    return [...new Set(tokens)].sort();
}

function questionType(text) {
    const value = String(text).trim().toLowerCase();
    if (/^(how|how\s+to)\b/.test(value)) return 'how';
    if (/^why\b/.test(value)) return 'why';
    if (/^which\b/.test(value)) return 'which';
    if (/^(can|could|would|should|is|does|do)\b/.test(value)) return 'can';
    if (/^(where|where\s+to)\b/.test(value)) return 'where_to_find';
    return 'other';
}

function detectLanguage(text) {
    // Deliberately conservative: do not label all Latin-script text English.
    // Unknown language is retained unless an explicit language filter is supplied.
    if (/[\u0600-\u06ff]/u.test(text)) return 'ar';
    if (/[\u0400-\u04ff]/u.test(text)) return 'ru';
    if (/[\u4e00-\u9fff]/u.test(text)) return 'zh';
    return 'und';
}

function questionClusterKey(text) {
    const normalized = normalizeQuestion(text);
    if (!normalized) return null;
    // Keep intent distinct: "how" and "why" are not interchangeable.
    // Canonical token sets catch reordering and harmless filler, not arbitrary paraphrases.
    const tokens = clusterTokens(text);
    const topics = tokens.filter(isTopicToken);
    if (tokens.length < 3 || topics.length < 2) return `exact:${normalized}`;
    const intent = tokens.includes('intent:activation') ? 'activation' : questionType(text);
    return `token:${intent}:${tokens.join('|')}`;
}

function buildRepeatedQuestions(questionRows, minDistinctAskers = 3, minDistinctVideos = 2) {
    const grouped = new Map();
    for (const row of questionRows) {
        const normalized = normalizeQuestion(row.commentText);
        const creator = row.creator ?? creatorFromVideoUrl(row.videoUrl);
        const clusterKey = questionClusterKey(row.commentText);
        if (!creator || !normalized || !clusterKey || !row.username || !row.videoId) continue;
        const key = `${creator.toLowerCase()}\u0000${clusterKey}`;
        const group = grouped.get(key) ?? [];
        group.push(row);
        grouped.set(key, group);
    }
    const result = [];
    for (const rows of grouped.values()) {
        const askers = new Set(rows.map(row => String(row.userId ?? row.username).trim().toLowerCase()));
        const videos = new Set(rows.map(row => row.videoId));
        if (askers.size < Math.max(3, minDistinctAskers) || videos.size < Math.max(2, minDistinctVideos)) continue;
        const uniqueExamples = [];
        const exampleAskers = new Set();
        for (const row of rows) {
            const asker = String(row.userId ?? row.username).trim().toLowerCase();
            if (exampleAskers.has(asker)) continue;
            exampleAskers.add(asker);
            uniqueExamples.push({ text: row.commentText, username: row.username, videoUrl: row.videoUrl });
            if (uniqueExamples.length === 3) break;
        }
        result.push({
            recordType: 'REPEATED_QUESTION',
            creator: rows[0].creator ?? creatorFromVideoUrl(rows[0].videoUrl),
            questionText: rows[0].commentText,
            normalizedQuestion: normalizeQuestion(rows[0].commentText),
            questionType: questionType(rows[0].commentText),
            language: rows[0].language ?? detectLanguage(rows[0].commentText),
            askerCount: askers.size,
            videoCount: videos.size,
            exampleComments: uniqueExamples,
            matchingVideoUrls: [...new Set(rows.map(row => row.videoUrl))],
            clusterMethod: questionClusterKey(rows[0].commentText).startsWith('token:') ? 'intent_and_canonical_tokens' : 'exact_normalized_question',
        });
    }
    return result.sort((a,b) => b.videoCount-a.videoCount || b.askerCount-a.askerCount);
}

function parseGenuineComment(comment) {
    if (!comment || typeof comment !== 'object') return null;
    const commentId = comment.cid ?? comment.comment_id ?? comment.commentId ?? null;
    if (!commentId) return null;
    const user = comment.user;
    if (!user || typeof user !== 'object') return null;
    const username = user.unique_id ?? user.uniqueId ?? user.nickname ?? null;
    if (typeof username !== 'string' || !username.trim()) return null;
    let commentText = null;
    if (typeof comment.text === 'string') commentText = comment.text;
    else if (typeof comment.comment_text === 'string') commentText = comment.comment_text;
    if (typeof commentText !== 'string' || !commentText.trim()) return null;
    const text = commentText.trim();
    return {
        commentId: String(commentId),
        commentText: text,
        username: username.trim(),
        userId: user.uid != null ? String(user.uid) : (user.sec_uid != null ? String(user.sec_uid) : null),
        isQuestion: isQuestionText(text),
        questionType: isQuestionText(text) ? questionType(text) : null,
        language: detectLanguage(text),
        replyCount: Number.isFinite(Number(comment.reply_comment_total)) ? Number(comment.reply_comment_total) : null,
    };
}

async function createClient() {
    const jar = new CookieJar();
    const client = gotScraping.extend({
        cookieJar: jar,
        headers: { 'accept-language': 'en-US,en;q=0.9' },
        timeout: { request: 25000 },
        throwHttpErrors: false,
    });
    return { jar, client };
}

async function resolveVideo({ client, inputUrl }) {
    const response = await client({
        url: inputUrl,
        method: 'GET',
        followRedirect: true,
        responseType: 'text',
        headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const finalUrl = response.url;
    const videoId = getVideoId(finalUrl);
    if (!videoId) throw new Error(`Could not extract video ID from ${finalUrl}`);
    return { videoId, finalUrl, status: response.statusCode };
}

async function fetchCommentPage({ client, jar, videoId, videoUrl, cursor }) {
    const msToken = await getMsToken(jar);
    const requestUrl = buildCommentUrl({ videoId, cursor, msToken });
    const response = await client({
        url: requestUrl,
        method: 'GET',
        responseType: 'buffer',
        headers: {
            accept: 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.9',
            referer: videoUrl,
        },
    });
    const body = response.body ?? Buffer.alloc(0);
    if (response.statusCode !== 200) throw new Error(`Comment endpoint returned HTTP ${response.statusCode}`);
    if (!body.length) throw new Error('Comment endpoint returned an empty response.');
    let json;
    try { json = JSON.parse(body.toString('utf8')); } catch { throw new Error('Comment endpoint returned invalid JSON.'); }
    if (json.status_code !== undefined && Number(json.status_code) !== 0) {
        throw new Error(`TikTok status_code=${json.status_code}${json.status_msg ? `: ${json.status_msg}` : ''}`);
    }
    return json;
}

async function scrapeVideo(inputUrl, questionRows) {
    const { jar, client } = await createClient();
    log.info(`[VIDEO] Resolving ${inputUrl}`);
    const resolved = await resolveVideo({ client, inputUrl });
    const { videoId, finalUrl } = resolved;
    log.info('[VIDEO] ' + JSON.stringify({ videoId, status: resolved.status, finalUrl }));

    let cursor = 0;
    let pageNumber = 0;
    let saved = 0;
    let reportedTotal = null;
    let stopReason = 'unknown';
    const seenCommentIds = new Set();

    while (saved < maxCommentsPerPost && pageNumber < MAX_PAGES_SAFETY) {
        pageNumber++;
        log.info(`[COMMENTS] video=${videoId} page=${pageNumber} cursor=${cursor}`);
        let json;
        try {
            json = await fetchCommentPage({ client, jar, videoId, videoUrl: finalUrl, cursor });
        } catch (error) {
            log.error(`[COMMENTS] video=${videoId} cursor=${cursor} failed: ${error.message}`);
            stopReason = 'page_error';
            break;
        }

        const comments = Array.isArray(json.comments) ? json.comments : [];
        const total = Number.isFinite(Number(json.total)) ? Number(json.total) : null;
        if (total !== null) reportedTotal = reportedTotal === null ? total : Math.max(reportedTotal, total);
        const hasMore = Number(json.has_more) === 1 || json.has_more === true;
        const nextCursor = Number(json.cursor);
        log.info('[PAGE] ' + JSON.stringify({ videoId, page: pageNumber, cursor, returned: comments.length, total, hasMore, nextCursor: Number.isFinite(nextCursor) ? nextCursor : null }));

        if (!comments.length) { stopReason = 'empty_page'; break; }
        let acceptedThisPage = 0;
        let duplicatesThisPage = 0;
        let rejectedThisPage = 0;

        for (const rawComment of comments) {
            if (saved >= maxCommentsPerPost) break;
            const comment = parseGenuineComment(rawComment);
            if (!comment) { rejectedThisPage++; continue; }
            if (seenCommentIds.has(comment.commentId)) { duplicatesThisPage++; continue; }
            seenCommentIds.add(comment.commentId);

            if (comment.isQuestion && (!allowedLanguages.length || allowedLanguages.includes(comment.language))) {
                questionRows.push({ commentText: comment.commentText, username: comment.username, userId: comment.userId, videoId, videoUrl: finalUrl, creator: explicitCreatorByVideo.get(videoId) ?? creatorFromVideoUrl(finalUrl) ?? creatorFromVideoUrl(inputUrl) });
            }

            await Actor.pushData({
                recordType: 'comment',
                commentId: comment.commentId,
                commentText: comment.commentText,
                username: comment.username,
                userId: comment.userId,
                isQuestion: comment.isQuestion,
                questionType: comment.questionType,
                language: comment.language,
                replyCount: comment.replyCount,
                isReply: false,
                videoId,
                videoUrl: finalUrl,
            });
            saved++;
            acceptedThisPage++;
        }

        log.info('[SAVED] ' + JSON.stringify({ videoId, page: pageNumber, acceptedThisPage, duplicatesThisPage, rejectedThisPage, saved, limit: maxCommentsPerPost }));
        if (saved >= maxCommentsPerPost) { stopReason = 'max_comments_per_post'; break; }
        if (!hasMore) { stopReason = 'tiktok_has_more_0'; break; }
        if (!Number.isFinite(nextCursor)) { stopReason = 'invalid_cursor'; break; }
        if (nextCursor === cursor) { stopReason = 'cursor_stalled'; break; }
        cursor = nextCursor;
        await sleep(250);
    }

    if (pageNumber >= MAX_PAGES_SAFETY && saved < maxCommentsPerPost) stopReason = 'page_safety_limit';
    log.info('[VIDEO COMPLETE] ' + JSON.stringify({ videoId, commentsSaved: saved, reportedTotal, pages: pageNumber, stopReason }));
    return { videoId, commentsSaved: saved, reportedTotal, pages: pageNumber, stopReason };
}

let exitCode = 0;
try {
    log.info(`[${VERSION}] TikTok public top-level comments scraper active.`);
    if (includeReplies) {
        log.warning('[REPLIES] includeReplies=true was requested, but this build does not fabricate reply coverage. The anonymous public source used here exposes top-level pagination only; reply rows are not fetched.');
    }
    log.info(`[INPUT] videos=${inputUrls.length} maxCommentsPerPost=${maxCommentsPerPost} includeReplies=${includeReplies}`);

    let successfulVideos = 0;
    let failedVideos = 0;
    let totalComments = 0;
    let reportedCommentsTotal = 0;
    let videosWithReportedTotal = 0;
    const videoResults = [];
    const questionRows = [];

    for (let index = 0; index < inputUrls.length; index++) {
        const inputUrl = inputUrls[index];
        try {
            const result = await scrapeVideo(inputUrl, questionRows);
            successfulVideos++;
            totalComments += result.commentsSaved;
            if (result.reportedTotal !== null) {
                reportedCommentsTotal += result.reportedTotal;
                videosWithReportedTotal++;
            }
            videoResults.push({ inputUrl, status: 'ok', ...result });
        } catch (error) {
            failedVideos++;
            videoResults.push({ inputUrl, status: 'failed', error: error.message });
            log.error(`[VIDEO ${index + 1}] ${error.stack ?? error.message}`);
        }
    }

    const repeatedQuestions = buildRepeatedQuestions(questionRows, minAskers, minVideos);
    log.info(`[QUESTION SCREEN] ${repeatedQuestions.length} clusters met ${minAskers} distinct askers on ${minVideos} distinct videos.`);
    for (const cluster of repeatedQuestions) await Actor.pushData(cluster);

    const summary = {
        recordType: 'RUN_SUMMARY',
        status: failedVideos === inputUrls.length ? 'failed' : (failedVideos ? 'partial' : 'completed'),
        version: VERSION,
        videosRequested: inputUrls.length,
        successfulVideos,
        failedVideos,
        totalCommentsSaved: totalComments,
        maxCommentsPerPost,
        coverage: {
            scope: 'top_level_public_comments',
            reportedCommentsTotal: videosWithReportedTotal ? reportedCommentsTotal : null,
            videosWithReportedTotal,
            note: 'TikTok reported totals can include comments/replies that are not exposed by the anonymous top-level pagination source. Saved rows are only comments actually returned by that source, subject to maxCommentsPerPost.',
        },
        replies: {
            requested: includeReplies,
            fetched: false,
            note: 'Reply threads are not fetched by this anonymous public-source build. isReply is therefore false for saved rows; replyCount is included when TikTok exposes it on a top-level comment.',
        },
        questionsDetected: questionRows.length,
        repeatedQuestionCount: repeatedQuestions.length,
        repeatedQuestionRows: repeatedQuestions.map(({creator, questionText, askerCount, videoCount}) => ({creator, questionText, askerCount, videoCount})),
        videoResults,
        estimatedCostUsd: null,
        billedEvents: null,
        costNote: 'Exact Apify billing/usage is not available authoritatively inside this Actor. Use the run billing/usage record for actual cost and billed events.',
    };

    await Actor.pushData(summary);
    await Actor.setValue('OUTPUT', summary);
    log.info('[FINAL] ' + JSON.stringify({ videosRequested: inputUrls.length, successfulVideos, failedVideos, totalComments, repeatedQuestions: repeatedQuestions.length }));
} catch (error) {
    exitCode = 1;
    const summary = {
        recordType: 'RUN_SUMMARY',
        status: 'failed',
        version: VERSION,
        error: error.message,
        estimatedCostUsd: null,
        billedEvents: null,
        costNote: 'Exact Apify billing/usage is not available authoritatively inside this Actor.',
    };
    log.error(`[FATAL] ${error.stack ?? error.message}`);
    try {
        await Actor.pushData(summary);
        await Actor.setValue('OUTPUT', summary);
    } catch (writeError) {
        log.error(`[FATAL OUTPUT] ${writeError.message}`);
    }
} finally {
    await Actor.exit({ exitCode });
}