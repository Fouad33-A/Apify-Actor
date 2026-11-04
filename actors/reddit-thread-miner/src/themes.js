// Demand language: keyword themes and competitor mentions. A theme matches when one of its phrases appears as a word or
// phrase in the text (case-insensitive); the matched phrases are returned so the tag can be checked.
export const DEFAULT_THEMES = {
    price: [
        'price',
        'prices',
        'pricing',
        'cost',
        'costs',
        'expensive',
        'cheap',
        'cheaper',
        'afford',
        'subscription',
        'per month',
        'per year',
        'discount',
        'coupon',
        'promo code',
        'refund',
        'money',
    ],
    worth_it: [
        'worth it',
        'worth the',
        'worth buying',
        'worth paying',
        'worth my money',
        'is it good',
        'any good',
        'legit',
        'would you recommend',
        'recommend',
    ],
    free_alternative: [
        'free alternative',
        'free resource',
        'free resources',
        'for free',
        'free version',
        'free option',
        'alternative to',
        'instead of paying',
        'cheaper alternative',
        'youtube',
        'khan academy',
    ],
};
export const DEFAULT_COMPETITORS = [
    'magoosh',
    'uworld',
    'save my exams',
    'savemyexams',
    'fiveable',
    'albert',
    'revision village',
    'revisionvillage',
    'princeton review',
    'kaplan',
    'prepscholar',
    'khan academy',
    'bluebook',
    'ibdocs',
    'seneca',
    'physics and maths tutor',
    'gcse pod',
    'tutorful',
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const find = (text, phrase) => new RegExp(`(?<![a-z0-9])${esc(phrase.toLowerCase())}(?![a-z0-9])`).test(text);

export function tagText(text, { themes = DEFAULT_THEMES, competitors = DEFAULT_COMPETITORS } = {}) {
    const hay = String(text ?? '').toLowerCase();
    const tags = [];
    for (const [theme, phrases] of Object.entries(themes)) if (phrases.some((p) => find(hay, p))) tags.push(theme);
    const mentioned = competitors.filter((c) => find(hay, c));
    if (mentioned.length) tags.push('competitor');
    return { themes: tags, competitorsMentioned: mentioned };
}

export function mergeThemes(custom) {
    const themes = { ...DEFAULT_THEMES };
    for (const [name, phrases] of Object.entries(custom ?? {})) {
        const list = (Array.isArray(phrases) ? phrases : String(phrases).split(','))
            .map((p) => String(p).trim())
            .filter(Boolean);
        if (list.length) themes[name] = list;
    }
    return themes;
}
