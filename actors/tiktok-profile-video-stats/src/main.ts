import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

await Actor.init();

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type Mode = 'full' | 'profileOnly';

type ProfileStatus =
    | 'ok'
    | 'not_found'
    | 'private'
    | 'blocked'
    | 'skipped_followers_out_of_range'
    | 'error';

type CandidateParseStatus = 'parsed' | 'failed';

interface Input {
    usernames?: string[];
    videosPerProfile?: number;
    excludePinned?: boolean;
    mode?: Mode;
    minFollowers?: number;
    maxFollowers?: number;
    maxItems?: number;
    concurrency?: number;
    outputRows?: "summaryOnly" | "all";
}

interface ProfileData {
    username: string;
    displayName: string | null;
    secUid: string | null;
    userId: string | null;

    bio: string | null;
    bioLink: string | null;
    bioLinkDomain: string | null;

    emails: string[];
    contactText: string[];

    followers: number | null;
    following: number | null;
    likes: number | null;
    videos: number | null;

    verified: boolean | null;
    privateAccount: boolean | null;

    region: string | null;
    language: string | null;

    commerceUser: boolean | null;
    businessAccount: boolean | null;
    shop: boolean | null;

    avatarUrl: string | null;
}

interface VideoCandidate {
    id: string;
    createTime: number | null;
    isPinned: boolean | null;
}

interface VideoData {
    videoId: string;
    videoUrl: string;

    createdAt: string | null;
    createTime: number | null;

    caption: string | null;
    hashtags: string[];

    durationSeconds: number | null;

    isPinned: boolean | null;
    isSlideshow: boolean | null;
    isAd: boolean | null;

    plays: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    saves: number | null;

    soundName: string | null;

    sponsoredSignals: string[];
}

interface ParsedCandidate {
    candidate: VideoCandidate;
    status: CandidateParseStatus;
    video: VideoData | null;
    error: string | null;
}

interface SellingAnalysis {
    selling: boolean;
    sellingSignals: string[];
    managementEmailInBio: boolean;
}

interface FetchResult {
    ok: boolean;
    status: number | null;
    finalUrl: string | null;
    text: string | null;
    error: string | null;
}

interface SelectionInfo {
    selected: VideoData[];

    confirmedPinnedExcluded: string[];

    suspectedHighlightedExcluded: string[];

    failedCandidateIds: string[];

    ambiguousCandidateIds: string[];

    selectionReliable: boolean;
}

interface CoverageInfo {
    source: 'tiktok_creator_embed';

    requestedVideos: number;

    discoveredCandidates: number;
    parsedCandidates: number;
    failedCandidates: number;

    selectedVideos: number;
    analyzedVideos: number;

    confirmedPinnedExcluded: number;
    suspectedHighlightedExcluded: number;

    officialRecentVideoLimit: number;

    completeForRequestedCount: boolean;
    selectionReliable: boolean;
    pinStatusReliable: boolean;

    failedCandidateIds: string[];
    suspectedHighlightedVideoIds: string[];

    warnings: string[];
}

interface FetchOptions {
    referer?: string;
    maxRetries?: number;
    retryDelaysMs?: number[];
    label?: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/140.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 20_000;

/*
 * Normal pages retain bounded retries.
 */
const PAGE_MAX_RETRIES = 2;

/*
 * Creator embed is our discovery source, so it gets slightly more resilience.
 *
 * Initial request + 3 retries:
 * 429 -> 5 sec
 * 429 -> 10 sec
 * 429 -> 20 sec
 */
const EMBED_MAX_RETRIES = 3;

const EMBED_RETRY_DELAYS_MS = [
    15_000,
    30_000,
    60_000,
];

const DEFAULT_RETRY_DELAYS_MS = [
    15_000,
    30_000,
];

const VIDEO_PARSE_ATTEMPTS = 3;

const OFFICIAL_EMBED_RECENT_LIMIT = 10;

/*
 * This is NOT a pin detector.
 *
 * It is only used when excludePinned=true to prevent a single extremely old
 * highlighted candidate from contaminating a recent-video sample.
 *
 * We never set isPinned=true because of this heuristic.
 */
const HIGHLIGHT_GAP_MIN_DAYS = 45;
const HIGHLIGHT_AGE_RATIO = 3;

/* -------------------------------------------------------------------------- */
/* Shared TikTok request gate                                                 */
/* -------------------------------------------------------------------------- */

/*
 * TikTok rate limiting can apply to the Actor/IP rather than one individual
 * request. Therefore all workers share one cooldown.
 *
 * If worker A gets a 429, worker B must wait before making its next TikTok
 * request.
 */
let globalNextAllowedRequestAt = 0;
const MIN_REQUEST_SPACING_MS = 1_500;
let consecutive429 = 0;
let rateLimitCircuitOpen = false;
const MAX_CONSECUTIVE_429 = 2;

/*
 * Small promise-chain mutex so two workers cannot simultaneously pass the
 * gate at the exact same moment after a cooldown expires.
 *
 * This is not browser/fingerprint evasion. It simply coordinates our own
 * request rate after TikTok explicitly tells us to slow down.
 */
let requestGateQueue: Promise<void> = Promise.resolve();

let totalRateLimitResponses = 0;
let totalGlobalCooldowns = 0;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function activateGlobalCooldown(
    delayMs: number,
    url: string,
): void {
    const proposedUntil =
        Date.now() + delayMs;

    const previousUntil =
        globalNextAllowedRequestAt;

    globalNextAllowedRequestAt =
        Math.max(
            globalNextAllowedRequestAt,
            proposedUntil,
        );

    totalRateLimitResponses += 1;
    consecutive429 += 1;
    if (consecutive429 >= MAX_CONSECUTIVE_429) {
        rateLimitCircuitOpen = true;
        log.warning('[RATE LIMIT] Circuit opened after repeated 429 responses. Deferring remaining requests until a later run.');
    }

    if (
        globalNextAllowedRequestAt >
        previousUntil
    ) {
        totalGlobalCooldowns += 1;
    }

    log.warning(
        `[RATE LIMIT] TikTok returned 429 for ${url}. ` +
        `All workers paused for approximately ${Math.ceil(delayMs / 1000)}s.`,
    );
}

async function waitForGlobalRequestGate(): Promise<void> {
    const previous =
        requestGateQueue;

    let releaseGate!: () => void;

    requestGateQueue =
        new Promise<void>((resolve) => {
            releaseGate = resolve;
        });

    await previous;

    try {
        while (true) {
            const waitMs =
                globalNextAllowedRequestAt -
                Date.now();

            if (rateLimitCircuitOpen) return;
            if (waitMs <= 0) {
                globalNextAllowedRequestAt = Date.now() + MIN_REQUEST_SPACING_MS;
                return;
            }

            log.info(
                `[RATE LIMIT] Shared TikTok cooldown active — waiting ${Math.ceil(waitMs / 1000)}s before next request`,
            );

            await sleep(waitMs);
        }
    } finally {
        releaseGate();
    }
}

/* -------------------------------------------------------------------------- */
/* General helpers                                                            */
/* -------------------------------------------------------------------------- */

function clampInt(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
): number {
    const n = Number(value);

    if (!Number.isFinite(n)) return fallback;

    return Math.max(
        min,
        Math.min(max, Math.floor(n)),
    );
}

function normalizeUsername(value: string): string {
    let result = String(value ?? '').trim();

    result = result.replace(
        /^https?:\/\/(?:www\.)?tiktok\.com\//i,
        '',
    );

    result = result.replace(/^@/, '');

    result = result.split(/[/?#]/)[0] ?? '';

    return result.trim().toLowerCase();
}

function asRecord(
    value: unknown,
): Record<string, unknown> | null {
    if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
    ) {
        return value as Record<string, unknown>;
    }

    return null;
}

function asString(value: unknown): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || null;
    }

    if (
        typeof value === 'number' &&
        Number.isFinite(value)
    ) {
        return String(value);
    }

    return null;
}

function asNumber(value: unknown): number | null {
    if (
        typeof value === 'number' &&
        Number.isFinite(value)
    ) {
        return value;
    }

    if (
        typeof value === 'string' &&
        value.trim() !== ''
    ) {
        const parsed = Number(value);

        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return null;
}

function asBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value;

    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;

    return null;
}

function firstString(
    obj: Record<string, unknown> | null,
    keys: string[],
): string | null {
    if (!obj) return null;

    for (const key of keys) {
        const value = asString(obj[key]);

        if (value !== null) return value;
    }

    return null;
}

function firstNumber(
    obj: Record<string, unknown> | null,
    keys: string[],
): number | null {
    if (!obj) return null;

    for (const key of keys) {
        const value = asNumber(obj[key]);

        if (value !== null) return value;
    }

    return null;
}

function firstBoolean(
    obj: Record<string, unknown> | null,
    keys: string[],
): boolean | null {
    if (!obj) return null;

    for (const key of keys) {
        const value = asBoolean(obj[key]);

        if (value !== null) return value;
    }

    return null;
}

function median(
    values: Array<number | null>,
): number | null {
    const filtered = values
        .filter(
            (value): value is number =>
                typeof value === 'number' &&
                Number.isFinite(value),
        )
        .sort((a, b) => a - b);

    if (filtered.length === 0) return null;

    const middle = Math.floor(filtered.length / 2);

    if (filtered.length % 2 === 1) {
        return filtered[middle];
    }

    return (
        filtered[middle - 1] +
        filtered[middle]
    ) / 2;
}

function medianVideoIds(
    videos: VideoData[],
    metric: (video: VideoData) => number | null,
): string[] {
    const ranked = videos
        .map((video) => ({ videoId: video.videoId, value: metric(video) }))
        .filter((item): item is { videoId: string; value: number } =>
            typeof item.value === 'number' && Number.isFinite(item.value),
        )
        .sort((a, b) => a.value - b.value || a.videoId.localeCompare(b.videoId));

    if (ranked.length === 0) return [];

    const middle = Math.floor(ranked.length / 2);
    return ranked.length % 2 === 1
        ? [ranked[middle].videoId]
        : [ranked[middle - 1].videoId, ranked[middle].videoId];
}

function maxNullable(
    values: Array<number | null>,
): number | null {
    const filtered = values.filter(
        (value): value is number =>
            typeof value === 'number' &&
            Number.isFinite(value),
    );

    return filtered.length
        ? Math.max(...filtered)
        : null;
}

function round(
    value: number | null,
    digits = 2,
): number | null {
    if (
        value === null ||
        !Number.isFinite(value)
    ) {
        return null;
    }

    const multiplier = 10 ** digits;

    return (
        Math.round(value * multiplier) /
        multiplier
    );
}

function ratePer1000(
    numerator: number | null,
    denominator: number | null,
): number | null {
    if (
        numerator === null ||
        denominator === null ||
        denominator <= 0
    ) {
        return null;
    }

    return round(
        (numerator / denominator) * 1000,
        2,
    );
}

function safeIsoFromUnix(
    value: number | null,
): string | null {
    if (
        value === null ||
        !Number.isFinite(value) ||
        value <= 0
    ) {
        return null;
    }

    try {
        return new Date(value * 1000).toISOString();
    } catch {
        return null;
    }
}

function uniqueStrings(
    values: Array<string | null | undefined>,
): string[] {
    return [
        ...new Set(
            values
                .filter(
                    (value): value is string =>
                        typeof value === 'string',
                )
                .map((value) => value.trim())
                .filter(Boolean),
        ),
    ];
}

function getDomain(
    rawUrl: string | null,
): string | null {
    if (!rawUrl) return null;

    try {
        const url =
            rawUrl.startsWith('http://') ||
            rawUrl.startsWith('https://')
                ? new URL(rawUrl)
                : new URL(`https://${rawUrl}`);

        return url.hostname
            .replace(/^www\./i, '')
            .toLowerCase();
    } catch {
        return null;
    }
}

function daysBetween(
    newer: number,
    older: number,
): number {
    return Math.max(
        0,
        (newer - older) / 86400,
    );
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

const tiktokCookieJar = new CookieJar();
const tiktokClient = gotScraping.extend({ cookieJar: tiktokCookieJar, timeout: { request: 25000 }, throwHttpErrors: false, retry: { limit: 0 } });

async function fetchText(
    url: string,
    options: FetchOptions = {},
): Promise<FetchResult> {
    const maxRetries =
        options.maxRetries ??
        PAGE_MAX_RETRIES;

    const retryDelaysMs =
        options.retryDelaysMs ??
        DEFAULT_RETRY_DELAYS_MS;

    const label =
        options.label ??
        'HTTP';

    let lastError: string | null = null;
    let lastStatus: number | null = null;

    for (
        let attempt = 0;
        attempt <= maxRetries;
        attempt += 1
    ) {
        /*
         * Every TikTok request, regardless of worker, passes through the same
         * shared cooldown gate.
         */
        if (rateLimitCircuitOpen) {
            return { ok: false, status: 429, finalUrl: null, text: null,
                error: `${label}: rate-limited; deferred until a later run` };
        }
        await waitForGlobalRequestGate();
        if (rateLimitCircuitOpen) {
            return { ok: false, status: 429, finalUrl: null, text: null,
                error: `${label}: rate-limited; deferred until a later run` };
        }

        const controller =
            new AbortController();

        const timeout = setTimeout(
            () => controller.abort(),
            REQUEST_TIMEOUT_MS,
        );

        try {
            const response = await tiktokClient({
                url,
                method: 'GET',
                followRedirect: true,
                responseType: 'text',
                signal: controller.signal,
                headers: {
                    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
                    'accept-language': 'en-US,en;q=0.9',
                    ...(options.referer ? { referer: options.referer } : {}),
                },
            });
            const text = response.body;

            clearTimeout(timeout);

            lastStatus =
                response.statusCode;

            /*
             * 429 is special:
             *
             * Activate an Actor-wide cooldown. Do not independently sleep only
             * this worker, because that allowed the second worker to continue
             * hitting TikTok during the cooldown in the previous build.
             */
            if (response.statusCode === 429) {
                const retryAfter = response.headers['retry-after'];
                const seconds = retryAfter ? Number(retryAfter) : NaN;
                const dateDelay = retryAfter && !Number.isFinite(seconds)
                    ? Date.parse(retryAfter) - Date.now() : NaN;
                const serverDelay = Number.isFinite(seconds) ? seconds * 1000 : dateDelay;
                const fallbackDelay = retryDelaysMs[
                    Math.min(attempt, retryDelaysMs.length - 1)
                ] ?? 30_000;
                const delay = Number.isFinite(serverDelay) && serverDelay > 0
                    ? Math.min(Math.max(serverDelay, fallbackDelay), 120_000)
                    : fallbackDelay;
                activateGlobalCooldown(delay, url);
                if (rateLimitCircuitOpen || attempt >= maxRetries) {
                    return {
                        ok: false, status: 429, finalUrl: response.url, text,
                        error: `${label}: rate-limited; retry in a later run`,
                    };
                }
                continue;
            }
            consecutive429 = 0;

            /*
             * 5xx retries are local transport/server retries. We don't trigger
             * the global TikTok cooldown unless TikTok explicitly returns 429.
             */
            if (
                response.statusCode >= 500 &&
                attempt < maxRetries
            ) {
                const delay =
                    Math.min(
                        1_500 *
                            (attempt + 1),
                        5_000,
                    );

                log.warning(
                    `[${label}] HTTP ${response.statusCode} ${url} — retrying in ${delay} ms`,
                );

                await sleep(delay);

                continue;
            }

            return {
                ok: response.statusCode >= 200 && response.statusCode < 300,
                status:
                    response.statusCode,
                finalUrl:
                    response.url,
                text,
                error: null,
            };
        } catch (error) {
            clearTimeout(timeout);

            lastError =
                error instanceof Error
                    ? error.message
                    : String(error);

            if (
                attempt <
                maxRetries
            ) {
                const delay =
                    Math.min(
                        1_500 *
                            (attempt + 1),
                        5_000,
                    );

                log.warning(
                    `[${label}] ${lastError} — retrying ${url} in ${delay} ms`,
                );

                await sleep(delay);

                continue;
            }
        }
    }

    return {
        ok: false,
        status:
            lastStatus,
        finalUrl: null,
        text: null,
        error:
            lastError ??
            `${label}: unknown fetch error`,
    };
}

/* -------------------------------------------------------------------------- */
/* JSON extraction                                                            */
/* -------------------------------------------------------------------------- */

function extractScriptJson(
    html: string,
    scriptId: string,
): unknown | null {
    const escaped =
        scriptId.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
        );

    const regex =
        new RegExp(
            `<script[^>]+id=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/script>`,
            'i',
        );

    const match =
        html.match(regex);

    if (!match?.[1]) return null;

    try {
        return JSON.parse(
            match[1],
        );
    } catch {
        return null;
    }
}

function extractAllJsonRoots(
    html: string,
): unknown[] {
    const roots: unknown[] = [];

    const knownIds = [
        '__UNIVERSAL_DATA_FOR_REHYDRATION__',
        'SIGI_STATE',
        '__NEXT_DATA__',
    ];

    for (const id of knownIds) {
        const value =
            extractScriptJson(
                html,
                id,
            );

        if (value !== null) {
            roots.push(value);
        }
    }

    const scriptRegex =
        /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;

    let match:
        RegExpExecArray | null;

    while (
        (
            match =
                scriptRegex.exec(
                    html,
                )
        ) !== null
    ) {
        try {
            roots.push(
                JSON.parse(
                    match[1],
                ),
            );
        } catch {
            // Ignore invalid JSON.
        }
    }

    return roots;
}

function findObjects(
    value: unknown,
    predicate: (
        obj: Record<string, unknown>,
    ) => boolean,
    output:
        Record<string, unknown>[] = [],
    depth = 0,
): Record<string, unknown>[] {
    if (
        value === null ||
        value === undefined ||
        depth > 20
    ) {
        return output;
    }

    if (Array.isArray(value)) {
        for (const child of value) {
            findObjects(
                child,
                predicate,
                output,
                depth + 1,
            );
        }

        return output;
    }

    const obj =
        asRecord(value);

    if (!obj) return output;

    if (predicate(obj)) {
        output.push(obj);
    }

    for (
        const child of
        Object.values(obj)
    ) {
        findObjects(
            child,
            predicate,
            output,
            depth + 1,
        );
    }

    return output;
}

/* -------------------------------------------------------------------------- */
/* Contacts                                                                   */
/* -------------------------------------------------------------------------- */

function extractContacts(
    text: string | null,
): {
    emails: string[];
    contactText: string[];
} {
    if (!text) {
        return {
            emails: [],
            contactText: [],
        };
    }

    const emailRegex =
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

    const emailLikeRegex =
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\b/gi;

    const emails =
        uniqueStrings(
            text.match(
                emailRegex,
            ) ?? [],
        ).map(
            (email) =>
                email.toLowerCase(),
        );

    const validSet =
        new Set(
            emails.map(
                (email) =>
                    email.toLowerCase(),
            ),
        );

    const contactText =
        uniqueStrings(
            text.match(
                emailLikeRegex,
            ) ?? [],
        ).filter(
            (value) =>
                !validSet.has(
                    value.toLowerCase(),
                ),
        );

    return {
        emails,
        contactText,
    };
}

/* -------------------------------------------------------------------------- */
/* Profile                                                                    */
/* -------------------------------------------------------------------------- */

function parseProfile(
    username: string,
    html: string,
): ProfileData | null {
    const roots =
        extractAllJsonRoots(
            html,
        );

    if (
        roots.length === 0
    ) {
        return null;
    }

    let user:
        Record<string, unknown> | null =
        null;

    for (const root of roots) {
        const matches =
            findObjects(
                root,
                (obj) => {
                    const uniqueId =
                        firstString(
                            obj,
                            [
                                'uniqueId',
                                'unique_id',
                                'username',
                            ],
                        );

                    return (
                        uniqueId?.toLowerCase() ===
                        username.toLowerCase()
                    );
                },
            );

        if (matches.length > 0) {
            user = matches[0];
            break;
        }
    }

    if (!user) {
        for (const root of roots) {
            const fallback =
                findObjects(
                    root,
                    (obj) =>
                        firstString(
                            obj,
                            [
                                'uniqueId',
                            ],
                        ) !==
                            null &&
                        (
                            'nickname' in
                                obj ||
                            'signature' in
                                obj ||
                            'secUid' in
                                obj
                        ),
                );

            if (
                fallback.length >
                0
            ) {
                user =
                    fallback[0];

                break;
            }
        }
    }

    if (!user) return null;

    let stats:
        Record<string, unknown> | null =
        null;

    for (const root of roots) {
        const candidates =
            findObjects(
                root,
                (obj) =>
                    'followerCount' in
                        obj ||
                    'followingCount' in
                        obj ||
                    'heartCount' in
                        obj ||
                    'videoCount' in
                        obj,
            );

        for (
            const candidate of
            candidates
        ) {
            if (
                firstNumber(
                    candidate,
                    [
                        'followerCount',
                    ],
                ) !== null
            ) {
                stats =
                    candidate;
                break;
            }
        }

        if (stats) break;
    }

    const bio =
        firstString(
            user,
            [
                'signature',
                'bio',
                'bioDescription',
            ],
        );

    let bioLink:
        string | null = null;

    const bioLinkObj =
        asRecord(
            user['bioLink'],
        );

    if (bioLinkObj) {
        bioLink =
            firstString(
                bioLinkObj,
                [
                    'link',
                    'url',
                ],
            );
    }

    bioLink =
        bioLink ??
        firstString(
            user,
            [
                'bioLink',
                'bio_link',
                'website',
            ],
        );

    const contacts =
        extractContacts(bio);

    return {
        username:
            firstString(
                user,
                [
                    'uniqueId',
                    'username',
                ],
            ) ??
            username,

        displayName:
            firstString(
                user,
                [
                    'nickname',
                    'displayName',
                ],
            ),

        secUid:
            firstString(
                user,
                [
                    'secUid',
                    'sec_uid',
                ],
            ),

        userId:
            firstString(
                user,
                [
                    'id',
                    'uid',
                ],
            ),

        bio,

        bioLink,

        bioLinkDomain:
            getDomain(
                bioLink,
            ),

        emails:
            contacts.emails,

        contactText:
            contacts.contactText,

        followers:
            firstNumber(
                stats,
                [
                    'followerCount',
                    'followers',
                ],
            ),

        following:
            firstNumber(
                stats,
                [
                    'followingCount',
                    'following',
                ],
            ),

        likes:
            firstNumber(
                stats,
                [
                    'heartCount',
                    'heart',
                    'diggCount',
                ],
            ),

        videos:
            firstNumber(
                stats,
                [
                    'videoCount',
                    'videos',
                ],
            ),

        verified:
            firstBoolean(
                user,
                ['verified'],
            ),

        privateAccount:
            firstBoolean(
                user,
                [
                    'privateAccount',
                    'private_account',
                ],
            ),

        region:
            firstString(
                user,
                ['region'],
            ),

        language:
            firstString(
                user,
                [
                    'language',
                    'languageCode',
                ],
            ),

        commerceUser:
            firstBoolean(
                user,
                [
                    'commerceUserInfo',
                    'commerceUser',
                ],
            ),

        businessAccount:
            firstBoolean(
                user,
                [
                    'isBusinessAccount',
                    'businessAccount',
                ],
            ),

        shop:
            firstBoolean(
                user,
                [
                    'ttSeller',
                    'isShop',
                    'shop',
                ],
            ),

        avatarUrl:
            firstString(
                user,
                [
                    'avatarLarger',
                    'avatarMedium',
                    'avatarThumb',
                ],
            ),
    };
}

function classifyMissingProfile(
    html: string,
    status: number | null,
): ProfileStatus {
    const lower =
        html.toLowerCase();

    if (
        status === 404 ||
        lower.includes(
            '"statuscode":10221',
        ) ||
        lower.includes(
            '"status_code":10221',
        ) ||
        lower.includes(
            'couldn\'t find this account',
        ) ||
        lower.includes(
            'could not find this account',
        )
    ) {
        return 'not_found';
    }

    if (
        lower.includes(
            'private account',
        ) ||
        lower.includes(
            '"privateaccount":true',
        ) ||
        lower.includes(
            '"private_account":true',
        )
    ) {
        return 'private';
    }

    if (
        status === 403 ||
        status === 429 ||
        html.length === 0
    ) {
        return 'blocked';
    }

    return 'error';
}

/* -------------------------------------------------------------------------- */
/* Embed discovery                                                            */
/* -------------------------------------------------------------------------- */

function collectEmbedCandidates(
    value: unknown,
    output:
        Map<
            string,
            VideoCandidate
        >,
    depth = 0,
): void {
    if (
        value === null ||
        value === undefined ||
        depth > 20
    ) {
        return;
    }

    if (Array.isArray(value)) {
        for (const child of value) {
            collectEmbedCandidates(
                child,
                output,
                depth + 1,
            );
        }

        return;
    }

    const obj =
        asRecord(value);

    if (!obj) return;

    const id =
        firstString(
            obj,
            [
                'id',
                'awemeId',
                'aweme_id',
                'itemId',
                'videoId',
            ],
        );

    if (
        id &&
        /^\d{15,25}$/.test(
            id,
        )
    ) {
        const videoLike =
            'video' in obj ||
            'stats' in obj ||
            'statistics' in
                obj ||
            'desc' in obj ||
            'createTime' in
                obj ||
            'create_time' in
                obj ||
            'author' in obj ||
            'music' in obj ||
            'isPinnedItem' in
                obj ||
            'isPinned' in obj;

        if (videoLike) {
            const createTime =
                firstNumber(
                    obj,
                    [
                        'createTime',
                        'create_time',
                    ],
                );

            const isPinned =
                firstBoolean(
                    obj,
                    [
                        'isPinnedItem',
                        'isPinned',
                        'pinned',
                    ],
                );

            const previous =
                output.get(id);

            output.set(
                id,
                {
                    id,

                    createTime:
                        createTime ??
                        previous?.createTime ??
                        null,

                    isPinned:
                        isPinned ??
                        previous?.isPinned ??
                        null,
                },
            );
        }
    }

    for (
        const child of
        Object.values(obj)
    ) {
        collectEmbedCandidates(
            child,
            output,
            depth + 1,
        );
    }
}

function parseEmbedCandidates(
    html: string,
): VideoCandidate[] {
    const roots =
        extractAllJsonRoots(
            html,
        );

    const candidates =
        new Map<
            string,
            VideoCandidate
        >();

    for (const root of roots) {
        collectEmbedCandidates(
            root,
            candidates,
        );
    }

    return [
        ...candidates.values(),
    ].sort(
        (a, b) =>
            (b.createTime ??
                0) -
            (a.createTime ??
                0),
    );
}

/* -------------------------------------------------------------------------- */
/* Video parsing                                                              */
/* -------------------------------------------------------------------------- */

function extractHashtags(
    caption: string | null,
): string[] {
    if (!caption) return [];

    const matches =
        caption.match(
            /#[\p{L}\p{N}_]+/gu,
        ) ?? [];

    return uniqueStrings(
        matches.map(
            (tag) =>
                tag
                    .slice(1)
                    .toLowerCase(),
        ),
    );
}

function detectSponsoredSignals(
    caption: string | null,
): string[] {
    if (!caption) return [];

    const text =
        caption.toLowerCase();

    const signals:
        string[] = [];

    if (
        /(^|\s)#(?:ad|advertisement)(?=\s|$|[.,!?])/i.test(
            text,
        )
    ) {
        signals.push(
            'ad_hashtag',
        );
    }

    if (
        /\b(?:sponsored|paid partnership|paid promotion)\b/i.test(
            text,
        )
    ) {
        signals.push(
            'sponsored',
        );
    }

    if (
        /\b(?:use|with)\s+(?:my\s+)?code\s+[a-z0-9_-]{3,}\b/i.test(
            text,
        ) ||
        /\b(?:discount|promo)\s+code\b/i.test(
            text,
        )
    ) {
        signals.push(
            'discount_code',
        );
    }

    if (
        /\b(?:affiliate|commissionable)\b/i.test(
            text,
        )
    ) {
        signals.push(
            'affiliate',
        );
    }

    return uniqueStrings(
        signals,
    );
}

function scoreVideoObject(
    obj: Record<string, unknown>,
    videoId: string,
): number {
    let score = 0;

    const id =
        firstString(
            obj,
            [
                'id',
                'awemeId',
                'aweme_id',
                'itemId',
                'videoId',
            ],
        );

    if (id === videoId) {
        score += 100;
    } else if (id) {
        return -1000;
    }

    if (
        'stats' in obj ||
        'statistics' in obj
    ) {
        score += 20;
    }

    if ('video' in obj) {
        score += 15;
    }

    if (
        'desc' in obj ||
        'caption' in obj
    ) {
        score += 10;
    }

    if (
        'createTime' in obj ||
        'create_time' in obj
    ) {
        score += 10;
    }

    if ('author' in obj) {
        score += 5;
    }

    return score;
}

function chooseVideoObject(
    roots: unknown[],
    videoId: string,
): Record<string, unknown> | null {
    let best:
        Record<string, unknown> | null =
        null;

    let bestScore =
        -Infinity;

    for (const root of roots) {
        const objects =
            findObjects(
                root,
                () => true,
            );

        for (
            const obj of objects
        ) {
            const score =
                scoreVideoObject(
                    obj,
                    videoId,
                );

            if (
                score >
                bestScore
            ) {
                bestScore =
                    score;

                best = obj;
            }
        }
    }

    if (
        best &&
        bestScore >= 100
    ) {
        return best;
    }

    return null;
}

function parseVideo(
    username: string,
    videoId: string,
    html: string,
    candidatePin: boolean | null,
    candidateCreateTime: number | null,
): VideoData | null {
    const roots =
        extractAllJsonRoots(
            html,
        );

    if (
        roots.length === 0
    ) {
        return null;
    }

    const item =
        chooseVideoObject(
            roots,
            videoId,
        );

    if (!item) {
        return null;
    }

    const stats =
        asRecord(
            item['stats'],
        ) ??
        asRecord(
            item['statistics'],
        );

    const video =
        asRecord(
            item['video'],
        );

    const music =
        asRecord(
            item['music'],
        );

    const caption =
        firstString(
            item,
            [
                'desc',
                'caption',
                'description',
            ],
        );

    const createTime =
        firstNumber(
            item,
            [
                'createTime',
                'create_time',
            ],
        ) ??
        candidateCreateTime;

    const imagePost =
        item['imagePost'] ??
        item['imagePostInfo'] ??
        item['images'];

    const isSlideshow =
        imagePost !==
            undefined &&
        imagePost !== null
            ? true
            : firstBoolean(
                  item,
                  [
                      'isPhoto',
                      'isSlideshow',
                  ],
              );

    const pagePin =
        firstBoolean(
            item,
            [
                'isPinnedItem',
                'isPinned',
                'pinned',
            ],
        );

    const isAd =
        firstBoolean(
            item,
            [
                'isAd',
                'is_ad',
                'isSponsored',
            ],
        );

    const sponsoredSignals =
        detectSponsoredSignals(
            caption,
        );

    if (isAd === true) {
        sponsoredSignals.push(
            'tiktok_ad_flag',
        );
    }

    return {
        videoId,

        videoUrl:
            `https://www.tiktok.com/@${username}/video/${videoId}`,

        createdAt:
            safeIsoFromUnix(
                createTime,
            ),

        createTime,

        caption,

        hashtags:
            extractHashtags(
                caption,
            ),

        durationSeconds:
            firstNumber(
                video,
                [
                    'duration',
                    'durationSeconds',
                ],
            ),

        isPinned:
            pagePin ??
            candidatePin ??
            null,

        isSlideshow:
            isSlideshow ??
            null,

        isAd:
            isAd ??
            (
                sponsoredSignals.length >
                0
                    ? true
                    : null
            ),

        plays:
            firstNumber(
                stats,
                [
                    'playCount',
                    'viewCount',
                    'plays',
                ],
            ),

        likes:
            firstNumber(
                stats,
                [
                    'diggCount',
                    'likeCount',
                    'likes',
                ],
            ),

        comments:
            firstNumber(
                stats,
                [
                    'commentCount',
                    'comments',
                ],
            ),

        shares:
            firstNumber(
                stats,
                [
                    'shareCount',
                    'shares',
                ],
            ),

        saves:
            firstNumber(
                stats,
                [
                    'collectCount',
                    'saveCount',
                    'favoriteCount',
                    'saves',
                ],
            ),

        soundName:
            firstString(
                music,
                [
                    'title',
                    'musicName',
                    'name',
                ],
            ),

        sponsoredSignals:
            uniqueStrings(
                sponsoredSignals,
            ),
    };
}

async function fetchAndParseVideo(
    username: string,
    profileUrl: string,
    candidate: VideoCandidate,
): Promise<ParsedCandidate> {
    const videoUrl =
        `https://www.tiktok.com/@${username}/video/${candidate.id}`;

    let lastError:
        string | null = null;

    for (
        let parseAttempt = 1;
        parseAttempt <= VIDEO_PARSE_ATTEMPTS;
        parseAttempt += 1
    ) {
        const response =
            await fetchText(
                videoUrl,
                {
                    referer:
                        profileUrl,

                    /*
                     * One internal HTTP retry is enough here because this outer
                     * parser loop already gives us three page attempts.
                     */
                    maxRetries: 1,

                    retryDelaysMs: [
                        5_000,
                    ],

                    label:
                        'VIDEO',
                },
            );

        if (
            response.ok &&
            response.text
        ) {
            const video =
                parseVideo(
                    username,
                    candidate.id,
                    response.text,
                    candidate.isPinned,
                    candidate.createTime,
                );

            if (video) {
                if (
                    parseAttempt > 1
                ) {
                    log.info(
                        `[VIDEO] Recovered @${username}/${candidate.id} on parse attempt ${parseAttempt}`,
                    );
                }

                return {
                    candidate,
                    status:
                        'parsed',
                    video,
                    error: null,
                };
            }

            lastError =
                `HTTP ${response.status}: page loaded but no matching TikTok video object was found`;
        } else {
            lastError =
                response.error ??
                `HTTP ${response.status ?? 'unknown'}`;
        }

        if (response.status === 429 || rateLimitCircuitOpen) break;
        if (
            parseAttempt <
            VIDEO_PARSE_ATTEMPTS
        ) {
            const delay =
                750 *
                parseAttempt;

            log.warning(
                `[VIDEO] Could not parse @${username}/${candidate.id} — parse retry ${parseAttempt}/${VIDEO_PARSE_ATTEMPTS - 1} in ${delay} ms`,
            );

            await sleep(delay);
        }
    }

    return {
        candidate,
        status: 'failed',
        video: null,
        error:
            lastError ??
            'Unknown video parse failure',
    };
}

/* -------------------------------------------------------------------------- */
/* Candidate selection                                                        */
/* -------------------------------------------------------------------------- */

function identifySuspectedHighlightedVideos(
    videos: VideoData[],
): Set<string> {
    const result =
        new Set<string>();

    const dated =
        videos
            .filter(
                (
                    video,
                ): video is VideoData & {
                    createTime: number;
                } =>
                    typeof video.createTime ===
                        'number' &&
                    video.createTime >
                        0,
            )
            .sort(
                (a, b) =>
                    b.createTime -
                    a.createTime,
            );

    if (
        dated.length < 6
    ) {
        return result;
    }

    const newest =
        dated[0].createTime;

    const recentCount =
        Math.max(
            5,
            Math.ceil(
                dated.length *
                    0.7,
            ),
        );

    const recent =
        dated.slice(
            0,
            recentCount,
        );

    const recentOldest =
        recent[
            recent.length - 1
        ].createTime;

    const normalRecentSpanDays =
        Math.max(
            1,
            daysBetween(
                newest,
                recentOldest,
            ),
        );

    const minimumOldAgeDays =
        Math.max(
            HIGHLIGHT_GAP_MIN_DAYS,
            normalRecentSpanDays *
                HIGHLIGHT_AGE_RATIO,
        );

    for (
        let index = 0;
        index < dated.length;
        index += 1
    ) {
        const video =
            dated[index];

        const ageDays =
            daysBetween(
                newest,
                video.createTime,
            );

        if (
            ageDays <
            minimumOldAgeDays
        ) {
            continue;
        }

        if (index <= 0) {
            continue;
        }

        const nextNewer =
            dated[
                index - 1
            ];

        const gapDays =
            daysBetween(
                nextNewer.createTime,
                video.createTime,
            );

        const requiredGap =
            Math.max(
                HIGHLIGHT_GAP_MIN_DAYS,
                normalRecentSpanDays *
                    1.5,
            );

        if (
            gapDays >=
            requiredGap
        ) {
            result.add(
                video.videoId,
            );
        }
    }

    return result;
}

function selectVideos(
    parsedCandidates:
        ParsedCandidate[],
    requestedVideos: number,
    excludePinned: boolean,
): SelectionInfo {
    const parsed =
        parsedCandidates
            .filter(
                (
                    item,
                ): item is ParsedCandidate & {
                    video: VideoData;
                } =>
                    item.status ===
                        'parsed' &&
                    item.video !==
                        null,
            )
            .map(
                (item) =>
                    item.video,
            );

    const failed =
        parsedCandidates.filter(
            (item) =>
                item.status ===
                'failed',
        );

    parsed.sort(
        (a, b) =>
            (b.createTime ??
                0) -
            (a.createTime ??
                0),
    );

    const confirmedPinned =
        new Set<string>();

    if (excludePinned) {
        for (
            const video of
            parsed
        ) {
            if (
                video.isPinned ===
                true
            ) {
                confirmedPinned.add(
                    video.videoId,
                );
            }
        }
    }

    let eligible =
        parsed.filter(
            (video) =>
                !confirmedPinned.has(
                    video.videoId,
                ),
        );

    const suspectedHighlighted =
        excludePinned
            ? identifySuspectedHighlightedVideos(
                  eligible,
              )
            : new Set<string>();

    if (excludePinned) {
        eligible =
            eligible.filter(
                (video) =>
                    !suspectedHighlighted.has(
                        video.videoId,
                    ),
            );
    }

    eligible.sort(
        (a, b) =>
            (b.createTime ??
                0) -
            (a.createTime ??
                0),
    );

    const selected =
        eligible.slice(
            0,
            requestedVideos,
        );

    const ambiguousCandidateIds:
        string[] = [];

    const selectionBoundary =
        selected.length > 0
            ? selected[
                  selected.length -
                      1
              ].createTime
            : null;

    for (const item of failed) {
        const candidateTime =
            item.candidate
                .createTime;

        if (
            candidateTime ===
                null ||
            selectionBoundary ===
                null ||
            candidateTime >=
                selectionBoundary
        ) {
            ambiguousCandidateIds.push(
                item.candidate.id,
            );
        }
    }

    const enoughVideos =
        selected.length >=
        requestedVideos;

    const selectionReliable =
        enoughVideos &&
        ambiguousCandidateIds.length ===
            0;

    return {
        selected,

        confirmedPinnedExcluded:
            [
                ...confirmedPinned,
            ],

        suspectedHighlightedExcluded:
            [
                ...suspectedHighlighted,
            ],

        failedCandidateIds:
            failed.map(
                (item) =>
                    item.candidate.id,
            ),

        ambiguousCandidateIds,

        selectionReliable,
    };
}

/* -------------------------------------------------------------------------- */
/* Selling                                                                    */
/* -------------------------------------------------------------------------- */

function analyzeSelling(
    profile: ProfileData,
    videos: VideoData[],
): SellingAnalysis {
    const signals =
        new Set<string>();

    const bio =
        profile.bio ?? '';

    const lower =
        bio.toLowerCase();

    const commercePatterns:
        Array<
            [RegExp, string]
        > = [
        [
            /\b(?:shop|store|shop my|shop here)\b/i,
            'bio_shop_language',
        ],
        [
            /\b(?:use|with)\s+(?:my\s+)?code\s+[a-z0-9_-]{3,}\b/i,
            'bio_discount_code',
        ],
        [
            /\b(?:discount|promo)\s+code\b/i,
            'bio_discount_code',
        ],
        [
            /\b(?:affiliate|commissionable)\b/i,
            'bio_affiliate',
        ],
        [
            /\b(?:amazon storefront|ltk|shopmy)\b/i,
            'bio_storefront',
        ],
        [
            /\b(?:book now|appointments?|booking)\b/i,
            'bio_booking',
        ],
        [
            /\b(?:buy|purchase|order)\s+(?:here|now|below)\b/i,
            'bio_purchase_cta',
        ],
    ];

    for (
        const [
            pattern,
            signal,
        ] of commercePatterns
    ) {
        if (
            pattern.test(
                lower,
            )
        ) {
            signals.add(
                signal,
            );
        }
    }

    if (
        profile.commerceUser ===
        true
    ) {
        signals.add(
            'tiktok_commerce_user',
        );
    }

    if (
        profile.shop === true
    ) {
        signals.add(
            'tiktok_shop',
        );
    }

    for (
        const video of videos
    ) {
        for (
            const signal of
            video.sponsoredSignals
        ) {
            signals.add(
                signal,
            );
        }
    }

    const managementEmailInBio =
        profile.emails.some(
            (email) =>
                /(?:management|manager|mgmt|talent|agency|business|booking|collab)/i.test(
                    email,
                ),
        ) ||
        /\b(?:management|manager|mgmt|talent|agency|business inquiries?|booking|collabs?)\b/i.test(
            bio,
        );

    return {
        selling:
            signals.size > 0,

        sellingSignals:
            [...signals],

        managementEmailInBio,
    };
}

/* -------------------------------------------------------------------------- */
/* Coverage                                                                   */
/* -------------------------------------------------------------------------- */

function buildCoverage(
    requestedVideos: number,
    discoveredCandidates: number,
    parsedCandidates:
        ParsedCandidate[],
    selection:
        SelectionInfo,
    excludePinned: boolean,
): CoverageInfo {
    const warnings:
        string[] = [];

    const parsedCount =
        parsedCandidates.filter(
            (item) =>
                item.status ===
                'parsed',
        ).length;

    const failedCount =
        parsedCandidates.filter(
            (item) =>
                item.status ===
                'failed',
        ).length;

    if (
        requestedVideos >
        OFFICIAL_EMBED_RECENT_LIMIT
    ) {
        warnings.push(
            `Requested ${requestedVideos} videos, but the public TikTok creator embed officially exposes only up to ${OFFICIAL_EMBED_RECENT_LIMIT} recent videos. Complete coverage above that number cannot be guaranteed.`,
        );
    }

    if (
        failedCount > 0
    ) {
        warnings.push(
            `${failedCount} discovered candidate video(s) could not be parsed: ${selection.failedCandidateIds.join(', ')}.`,
        );
    }

    if (
        selection.ambiguousCandidateIds
            .length > 0
    ) {
        warnings.push(
            `Newest-video completeness is uncertain because failed candidate(s) could fall inside the requested recent-video window: ${selection.ambiguousCandidateIds.join(', ')}.`,
        );
    }

    if (
        selection
            .confirmedPinnedExcluded
            .length > 0
    ) {
        warnings.push(
            `${selection.confirmedPinnedExcluded.length} video(s) explicitly identified by TikTok as pinned were excluded.`,
        );
    }

    if (
        selection
            .suspectedHighlightedExcluded
            .length > 0
    ) {
        warnings.push(
            `${selection.suspectedHighlightedExcluded.length} isolated old embed candidate(s) were excluded from the recent-video sample because they were separated from the recent posting window by a large date gap. They are reported as suspected highlighted videos, not asserted to be pinned.`,
        );
    }

    if (
        selection.selected.length <
        Math.min(
            requestedVideos,
            OFFICIAL_EMBED_RECENT_LIMIT,
        )
    ) {
        warnings.push(
            `Only ${selection.selected.length} usable recent video(s) were selected from ${discoveredCandidates} discovered candidate(s).`,
        );
    }

    const pinUnknown =
        selection.selected.some(
            (video) =>
                video.isPinned ===
                null,
        );

    if (
        excludePinned &&
        pinUnknown
    ) {
        warnings.push(
            'TikTok did not expose a reliable pin flag for every selected video. Unknown pin state remains null rather than being treated as false.',
        );
    }

    const completeForRequestedCount =
        requestedVideos <=
            OFFICIAL_EMBED_RECENT_LIMIT &&
        selection.selected.length >=
            requestedVideos &&
        selection.selectionReliable;

    return {
        source:
            'tiktok_creator_embed',

        requestedVideos,

        discoveredCandidates,

        parsedCandidates:
            parsedCount,

        failedCandidates:
            failedCount,

        selectedVideos:
            selection.selected
                .length,

        analyzedVideos:
            selection.selected
                .length,

        confirmedPinnedExcluded:
            selection
                .confirmedPinnedExcluded
                .length,

        suspectedHighlightedExcluded:
            selection
                .suspectedHighlightedExcluded
                .length,

        officialRecentVideoLimit:
            OFFICIAL_EMBED_RECENT_LIMIT,

        completeForRequestedCount,

        selectionReliable:
            selection.selectionReliable,

        pinStatusReliable:
            !pinUnknown,

        failedCandidateIds:
            selection
                .failedCandidateIds,

        suspectedHighlightedVideoIds:
            selection
                .suspectedHighlightedExcluded,

        warnings,
    };
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

function buildSummary(
    profile: ProfileData,
    videos: VideoData[],
    selling: SellingAnalysis,
    coverage: CoverageInfo,
) {
    const plays =
        videos.map(
            (video) =>
                video.plays,
        );

    const comments =
        videos.map(
            (video) =>
                video.comments,
        );

    const likes =
        videos.map(
            (video) =>
                video.likes,
        );

    const shares =
        videos.map(
            (video) =>
                video.shares,
        );

    const saves =
        videos.map(
            (video) =>
                video.saves,
        );

    const medianPlays =
        median(plays);

    const medianComments =
        median(comments);

    const medianLikes =
        median(likes);

    const medianShares =
        median(shares);

    const medianSaves =
        median(saves);

    const medianVideoIdsByPlays =
        medianVideoIds(videos, (video) => video.plays);

    const medianVideoIdsByComments =
        medianVideoIds(videos, (video) => video.comments);

    const sortedDates =
        videos
            .map(
                (video) =>
                    video.createTime,
            )
            .filter(
                (
                    value,
                ): value is number =>
                    typeof value ===
                        'number' &&
                    value > 0,
            )
            .sort(
                (a, b) =>
                    b - a,
            );

    let postsPerWeek:
        number | null =
        null;

    /*
     * Cadence uses the median gap between adjacent sampled posts instead of
     * the full newest-to-oldest span. This is robust to one isolated old
     * highlighted/pinned candidate contaminating an otherwise recent sample
     * (the cause of implausibly tiny values such as ~0.04 posts/week).
     */
    const postingGapDays: number[] = [];

    for (let i = 0; i + 1 < sortedDates.length; i++) {
        const gapDays =
            (sortedDates[i] - sortedDates[i + 1]) / 86400;

        if (gapDays > 0 && Number.isFinite(gapDays)) {
            postingGapDays.push(gapDays);
        }
    }

    const medianPostingGapDays =
        median(postingGapDays);

    if (medianPostingGapDays && medianPostingGapDays > 0) {
        postsPerWeek =
            round(7 / medianPostingGapDays, 2);
    }

    let daysSinceLastPost:
        number | null =
        null;

    if (
        sortedDates.length > 0
    ) {
        daysSinceLastPost =
            round(
                Math.max(
                    0,
                    Date.now() /
                        1000 -
                        sortedDates[0],
                ) /
                    86400,
                1,
            );
    }

    const sponsoredCount =
        videos.filter(
            (video) =>
                video.isAd ===
                    true ||
                video
                    .sponsoredSignals
                    .length > 0,
        ).length;

    const topVideosByComments =
        [...videos]
            .sort(
                (a, b) =>
                    (b.comments ??
                        -1) -
                    (a.comments ??
                        -1),
            )
            .slice(
                0,
                5,
            )
            .map(
                (video) => ({
                    videoId:
                        video.videoId,

                    videoUrl:
                        video.videoUrl,

                    comments:
                        video.comments,

                    saves:
                        video.saves,

                    plays:
                        video.plays,

                    createdAt:
                        video.createdAt,

                    caption:
                        video.caption,
                }),
            );

    const totalComments =
        comments.reduce<number>(
            (
                sum,
                value,
            ) =>
                sum +
                (value ?? 0),
            0,
        );

    const totalShares =
        shares.reduce<number>(
            (
                sum,
                value,
            ) =>
                sum +
                (value ?? 0),
            0,
        );

    const totalSaves =
        saves.reduce<number>(
            (
                sum,
                value,
            ) =>
                sum +
                (value ?? 0),
            0,
        );

    const totalPlays =
        plays.reduce<number>(
            (
                sum,
                value,
            ) =>
                sum +
                (value ?? 0),
            0,
        );

    return {
        videosAnalyzed:
            videos.length,

        medianPlays:
            round(
                medianPlays,
                1,
            ),

        medianComments:
            round(
                medianComments,
                1,
            ),

        medianLikes:
            round(
                medianLikes,
                1,
            ),

        medianShares:
            round(
                medianShares,
                1,
            ),

        medianSaves:
            round(
                medianSaves,
                1,
            ),

        medianVideoIdsByPlays,

        medianVideoIdsByComments,

        maxComments:
            maxNullable(
                comments,
            ),

        maxPlays:
            maxNullable(
                plays,
            ),

        medianPlaysPctFollowers:
            profile.followers &&
            profile.followers > 0 &&
            medianPlays !== null
                ? round(
                      (
                          medianPlays /
                          profile.followers
                      ) *
                          100,
                      2,
                  )
                : null,

        commentsPer1KPlays:
            ratePer1000(
                totalComments,
                totalPlays,
            ),

        savesPer1KPlays:
            ratePer1000(
                totalSaves,
                totalPlays,
            ),

        sharesPer1KPlays:
            ratePer1000(
                totalShares,
                totalPlays,
            ),

        sponsoredCount,

        sponsoredPct:
            videos.length > 0
                ? round(
                      (
                          sponsoredCount /
                          videos.length
                      ) *
                          100,
                      1,
                  )
                : null,

        postsPerWeek,
        postingAnomaly: postsPerWeek !== null && postsPerWeek > 20,
        postsInLast30Days: sortedDates.filter(date => date >= Date.now()/1000 - 30*86400).length,
        postingFrequencyLast30DaysPerWeek: round(sortedDates.filter(date => date >= Date.now()/1000 - 30*86400).length * 7/30, 2),
        postingFrequencyCoverage: 'sampled_public_recent_videos_only',
        topVideoSelectionCoverage: videos.length >= 30 ? '30_or_more' : 'partial_under_30',

        postsPerWeekMethod:
            '7_divided_by_median_adjacent_post_gap_days',

        medianPostingGapDays:
            round(medianPostingGapDays, 2),

        daysSinceLastPost,

        selling:
            selling.selling,

        sellingSignals:
            selling
                .sellingSignals,

        managementEmailInBio:
            selling
                .managementEmailInBio,

        topVideosByComments,

        commentScraperInputAll: {
            /* All analyzed videos (up to the public-source 10-video cap). */
            videoUrls:
                videos.map(
                    (video) =>
                        video.videoUrl,
                ),

            postUrls:
                videos.map(
                    (video) => ({
                        url: video.videoUrl,
                    }),
                ),

            maxCommentsPerPost:
                100,

            includeReplies:
                false,
        },

        commentScraperInput: {
            /* Top-five-by-comments convenience contract consumed by TikTok Comments Scraper. */
            videoUrls:
                topVideosByComments.map(
                    (video) =>
                        video.videoUrl,
                ),

            /* Compatibility form for older callers that still use postUrls. */
            postUrls:
                topVideosByComments.map(
                    (video) => ({
                        url: video.videoUrl,
                    }),
                ),

            maxCommentsPerPost:
                100,

            includeReplies:
                false,
        },

        coverage,
    };
}

/* -------------------------------------------------------------------------- */
/* Dataset                                                                    */
/* -------------------------------------------------------------------------- */

let datasetItemsWritten =
    0;

let maxItemsReached =
    false;

let summaryOnlyOutput = false;

async function pushLimited(
    item: Record<
        string,
        unknown
    >,
    maxItems: number,
): Promise<boolean> {
    if (summaryOnlyOutput && item.rowType !== 'summary' && item.rowType !== 'RUN_SUMMARY') return true;
    if (
        datasetItemsWritten >=
        maxItems
    ) {
        maxItemsReached =
            true;

        return false;
    }

    await Actor.pushData(
        item,
    );

    datasetItemsWritten +=
        1;

    return true;
}

/* -------------------------------------------------------------------------- */
/* Handle processing                                                          */
/* -------------------------------------------------------------------------- */

async function processHandle(
    username: string,
    options: {
        videosPerProfile: number;
        excludePinned: boolean;
        mode: Mode;
        minFollowers:
            number | null;
        maxFollowers:
            number | null;
        maxItems: number;
    },
): Promise<{
    username: string;
    status: ProfileStatus;
    videosSaved: number;
    warnings: string[];
}> {
    const warnings:
        string[] = [];

    const profileUrl =
        `https://www.tiktok.com/@${username}`;

    log.info(
        `[PROFILE] @${username}`,
    );

    const profileResponse =
        await fetchText(
            profileUrl,
            {
                maxRetries:
                    PAGE_MAX_RETRIES,

                label:
                    'PROFILE',
            },
        );

    const profileHtml =
        profileResponse.text ??
        '';

    const profile =
        parseProfile(
            username,
            profileHtml,
        );

    if (!profile) {
        const status =
            classifyMissingProfile(
                profileHtml,
                profileResponse.status,
            );

        await pushLimited(
            {
                rowType:
                    'profile',

                username,

                profileUrl,

                status,

                error:
                    profileResponse.error,

                httpStatus:
                    profileResponse.status,
            },
            options.maxItems,
        );

        return {
            username,
            status,
            videosSaved: 0,
            warnings,
        };
    }

    if (
        profile.privateAccount ===
        true
    ) {
        await pushLimited(
            {
                rowType:
                    'profile',

                profileUrl,

                status:
                    'private',

                ...profile,
            },
            options.maxItems,
        );

        return {
            username,
            status:
                'private',
            videosSaved: 0,
            warnings,
        };
    }

    const followers =
        profile.followers;

    const belowMinimum =
        options.minFollowers !==
            null &&
        followers !== null &&
        followers <
            options.minFollowers;

    const aboveMaximum =
        options.maxFollowers !==
            null &&
        followers !== null &&
        followers >
            options.maxFollowers;

    if (
        belowMinimum ||
        aboveMaximum
    ) {
        await pushLimited(
            {
                rowType:
                    'profile',

                profileUrl,

                status:
                    'skipped_followers_out_of_range',

                ...profile,

                followerFilter: {
                    minFollowers:
                        options.minFollowers,

                    maxFollowers:
                        options.maxFollowers,

                    actualFollowers:
                        followers,
                },
            },
            options.maxItems,
        );

        return {
            username,
            status:
                'skipped_followers_out_of_range',
            videosSaved: 0,
            warnings,
        };
    }

    await pushLimited(
        {
            rowType:
                'profile',

            profileUrl,

            status: 'ok',

            ...profile,
        },
        options.maxItems,
    );

    if (
        options.mode ===
        'profileOnly'
    ) {
        return {
            username,
            status: 'ok',
            videosSaved: 0,
            warnings,
        };
    }

    if (
        maxItemsReached
    ) {
        return {
            username,
            status: 'ok',
            videosSaved: 0,
            warnings: [
                'maxItems reached before video processing.',
            ],
        };
    }

    const embedUrl =
        `https://www.tiktok.com/embed/@${username}`;

    /*
     * Creator embed is our critical discovery request.
     *
     * It now gets:
     * initial attempt
     * + 5 sec retry
     * + 10 sec retry
     * + 20 sec retry
     *
     * Any 429 also pauses the other worker.
     */
    const embedResponse =
        await fetchText(
            embedUrl,
            {
                referer:
                    profileUrl,

                maxRetries:
                    EMBED_MAX_RETRIES,

                retryDelaysMs:
                    EMBED_RETRY_DELAYS_MS,

                label:
                    'EMBED',
            },
        );

    if (
        !embedResponse.ok ||
        !embedResponse.text
    ) {
        warnings.push(
            `Creator embed failed after bounded retries with HTTP ${embedResponse.status ?? 'unknown'}.`,
        );

        if (
            embedResponse.error
        ) {
            warnings.push(
                embedResponse.error,
            );
        }

        const emptySelection:
            SelectionInfo = {
            selected: [],

            confirmedPinnedExcluded:
                [],

            suspectedHighlightedExcluded:
                [],

            failedCandidateIds:
                [],

            ambiguousCandidateIds:
                [],

            selectionReliable:
                false,
        };

        const coverage =
            buildCoverage(
                options.videosPerProfile,
                0,
                [],
                emptySelection,
                options.excludePinned,
            );

        coverage.warnings.push(
            ...warnings,
        );

        const selling =
            analyzeSelling(
                profile,
                [],
            );

        const summary =
            buildSummary(
                profile,
                [],
                selling,
                coverage,
            );

        await pushLimited(
            {
                rowType:
                    'summary',

                username,

                profileUrl,

                status: 'ok',

                ...summary,
            },
            options.maxItems,
        );

        log.warning(
            `[DONE] @${username}: profile succeeded but creator embed failed; no video rows emitted`,
        );

        return {
            username,
            status: 'ok',
            videosSaved: 0,
            warnings:
                coverage.warnings,
        };
    }

    const candidates =
        parseEmbedCandidates(
            embedResponse.text,
        );

    log.info(
        `[DISCOVERY] @${username}: ${candidates.length} candidate video(s) from creator embed`,
    );

    const parsedCandidates:
        ParsedCandidate[] =
        [];

    /*
     * Parse every discovered candidate BEFORE selection.
     */
    for (
        const candidate of
        candidates
    ) {
        if (
            maxItemsReached
        ) {
            break;
        }

        const parsed =
            await fetchAndParseVideo(
                username,
                profileUrl,
                candidate,
            );

        parsedCandidates.push(
            parsed,
        );

        if (
            parsed.status ===
            'failed'
        ) {
            log.warning(
                `[VIDEO] Final parse failure @${username}/${candidate.id}: ${parsed.error}`,
            );
        }

        if (rateLimitCircuitOpen) break;
        await sleep(100);
    }

    const selection =
        selectVideos(
            parsedCandidates,
            options.videosPerProfile,
            options.excludePinned,
        );

    if (
        selection
            .suspectedHighlightedExcluded
            .length > 0
    ) {
        log.warning(
            `[SELECTION] @${username}: excluded suspected highlighted old candidate(s): ${selection.suspectedHighlightedExcluded.join(', ')}`,
        );
    }

    if (
        selection
            .ambiguousCandidateIds
            .length > 0
    ) {
        log.warning(
            `[COVERAGE] @${username}: newest-N selection is ambiguous because of failed candidate(s): ${selection.ambiguousCandidateIds.join(', ')}`,
        );
    }

    let videosSaved =
        0;

    for (
        let index = 0;
        index <
        selection.selected
            .length;
        index += 1
    ) {
        const video =
            selection.selected[
                index
            ];

        const pushed =
            await pushLimited(
                {
                    rowType:
                        'video',

                    username,

                    profileUrl,

                    status:
                        'ok',

                    rankNewest:
                        index + 1,

                    selectionBasis:
                        'recent_create_time',

                    ...video,
                },
                options.maxItems,
            );

        if (!pushed) break;

        videosSaved += 1;
    }

    const coverage =
        buildCoverage(
            options.videosPerProfile,
            candidates.length,
            parsedCandidates,
            selection,
            options.excludePinned,
        );

    const selling =
        analyzeSelling(
            profile,
            selection.selected,
        );

    const summary =
        buildSummary(
            profile,
            selection.selected,
            selling,
            coverage,
        );

    if (
        !maxItemsReached
    ) {
        await pushLimited(
            {
                rowType:
                    'summary',

                username,

                profileUrl,

                status: 'ok',

                followers:
                    profile.followers,

                ...summary,
            },
            options.maxItems,
        );
    }

    log.info(
        `[DONE] @${username}: ` +
        `discovered=${candidates.length}, ` +
        `parsed=${coverage.parsedCandidates}, ` +
        `failed=${coverage.failedCandidates}, ` +
        `selected=${selection.selected.length}, ` +
        `saved=${videosSaved}, ` +
        `reliable=${coverage.selectionReliable}, ` +
        `complete=${coverage.completeForRequestedCount}, ` +
        `medianComments=${summary.medianComments}, ` +
        `maxComments=${summary.maxComments}`,
    );

    return {
        username,
        status: 'ok',
        videosSaved,
        warnings:
            coverage.warnings,
    };
}

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                */
/* -------------------------------------------------------------------------- */

async function runPool<T>(
    items: string[],
    concurrency: number,
    worker: (
        item: string,
    ) => Promise<T>,
): Promise<T[]> {
    const results:
        T[] = [];

    let nextIndex =
        0;

    async function runner():
        Promise<void> {
        while (true) {
            const index =
                nextIndex++;

            if (
                index >=
                    items.length ||
                maxItemsReached
            ) {
                return;
            }

            const result =
                await worker(
                    items[index],
                );

            results[index] =
                result;
        }
    }

    await Promise.all(
        Array.from(
            {
                length:
                    Math.min(
                        concurrency,
                        items.length,
                    ),
            },
            () => runner(),
        ),
    );

    return results;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

try {
    const input =
        (
            await Actor.getInput<Input>()
        ) ?? {};

    summaryOnlyOutput = input.outputRows === 'summaryOnly';

    const usernames =
        uniqueStrings(
            (
                input.usernames ??
                []
            )
                .map(
                    normalizeUsername,
                )
                .filter(Boolean),
        ).slice(
            0,
            200,
        );

    if (
        usernames.length ===
        0
    ) {
        throw new Error(
            'Input "usernames" must contain at least one TikTok username.',
        );
    }

    const videosPerProfile =
        clampInt(
            input.videosPerProfile,
            10,
            1,
            OFFICIAL_EMBED_RECENT_LIMIT,
        );

    const excludePinned =
        input.excludePinned !==
        false;

    const mode: Mode =
        input.mode ===
        'profileOnly'
            ? 'profileOnly'
            : 'full';

    const minFollowers =
        input.minFollowers ===
            undefined ||
        input.minFollowers ===
            null
            ? null
            : Math.max(
                  0,
                  Math.floor(
                      Number(
                          input.minFollowers,
                      ),
                  ),
              );

    const maxFollowers =
        input.maxFollowers ===
            undefined ||
        input.maxFollowers ===
            null
            ? null
            : Math.max(
                  0,
                  Math.floor(
                      Number(
                          input.maxFollowers,
                      ),
                  ),
              );

    const maxItems =
        clampInt(
            input.maxItems,
            200,
            1,
            5000,
        );

    const concurrency =
        clampInt(
            input.concurrency,
            1,
            1,
            1,
        );

    const rawRunMaxChargeUsd =
        process.env
            .ACTOR_MAX_TOTAL_CHARGE_USD;

    const runMaxChargeUsd =
        rawRunMaxChargeUsd &&
        rawRunMaxChargeUsd.trim() !== ''
            ? rawRunMaxChargeUsd
            : null;

    log.info(
        '[CONFIG] ' +
            JSON.stringify(
                {
                    usernames:
                        usernames.length,

                    videosPerProfile,

                    excludePinned,

                    mode,

                    minFollowers,

                    maxFollowers,

                    maxItems,

                    concurrency,

                    runMaxChargeUsd,

                    discovery:
                        'TikTok public creator embed',

                    selection:
                        'parse-all-then-newest',

                    sharedRateLimitCooldown:
                        true,

                    embedRetryScheduleSeconds: [15, 30, 60],
                    minRequestSpacingMs: MIN_REQUEST_SPACING_MS,
                    maxConsecutive429: MAX_CONSECUTIVE_429,

                    externalPaidServices:
                        false,

                    proxy:
                        false,
                },
            ),
    );

    if (
        videosPerProfile >
        OFFICIAL_EMBED_RECENT_LIMIT
    ) {
        log.warning(
            `videosPerProfile=${videosPerProfile}. Complete coverage above ${OFFICIAL_EMBED_RECENT_LIMIT} cannot be guaranteed from the public creator embed.`,
        );
    }

    const startedAt =
        Date.now();

    const results =
        await runPool(
            usernames,
            concurrency,
            async (
                username,
            ) => {
                try {
                    return await processHandle(
                        username,
                        {
                            videosPerProfile,

                            excludePinned,

                            mode,

                            minFollowers,

                            maxFollowers,

                            maxItems,
                        },
                    );
                } catch (
                    error
                ) {
                    const message =
                        error instanceof
                        Error
                            ? error.message
                            : String(
                                  error,
                              );

                    log.error(
                        `[HANDLE ERROR] @${username}: ${message}`,
                    );

                    if (
                        !maxItemsReached
                    ) {
                        await pushLimited(
                            {
                                rowType:
                                    'profile',

                                username,

                                profileUrl:
                                    `https://www.tiktok.com/@${username}`,

                                status:
                                    'error',

                                error:
                                    message,
                            },
                            maxItems,
                        );
                    }

                    return {
                        username,

                        status:
                            'error' as ProfileStatus,

                        videosSaved:
                            0,

                        warnings: [
                            message,
                        ],
                    };
                }
            },
        );

    const successfulProfiles =
        results.filter(
            (result) =>
                result?.status ===
                'ok',
        ).length;

    const failedProfiles =
        results.filter(
            (result) =>
                result &&
                ![
                    'ok',
                    'skipped_followers_out_of_range',
                ].includes(
                    result.status,
                ),
        ).length;

    const skippedProfiles =
        results.filter(
            (result) =>
                result?.status ===
                'skipped_followers_out_of_range',
        ).length;

    const totalVideoRows =
        results.reduce(
            (
                sum,
                result,
            ) =>
                sum +
                (
                    result?.videosSaved ??
                    0
                ),
            0,
        );

    const warnings =
        uniqueStrings(
            results.flatMap(
                (result) =>
                    result?.warnings ??
                    [],
            ),
        );

    const stopReason =
        maxItemsReached
            ? 'max_items_reached'
            : 'completed';

    const output = {
        rowType:
            'output',

        status:
            'completed',

        stopReason,

        creatorsRequested:
            usernames.length,

        creatorsProcessed:
            results.filter(
                Boolean,
            ).length,

        successfulProfiles,

        skippedProfiles,

        failedProfiles,

        totalVideoRows,

        datasetItemsWritten,

        videosPerProfile,

        mode,

        excludePinned,

        concurrency,

        maxItems,

        discoverySource:
            'tiktok_creator_embed',

        selectionMethod:
            'parse_all_candidates_then_sort_by_create_time',

        discoveryOfficialRecentLimit:
            OFFICIAL_EMBED_RECENT_LIMIT,

        complete30VideoParity:
            false,

        sharedRateLimitCooldown:
            true,

        rateLimitResponses:
            totalRateLimitResponses,

        globalCooldownsActivated:
            totalGlobalCooldowns,
        rateLimitCircuitOpen,
        deferredDueToRateLimit: rateLimitCircuitOpen,

        externalPaidServicesUsed:
            false,

        proxyUsed:
            false,

        estimatedCostUsd:
            null,

        billedEvents:
            null,

        costNote:
            'Exact Apify billing/usage is not available authoritatively inside this Actor. Use the run billing/usage record for actual cost and billed events.',

        runMaxTotalChargeUsd:
            runMaxChargeUsd,

        durationSeconds:
            round(
                (
                    Date.now() -
                    startedAt
                ) /
                    1000,
                2,
            ),

        warnings,
    };

    if (
        datasetItemsWritten <
        maxItems
    ) {
        await pushLimited(
            output,
            maxItems,
        );
    }

    await Actor.setValue(
        'OUTPUT',
        output,
    );

    log.info(
        '[OUTPUT] ' +
            JSON.stringify(
                output,
            ),
    );
} catch (error) {
    log.error(
        error instanceof Error
            ? error.stack ??
                  error.message
            : String(error),
    );

    throw error;
} finally {
    await Actor.exit();
}