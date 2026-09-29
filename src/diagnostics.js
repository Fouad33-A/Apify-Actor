import { readFileSync } from 'node:fs';

import { Actor, log } from 'apify';

const HTML_HEAD_CHARS = 4000;
const BODY_TEXT_CHARS = 2000;

export function runtimeInfo() {
    let codeVersion = null;
    try {
        codeVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    } catch {
        // package.json unreadable: leave null rather than guess
    }
    return {
        codeVersion,
        buildNumber: process.env.ACTOR_BUILD_NUMBER ?? null,
        buildId: process.env.ACTOR_BUILD_ID ?? null,
    };
}

// Saved as JSON (not text/html) so it can be read back through the API/connector
// without an HTML sanitiser stripping it. Truncated: this is diagnostics, not a scrape.
export async function saveDiagnostics(page, html, tag, meta = {}) {
    let title = null;
    let bodyText = null;
    try {
        title = await page.title();
    } catch {
        // page may already be closed or navigating
    }
    try {
        bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
        bodyText = bodyText.slice(0, BODY_TEXT_CHARS);
    } catch {
        // leave null
    }
    const record = {
        tag,
        at: new Date().toISOString(),
        url: page.url(),
        title,
        htmlLength: html.length,
        htmlHead: html.slice(0, HTML_HEAD_CHARS),
        bodyText,
        meta,
        runtime: runtimeInfo(),
    };
    try {
        await Actor.setValue(`DIAG_${tag}`, JSON.stringify(record, null, 2), {
            contentType: 'application/json; charset=utf-8',
        });
    } catch (err) {
        log.warning(`Failed to save DIAG_${tag}: ${err?.message}`);
    }
    return record;
}
