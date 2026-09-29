// Captures the JSON responses a page loads for itself (e.g. TikTok's own /api/post/item_list call made when the
// profile grid renders). The Actor reads what the page already receives; it does not forge requests or
// signatures, so it works exactly as far as a normal logged-out visitor's browser does.

export function captureJson(page, needles, { maxHits = 40 } = {}) {
    const wanted = (Array.isArray(needles) ? needles : [needles]).filter(Boolean);
    const hits = [];
    const waiters = [];

    const onResponse = async (response) => {
        const url = response.url();
        if (!wanted.some((n) => url.includes(n))) return;
        if (hits.length >= maxHits) return;
        let data = null;
        try {
            data = await response.json();
        } catch {
            // not JSON (or body unavailable): still record that the call happened
        }
        const hit = { url, status: response.status(), data };
        hits.push(hit);
        for (const w of [...waiters]) {
            if (w.pred(hit)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(hit);
            }
        }
    };
    page.on('response', onResponse);

    return {
        hits,
        // Resolves with the first (already captured or future) hit for which pred(hit) is true, or null on timeout.
        waitFor(pred = () => true, timeoutMs = 15_000) {
            const existing = hits.find((h) => pred(h));
            if (existing) return Promise.resolve(existing);
            return new Promise((resolve) => {
                const w = { pred, resolve };
                waiters.push(w);
                setTimeout(() => {
                    const i = waiters.indexOf(w);
                    if (i !== -1) {
                        waiters.splice(i, 1);
                        resolve(null);
                    }
                }, timeoutMs);
            });
        },
        stop() {
            page.off('response', onResponse);
        },
    };
}
