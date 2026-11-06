import assert from 'node:assert/strict';
import { prepare } from './prepare-comments-input.mjs';
const video = (handle, id) => ({ videoUrl: `https://www.tiktok.com/@${handle}/video/${id}` });
const input = [
  { username: 'alice', topVideosByComments: [video('alice',111), video('alice',222), video('alice',222)] },
  { username: 'bob', topVideosByComments: [video('bob',333)] },
  { username: 'charlie', topVideosByComments: [video('charlie',444), video('charlie',555)] },
];
const result = prepare(input);
assert.equal(result.creatorVideos.length, 2);
assert.equal(result.videoUrls.length, 4);
assert.deepEqual(result.creatorVideos.map(c => c.creator), ['alice', 'charlie']);
assert.equal(result.minAskers, 3);
assert.equal(result.minVideos, 2);
assert.equal(prepare([{ username: 'alice', topVideosByComments: [video('alice',111)] }]).videoUrls.length, 0);
console.log('PASS: handoff filters insufficient video coverage, deduplicates, and preserves creator grouping');
