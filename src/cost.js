// Run cost visibility and a hard proxy cap. Residential proxy is billed per GB, so the number that matters
// most is how many bytes this run moved through the browser; the run's own compute is small by comparison.
//
// - counts bytes for every finished request (headers + bodies, as sent over the wire)
// - optionally blocks images/media/fonts (the parsers read text, JSON and attributes, never pixels), which
//   cuts proxy traffic a lot
// - stops the run cleanly (via BudgetTracker.stop) once maxProxyMegabytes is exceeded
// - report() returns an honest cost summary; the platform's own figure is added by main.js when available

export const BLOCKED_TYPES = new Set(['image', 'media', 'font']);

export function computeUnits(memoryMbytes, runtimeSecs) {
    if (!memoryMbytes || !runtimeSecs) return null;
    return Number(((memoryMbytes / 1024) * (runtimeSecs / 3600)).toFixed(5));
}

export class CostTracker {
    constructor({ budget, maxProxyMegabytes = null, proxyPricePerGbUsd = null, memoryMbytes = null } = {}) {
        this.budget = budget;
        this.maxProxyMegabytes = maxProxyMegabytes;
        this.proxyPricePerGbUsd = proxyPricePerGbUsd;
        this.memoryMbytes = memoryMbytes;
        this.bytes = 0;
        this.requests = 0;
        this.blockedRequests = 0;
        this.startedAt = Date.now();
        this.pending = new Set();
    }

    // Waits for in-flight size measurements; call before closing the browser and reading report().
    async settle() {
        await Promise.allSettled([...this.pending]);
    }

    addBytes(n) {
        if (!Number.isFinite(n) || n <= 0) return;
        this.bytes += n;
        this.requests += 1;
        if (this.maxProxyMegabytes && this.bytes / 1e6 > this.maxProxyMegabytes) {
            this.budget?.stop('max_proxy_megabytes');
        }
    }

    async attach(context, { blockHeavyResources = true } = {}) {
        if (blockHeavyResources) {
            await context.route('**/*', (route) => {
                if (BLOCKED_TYPES.has(route.request().resourceType())) {
                    this.blockedRequests += 1;
                    return route.abort();
                }
                return route.continue();
            });
        }
        context.on('requestfinished', (request) => {
            const measure = (async () => {
                try {
                    const s = await request.sizes();
                    this.addBytes(
                        (s.requestBodySize || 0) +
                            (s.requestHeadersSize || 0) +
                            (s.responseBodySize || 0) +
                            (s.responseHeadersSize || 0),
                    );
                } catch {
                    // sizes are unavailable for some requests: skip rather than guess
                }
            })();
            this.pending.add(measure);
            measure.finally(() => this.pending.delete(measure));
        });
    }

    report({ platformUsage = null } = {}) {
        const runtimeSecs = Number(((Date.now() - this.startedAt) / 1000).toFixed(1));
        const proxyMegabytes = Number((this.bytes / 1e6).toFixed(2));
        return {
            runtimeSecs,
            requests: this.requests,
            blockedRequests: this.blockedRequests,
            proxyMegabytes,
            maxProxyMegabytes: this.maxProxyMegabytes,
            computeUnitsEstimate: computeUnits(this.memoryMbytes, runtimeSecs),
            // Only computed when a price was supplied; the per-GB rate depends on your plan.
            estimatedProxyUsd:
                this.proxyPricePerGbUsd != null
                    ? Number(((proxyMegabytes / 1000) * this.proxyPricePerGbUsd).toFixed(4))
                    : null,
            // The platform's own usage figure for this run (Apify), when it could be read. It can lag the
            // final charge by a little because usage is aggregated after the run ends.
            platformUsage,
            note: 'proxyMegabytes is measured in the browser (wire bytes). Compare with Console > Proxy usage for the billed figure.',
        };
    }
}
