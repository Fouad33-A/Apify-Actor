// Offline handoff from profile summaries to the Comments Actor.
// Usage: node scripts/prepare-comments-input.mjs profile-results.json comments-input.json
import fs from 'node:fs';

export function prepare(rows, { maxCreators = 100, maxCommentsPerPost = 100 } = {}) {
    const byCreator = new Map();
    for (const row of rows) {
        if (!row || !Array.isArray(row.topVideosByComments)) continue;
        const handle = String(row.username ?? row.handle ?? '').replace(/^@/, '').toLowerCase();
        if (!handle) continue;
        const videos = row.topVideosByComments.slice(0, 5)
            .map(v => typeof v === 'string' ? v : v?.videoUrl ?? v?.url)
            .filter(url => typeof url === 'string' && /^https:\/\/(www\.)?tiktok\.com\/@[^/]+\/video\/\d+/.test(url));
        if (videos.length < 2) continue;
        const existing = byCreator.get(handle) ?? [];
        byCreator.set(handle, [...new Set([...existing, ...videos])].slice(0, 5));
        if (byCreator.size >= maxCreators) break;
    }
    const creatorVideos = [...byCreator].map(([creator, videoUrls]) => ({ creator, videoUrls }));
    return {
        videoUrls: [...new Set(creatorVideos.flatMap(c => c.videoUrls))],
        maxCommentsPerPost,
        minAskers: 3,
        minVideos: 2,
        creatorVideos,
    };
}
if (process.argv[1]?.endsWith('prepare-comments-input.mjs') && process.argv[2]) {
    const source = fs.readFileSync(process.argv[2], 'utf8');
    const rows = source.trimStart().startsWith('[') ? JSON.parse(source) : source.trim().split('\n').map(JSON.parse);
    const result = prepare(rows);
    fs.writeFileSync(process.argv[3] ?? 'comments-input.json', JSON.stringify(result, null, 2));
}
