#!/usr/bin/env python3
"""Apply two targeted fixes to the existing TikTok Profile Video Stats Actor."""
from pathlib import Path
import sys

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
path = root / 'actors/tiktok-profile-video-stats/src/main.ts'
if not path.is_file():
    sys.exit(f'ERROR: Could not find {path}. Extract the GitHub repository first.')
s = path.read_text(encoding='utf-8')
original = s

def once(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        sys.exit(f'ERROR: {label}: expected one matching block, found {n}. No files changed.')
    s = s.replace(old, new, 1)

once('    managementEmailInBio: boolean;\n}', '    managementEmailInBio: boolean;\n    sponsored: boolean;\n    sponsoredSignals: string[];\n}', 'SellingAnalysis interface')
start = s.find('    for (\n        const video of videos\n    ) {', s.find('function analyzeSelling('))
end = s.find('    const managementEmailInBio =', start)
if start < 0 or end < 0:
    sys.exit('ERROR: Could not find sponsorship block. No files changed.')
s = s[:start] + '''    // Sponsorship is separate from creator-owned product or service sales.
    const sponsoredSignals = new Set<string>();
    for (const video of videos) {
        if (video.isAd === true) sponsoredSignals.add('video_ad_flag');
        for (const signal of video.sponsoredSignals) sponsoredSignals.add(signal);
    }
    const domain = (profile.bioLinkDomain ?? '').toLowerCase();
    const link = (profile.bioLink ?? '').toLowerCase();
    if (/(?:^|\\.)(?:shop|store)$/.test(domain) || /\\.(?:shop|store)(?:\\/|$)/.test(link)) {
        signals.add('bio_commerce_domain');
    }
    if (/\\b(?:merch|merchandise|shop|store|course|courses)\\b/i.test(lower)) {
        signals.add('bio_commerce_language');
    }

''' + s[end:]
once('        managementEmailInBio,\n    };', '''        managementEmailInBio,
        sponsored: sponsoredSignals.size > 0,
        sponsoredSignals: [...sponsoredSignals],
    };''', 'SellingAnalysis return')
a = s.find('    /*\n     * Cadence uses the median gap')
b = s.find('    let daysSinceLastPost:', a)
if a < 0 or b < 0:
    sys.exit('ERROR: Could not find cadence calculation. No files changed.')
s = s[:a] + '''    // Use the full sample span to avoid inflated burst-posting estimates.
    const postingGapDays: number[] = [];
    for (let i = 0; i + 1 < sortedDates.length; i++) {
        const gapDays = (sortedDates[i] - sortedDates[i + 1]) / 86400;
        if (gapDays > 0 && Number.isFinite(gapDays)) postingGapDays.push(gapDays);
    }
    const medianPostingGapDays = median(postingGapDays);
    const sampledSpanDays = sortedDates.length >= 2
        ? (sortedDates[0] - sortedDates[sortedDates.length - 1]) / 86400
        : null;
    if (sampledSpanDays !== null && sampledSpanDays > 0) {
        postsPerWeek = round((sortedDates.length - 1) * 7 / sampledSpanDays, 2);
    }

''' + s[b:]
once("'7_divided_by_median_adjacent_post_gap_days'", "'sampled_intervals_per_oldest_to_newest_span_days'", 'cadence method label')
if s == original:
    sys.exit('ERROR: Nothing changed.')
path.write_text(s, encoding='utf-8')
print('SUCCESS: Updated', path)
print('Posting cadence: sampled intervals / total sampled span.')
print('Selling: commerce signals separated from sponsored signals.')
print('Next: review git diff, build and test before deploying.')
