// Reads the "apps" input: Apple numeric ids / apps.apple.com links, Google Play package names / play.google.com links.

const APPLE_URL = /apps\.apple\.com\/(?:([a-z]{2})\/)?(?:[^/]+\/)?(?:[^/]+\/)?id(\d{5,12})/i;
const PLAY_URL = /play\.google\.com\/store\/apps\/details\?(?:[^#]*&)?id=([A-Za-z][\w]*(?:\.[\w]+)+)/i;
const PLAY_ID = /^[A-Za-z][\w]*(?:\.[\w]+)+$/;

// Returns { store: 'apple' | 'google', appId, country? } or { error }.
export function parseAppRef(value) {
    const text = String(value ?? '').trim();
    if (!text) return { error: 'empty' };
    const apple = APPLE_URL.exec(text);
    if (apple) return { store: 'apple', appId: apple[2], country: apple[1]?.toLowerCase() ?? null };
    const play = PLAY_URL.exec(text);
    if (play) return { store: 'google', appId: play[1] };
    const idOnly = /^(?:id)?(\d{5,12})$/i.exec(text);
    if (idOnly) return { store: 'apple', appId: idOnly[1], country: null };
    if (PLAY_ID.test(text)) return { store: 'google', appId: text };
    return { error: 'not an App Store id/link or a Google Play package name/link' };
}
