// Complaint themes: plain keyword lists, no model. A review can match several themes. English wording; add your own
// through the "customThemes" input (theme name -> list of words or phrases).

export const DEFAULT_THEMES = {
    crashes_bugs: [
        'crash',
        'crashes',
        'crashing',
        'freeze',
        'freezes',
        'frozen',
        'bug',
        'bugs',
        'buggy',
        'glitch',
        'glitchy',
        'not working',
        "doesn't work",
        'doesnt work',
        "won't open",
        'wont open',
        'keeps closing',
        'black screen',
        'stuck on',
    ],
    login_account: [
        'log in',
        'login',
        'sign in',
        'password',
        'verification code',
        'account locked',
        'locked out',
        'banned',
        'suspended',
        'cant access',
        "can't access",
    ],
    billing_subscription: [
        'subscription',
        'charged',
        'double charged',
        'billing',
        'refund',
        'cancel',
        'auto renew',
        'auto-renew',
        'free trial',
        'money back',
        'rip off',
        'ripped off',
        'hidden fee',
        'hidden charge',
    ],
    price_value: [
        'expensive',
        'overpriced',
        'too much money',
        'paywall',
        'pay to',
        'not worth',
        'price hike',
        'costs too',
    ],
    ads: ['ads', 'advert', 'adverts', 'advertisement', 'pop up', 'popup', 'pop-up', 'too many ads'],
    performance: ['slow', 'laggy', 'lag', 'takes forever', 'loading', 'battery', 'drains', 'overheat', 'heavy app'],
    ux_design: [
        'confusing',
        'hard to use',
        'difficult to use',
        'not intuitive',
        'terrible ui',
        'bad ui',
        'interface',
        'redesign',
        'new update ruined',
        'used to be better',
        'cluttered',
    ],
    support: [
        'customer service',
        'customer support',
        'support team',
        'no response',
        'no reply',
        'never replied',
        'ignored me',
        "can't reach",
        'cant reach',
        'no one answers',
    ],
    missing_features: [
        'please add',
        'wish it had',
        'wish there was',
        'missing',
        'lacks',
        'no option',
        'no way to',
        'feature request',
        'should have',
        'need a way',
        "can't even",
    ],
    privacy_trust: [
        'privacy',
        'tracking',
        'spam',
        'fake',
        'scam',
        'sells my data',
        'selling my data',
        'data breach',
        'stole',
    ],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// word-boundary matcher for one list of words/phrases
function matcher(words) {
    const parts = words.map((w) => escapeRe(String(w).trim().toLowerCase()).replace(/\s+/g, '\\s+')).filter(Boolean);
    return parts.length ? new RegExp(`(?<![a-z0-9])(?:${parts.join('|')})(?![a-z0-9])`, 'g') : null;
}

export function buildClassifier(customThemes = {}) {
    const all = { ...DEFAULT_THEMES };
    for (const [name, words] of Object.entries(customThemes ?? {})) {
        if (Array.isArray(words) && words.length) all[name] = [...(all[name] ?? []), ...words];
    }
    const compiled = Object.entries(all)
        .map(([name, words]) => [name, matcher(words)])
        .filter(([, re]) => re);
    // Returns [{ theme, matched: [words] }] for the review text.
    return (text) => {
        const haystack = String(text ?? '')
            .toLowerCase()
            .replace(/[’‘]/g, "'");
        const hits = [];
        for (const [theme, re] of compiled) {
            re.lastIndex = 0;
            const matched = [...new Set([...haystack.matchAll(re)].map((m) => m[0].replace(/\s+/g, ' ')))];
            if (matched.length) hits.push({ theme, matched });
        }
        return hits;
    };
}
