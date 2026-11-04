export const ACTOR_IDS = Object.freeze({ creatorSearch: 'ABXXVWJ3VcAlhLYnL', profileStats: '3QDFPIaSngyuNE8Il', comments: '6HRoM9FvmfZjTfdFw' });
const handle = x => String(x ?? '').trim().replace(/^@/, '').toLowerCase();
export function selectCreators(rows, limit = 5) {
  const seen = new Set(), out = [];
  for (const r of rows ?? []) {
    if (!r || r.passesFilters !== true) continue;
    const name = handle(r.username ?? r.handle);
    if (!/^[a-z0-9._]{2,40}$/.test(name) || seen.has(name)) continue;
    seen.add(name); out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}
export function prepareCommentsInput(rows, maxCommentsPerPost = 100, maxVideosPerCreator = 10) {
  const videoLimit = Math.max(2, Math.min(10, Math.floor(Number(maxVideosPerCreator) || 10)));
  const grouped = new Map();
  const canonicalUrl = (creator, url) => {
    const m = typeof url === 'string' && url.match(/^https:\/\/(?:www\.)?tiktok\.com\/@([\w.]+)\/video\/(\d+)(?:[/?#]|$)/i);
    return m && m[1].toLowerCase() === creator ? 'https://www.tiktok.com/@' + creator + '/video/' + m[2] : null;
  };
  for (const row of rows ?? []) {
    if (!row || !['video', 'summary'].includes(row.rowType) || row.status !== 'ok') continue;
    const creator = handle(row.username ?? row.handle);
    if (!/^[a-z0-9._]{2,40}$/.test(creator)) continue;
    const videos = grouped.get(creator) ?? new Map();
    if (row.rowType === 'video') {
      const url = canonicalUrl(creator, row.videoUrl);
      if (url) {
        const comments = Number(row.comments);
        videos.set(url, {url, comments: Number.isFinite(comments) && comments >= 0 ? comments : -1});
      }
    } else {
      // Fallback for older Profile Stats datasets containing only summary rows.
      for (const v of row.topVideosByComments ?? []) {
        const url = canonicalUrl(creator, typeof v === 'string' ? v : v?.videoUrl ?? v?.url);
        if (!url || videos.has(url)) continue;
        const comments = Number(v?.comments);
        videos.set(url, {url, comments: Number.isFinite(comments) && comments >= 0 ? comments : -1});
      }
    }
    grouped.set(creator, videos);
  }
  const creatorVideos = [...grouped].map(([creator, videos]) => ({
    creator,
    videoUrls: [...videos.values()].sort((a, b) => b.comments - a.comments || a.url.localeCompare(b.url))
      .slice(0, videoLimit).map(v => v.url)
  })).filter(x => x.videoUrls.length >= 2);
  return {creatorVideos, videoUrls: creatorVideos.flatMap(x => x.videoUrls), maxCommentsPerPost, maxVideosPerCreator: videoLimit, minAskers: 3, minVideos: 2};
}
export function summarize({creators, commentsInput, commentRows, childRuns}) {
  const repeatedQuestions = (commentRows ?? []).filter(x => x.recordType === 'REPEATED_QUESTION' && x.askerCount >= 3 && x.videoCount >= 2);
  const commentSummary = (commentRows ?? []).find(x => x.recordType === 'RUN_SUMMARY');
  return {
    recordType: 'PIPELINE_SUMMARY', status: commentSummary?.status === 'failed' ? 'partial' : 'completed',
    creatorsSelected: creators.length, creatorsWithTwoVideos: commentsInput.creatorVideos.length,
    videosRequested: commentsInput.videoUrls.length, repeatedQuestionCount: repeatedQuestions.length,
    repeatedQuestions, childRuns,
    warnings: ['TikTok discovery and public data access may be incomplete.', 'Profile coverage is limited to 10 recent videos, not 30.', 'Only top-level comments are collected; semantic matching is heuristic.', ...(commentSummary?.status === 'partial' ? ['Some comment videos failed.'] : [])],
  };
}
