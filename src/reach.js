// The reach rule: how much of a creator's audience a typical recent post reaches. Median (not mean) of the
// latest posts, so one viral post or one dud does not decide it, as a percentage of followers.
// Raw numbers are returned next to the percentages; nothing is guessed when the data is not there.

const MIN_SAMPLES = 3;

export function median(values) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const pct = (value, followers) =>
    value != null && followers > 0 ? Number(((value / followers) * 100).toFixed(2)) : null;

// posts: post rows (likeCount/commentCount/viewCount), followers: exact follower count.
// Returns the reach fields; every one is null when fewer than `minSamples` posts carry the number.
export function computeReach(posts, followerCount, { minSamples = MIN_SAMPLES } = {}) {
    const list = (posts ?? []).filter((p) => (p.status ?? 'found') === 'found');
    const pick = (key) => {
        const vals = list.map((p) => p[key]).filter((x) => Number.isFinite(x));
        return vals.length >= minSamples ? median(vals) : null;
    };
    const medianLikes = pick('likeCount');
    const medianComments = pick('commentCount');
    const medianViews = pick('viewCount');
    const likesPct = pct(medianLikes, followerCount);
    const viewsPct = pct(medianViews, followerCount);
    const commentsPct = pct(medianComments, followerCount);
    let reachPct = null;
    let basis = null;
    if (viewsPct != null) {
        reachPct = viewsPct;
        basis = 'median views of the sampled posts / followers';
    } else if (likesPct != null) {
        reachPct = likesPct;
        basis = 'median likes of the sampled posts / followers';
    }
    return {
        postsSampled: list.length,
        medianLikes,
        medianComments,
        medianViews,
        likesPctOfFollowers: likesPct,
        viewsPctOfFollowers: viewsPct,
        commentsPctOfFollowers: commentsPct, // always available when comment counts are (even if likes are hidden)
        reachPctOfFollowers: reachPct,
        reachBasis: basis,
    };
}
