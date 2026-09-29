// Internal safety net on top of the Actor run's own maxItems/maxTotalChargeUsd
// call options (set by whoever calls the actor - see README "Budget"). This
// tracker is what makes the actor stop ITSELF cleanly mid-run once a cap is
// hit, rather than relying only on the platform to kill the run, and it's
// what produces the per-run item-count report the requirements ask.for.
// Other caps (e.g. the proxy-megabyte cap in cost.js) stop the run through stop().

export class BudgetTracker {
    constructor(maxItemsPerRun) {
        this.maxItemsPerRun = maxItemsPerRun;
        this.counts = { profiles: 0, posts: 0, comments: 0, total: 0 };
        this.stoppedOnCap = false;
        this.stopReason = null;
    }

    // The cap being 0 (or already reached) means nothing more may be written.
    canWriteMore() {
        return !this.stopReason && this.counts.total < this.maxItemsPerRun;
    }

    // Ends the run cleanly for a reason other than the item cap; the first reason wins.
    stop(reason) {
        if (!this.stopReason) this.stopReason = reason;
        this.stoppedOnCap = true;
    }

    record(recordType) {
        if (!this.canWriteMore()) {
            this.stoppedOnCap = true;
            this.stopReason ??= 'max_items_per_run';
            return false;
        }
        if (recordType === 'profile') this.counts.profiles += 1;
        else if (recordType === 'post') this.counts.posts += 1;
        else if (recordType === 'comment') this.counts.comments += 1;
        this.counts.total += 1;
        if (this.counts.total >= this.maxItemsPerRun) {
            this.stoppedOnCap = true;
            this.stopReason ??= 'max_items_per_run';
        }
        return true;
    }

    // Undo record() for a row that then was not written (e.g. the user's spending limit was reached).
    unrecord(recordType) {
        if (recordType === 'profile') this.counts.profiles -= 1;
        else if (recordType === 'post') this.counts.posts -= 1;
        else if (recordType === 'comment') this.counts.comments -= 1;
        this.counts.total -= 1;
    }

    summary() {
        return {
            maxItemsPerRun: this.maxItemsPerRun,
            itemsWritten: this.counts.total,
            stoppedOnCap: this.stoppedOnCap,
            stopReason: this.stopReason,
        };
    }
}
