// Internal safety net on top of the Actor run's own maxItems/maxTotalChargeUsd
// call options (set by whoever calls the actor - see README "Budget"). This
// tracker is what makes the actor stop ITSELF cleanly mid-run once a cap is
// hit, rather than relying only on the platform to kill the run, and it's
// what produces the per-run item-count report the requirements ask.for.

export class BudgetTracker {
    constructor(maxItemsPerRun) {
        this.maxItemsPerRun = maxItemsPerRun;
        this.counts = { profiles: 0, posts: 0, comments: 0, total: 0 };
        this.stoppedOnCap = false;
    }

    canWriteMore() {
        return this.counts.total < this.maxItemsPerRun;
    }

    record(recordType) {
        if (!this.canWriteMore()) {
            this.stoppedOnCap = true;
            return false;
        }
        if (recordType === 'profile') this.counts.profiles += 1;
        else if (recordType === 'post') this.counts.posts += 1;
        else if (recordType === 'comment') this.counts.comments += 1;
        this.counts.total += 1;
        if (this.counts.total >= this.maxItemsPerRun) this.stoppedOnCap = true;
        return true;
    }

    summary() {
        return {
            maxItemsPerRun: this.maxItemsPerRun,
            itemsWritten: this.counts.total,
            stoppedOnCap: this.stoppedOnCap,
        };
    }
}
