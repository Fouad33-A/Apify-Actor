// Conservative, transparent text-only helpers for the Marketing Agent.
// They never replace the original post text or claim semantic certainty.
const EXAMS = [
    ['igcse', /\bigcse\b/i],
    ['gcse', /\bgcse\b/i],
    ['sat', /\bsat\b/i],
    ['ib', /\b(?:ib|ibdp|international baccalaureate)\b/i],
    ['ap', /\b(?:ap exam|ap calculus|ap biology|ap chemistry|ap physics|ap students?)\b/i],
    ['alevel', /\b(?:a[ -]?levels?|as levels?)\b/i],
];
const SUBJECTS = [
    ['math', /\b(?:maths?|mathematics|algebra|calculus|geometry)\b|رياضيات/i],
    ['english', /\b(?:english|literature|grammar|writing)\b|انجليزي|إنجليزي/i],
    ['physics', /\bphysics\b|فيزياء/i],
    ['chemistry', /\bchemistry\b|كيمياء/i],
    ['biology', /\bbiology\b|أحياء/i],
];
export function classifyPost(text) {
    const value = String(text ?? '');
    const topicTags = [
        ...EXAMS.filter(([, re]) => re.test(value)).map(([name]) => `exam:${name}`),
        ...SUBJECTS.filter(([, re]) => re.test(value)).map(([name]) => `subject:${name}`),
    ];
    const isQuestion = /[?؟]/.test(value) ||
        /^\s*(?:how|what|why|where|when|which|can|could|should|does|do|is|are|anyone|هل|كيف|لماذا|متى|وين|شو)\b/im.test(value);
    return { isQuestion, topicTags, classificationMethod: 'keyword_heuristic' };
}
