import assert from 'node:assert/strict';
import { prepare } from '../tiktok-creator-search/scripts/prepare-comments-input.mjs';
const url = (h,id) => `https://www.tiktok.com/@${h}/video/${id}`;
const result = prepare([{username:'creator',topVideosByComments:[{videoUrl:url('creator',123)},{videoUrl:url('creator',456)}]}]);
assert.deepEqual(result.creatorVideos,[{creator:'creator',videoUrls:[url('creator',123),url('creator',456)]}]);
assert.equal(result.minAskers,3);
assert.equal(result.minVideos,2);
console.log('PASS: creator attribution survives handoff');
