import { describe, it, expect } from 'vitest';
import { readInput, keepVideo } from '../src/main.js';

const base = { hashtags: ['fyp'], searchDiscovery: false, videoUrls: ['https://www.tiktok.com/@tester/video/7683299620855745805'] };
const video = { hashtags: ['fyp'], description: '#fyp', createdAt: '2026-10-10T12:00:00.000Z', region: 'US' };
const now = Date.parse('2026-11-07T12:00:00Z');
describe('optional sinceDate', () => {
  it('accepts valid UTC dates and keeps backward compatibility', () => {
    expect(readInput({...base, sinceDate:'2026-10-01'}).sinceDate).toBe('2026-10-01');
    expect(readInput(base).sinceDate).toBeUndefined();
  });
  it('rejects malformed and impossible dates', () => {
    for(const sinceDate of ['2026-02-30','11/07/2026','2026-13-01','2026-1-1'])
      expect(() => readInput({...base,sinceDate})).toThrow(/sinceDate/);
  });
  it('filters before the UTC cutoff, accepts same-day and later', () => {
    expect(keepVideo(video,{tag:'fyp',recentDays:365,regions:[],now,sinceDate:'2026-10-11'})).toBe('tooOld');
    expect(keepVideo(video,{tag:'fyp',recentDays:365,regions:[],now,sinceDate:'2026-10-10'})).toBeNull();
    expect(keepVideo(video,{tag:'fyp',recentDays:365,regions:[],now})).toBeNull();
  });
  it('still enforces recentDays even when sinceDate is older', () => {
    expect(keepVideo(video,{tag:'fyp',recentDays:7,regions:[],now,sinceDate:'2026-01-01'})).toBe('tooOld');
  });
});
