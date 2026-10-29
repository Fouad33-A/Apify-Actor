// Optional starting points: keywords and hashtags for common exams. They are only added when chosen in "examPresets" and
// can be changed or ignored; they are popular wordings, not a complete list.
export const EXAM_PRESETS = {
    igcse: {
        keywords: ['igcse revision', 'igcse maths tips', 'igcse tutor'],
        hashtags: ['igcse', 'igcserevision', 'igcsemaths'],
    },
    sat: { keywords: ['sat prep', 'sat math tips', 'digital sat'], hashtags: ['sat', 'satprep', 'satmath'] },
    ib: { keywords: ['ib revision', 'ib maths tips', 'ib study tips'], hashtags: ['ibdp', 'ibmaths', 'ibstudytips'] },
    ap: {
        keywords: ['ap exam prep', 'ap calculus tips', 'ap study tips'],
        hashtags: ['apexams', 'apcalculus', 'apstudytips'],
    },
    a_level: {
        keywords: ['a level revision', 'a level maths tips', 'a level tutor'],
        hashtags: ['alevels', 'alevelmaths', 'alevelrevision'],
    },
};

export function presetSearches(names = []) {
    const keywords = [];
    const hashtags = [];
    for (const name of names) {
        const p =
            EXAM_PRESETS[
                String(name)
                    .toLowerCase()
                    .replace(/[\s-]+/g, '_')
            ];
        if (!p) throw new Error(`Unknown exam preset "${name}". Choose from: ${Object.keys(EXAM_PRESETS).join(', ')}.`);
        keywords.push(...p.keywords);
        hashtags.push(...p.hashtags);
    }
    return { keywords, hashtags };
}
