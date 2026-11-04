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
export function prepareCommentsInput(rows, maxCommentsPerPost = 100) {
  const grouped = new Map();
  for (const row of rows ?? []) {
    if (row?.rowType !== 'summary' || !Array.isArray(row.topVideosByComments)) continue;
    const creator = handle(row.username ?? row.handle);
    if (!/^[a-z0-9._]{2,40}$/.test(creator)) continue;
    const urls = grouped.get(creator) ?? [];
    for (const v of row.topVideosByComments.slice(0, 5)) {
      const url = typeof v === 'string' ? v : v?.videoUrl ?? v?.url;
      const m = typeof url === 'string' && url.match(/^https:\/\/(?:www\.)?tiktok\.com\/@([\w.]+)\/video\/(\d+)(?:[/?#]|$)/i);
      if (!m || m[1].toLowerCase() !== creator) continue;
      const canonical = 'https://www.tiktok.com/@' + creator + '/video/' + m[2];
      if (!urls.includes(canonical)) urls.push(canonical);
    }
    grouped.set(creator, urls.slice(0, 5));
  }
  const creatorVideos = [...grouped].filter(([, urls]) => urls.length >= 2).map(([creator, videoUrls]) => ({creator, videoUrls}));
  return {creatorVideos, videoUrls: creatorVideos.flatMap(x => x.videoUrls), maxCommentsPerPost, minAskers: 3, minVideos: 2};
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
