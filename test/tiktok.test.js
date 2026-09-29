import { describe, expect, it } from 'vitest';

import * as tiktok from '../src/platforms/tiktok.js';

// Guard: TikTok is deliberately unimplemented. It must refuse loudly, never
// return empty/placeholder data that could be mistaken for a real lookup.
describe('tiktok stub', () => {
    it.each(['lookupProfile', 'searchPosts', 'fetchComments'])("%s throws 'not yet implemented'", async (fn) => {
        await expect(tiktok[fn]({})).rejects.toThrow(/not yet implemented/i);
    });
});
