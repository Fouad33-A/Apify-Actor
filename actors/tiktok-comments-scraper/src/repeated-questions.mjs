// Conservative, auditable repeated-question screening. No paid NLP service.
const clean = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const starters = /^(how|why|what|when|where|which|who|can|could|would|should|do|does|did|is|are|will|may|anyone|where to)\b/i;
const filler = /\b(please|pls|guys|bro|hey|hi|hello|someone|anybody)\b/g;
export function questionKey(text) {
  const raw = String(text ?? '').trim();
  if (!raw || (!raw.includes('?') && !starters.test(raw))) return null;
  const normalized = clean(raw).replace(filler, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.split(' ').length < 3) return null;
  if (/^(what song is this|song name|who is this|what game is this)$/.test(normalized)) return null;
  return normalized;
}
export function repeatedQuestions(comments, { minAskers = 3, minVideos = 2 } = {}) {
  if (!Number.isInteger(minAskers) || minAskers < 3 || !Number.isInteger(minVideos) || minVideos < 2) throw new Error('Minimum is 3 askers on 2 videos');
  const clusters = new Map();
  for (const c of comments ?? []) {
    const creator = clean(c.creator ?? c.handle);
    const asker = String(c.userId ?? c.username ?? c.authorId ?? '').trim();
    const video = String(c.videoId ?? c.videoUrl ?? '').trim();
    const text = String(c.commentText ?? c.text ?? '').trim();
    const key = questionKey(text);
    if (!creator || !asker || !video || !key) continue;
    const id = creator + '\u0000' + key;
    if (!clusters.has(id)) clusters.set(id, { creator, key, comments: [], askers: new Set(), videos: new Set() });
    const group = clusters.get(id);
    group.comments.push({ text, asker, video, videoUrl: c.videoUrl ?? null });
    group.askers.add(asker);
    group.videos.add(video);
  }
  return [...clusters.values()].filter(g => g.askers.size >= minAskers && g.videos.size >= minVideos).map(g => ({
    recordType: 'REPEATED_QUESTION', creator: g.creator, questionText: g.comments[0].text,
    askerCount: g.askers.size, videoCount: g.videos.size,
    exampleComments: g.comments.filter((c,i,a)=>a.findIndex(x=>x.asker===c.asker)===i).slice(0,3),
    clusteringMethod: 'normalized-exact',
  }));
}
