// Pay-per-event charging. A row is charged only when it carries real data the user can see in the dataset:
// a `found` (or `private`, which still returns the public header facts) profile, a `found` post, a `found`
// comment. `not_found`, `blocked` and `error` rows are written free of charge, so a user is never billed for
// a platform block or an Actor failure.
//
// The events must be defined in Apify Console under Publishing > Monetization (names below), and the
// synthetic `apify-default-dataset-item` event must be REMOVED there, otherwise every row (blocked ones
// included) would be charged on top. Charging stops cleanly once the user's spending limit is reached
// (ACTOR_MAX_TOTAL_CHARGE_USD), through BudgetTracker.stop().

export const EVENT_NAMES = { profile: 'profile-scraped', post: 'post-scraped', comment: 'comment-scraped' };
export const DEFAULT_ITEM_EVENT = 'apify-default-dataset-item';

const CHARGEABLE_STATUSES = {
    profile: new Set(['found', 'private']),
    post: new Set(['found']),
    comment: new Set(['found']),
};

// The event a row is charged under, or null when it is free.
export function chargeEventFor(row) {
    const allowed = CHARGEABLE_STATUSES[row?.recordType];
    if (!allowed || !allowed.has(row.status)) return null;
    return EVENT_NAMES[row.recordType];
}

// `actor` is the Apify SDK's Actor (injected so it can be faked in tests).
export function makeCharger({ actor, budget, warn = () => {} }) {
    const manager = actor.getChargingManager();
    const pricing = manager.getPricingInfo();
    const isPayPerEvent = Boolean(pricing?.isPayPerEvent);
    const prices = pricing?.perEventPrices ?? {};
    const doubleChargeRisk = isPayPerEvent && DEFAULT_ITEM_EVENT in prices;
    if (doubleChargeRisk) {
        warn(
            `The synthetic "${DEFAULT_ITEM_EVENT}" event is enabled: every dataset row, including blocked/error rows, ` +
                'is charged on top of the per-result events. Remove it in Console > Publishing > Monetization.',
        );
    }

    return {
        isPayPerEvent,

        async push(row) {
            const event = isPayPerEvent ? chargeEventFor(row) : null;
            if (!event) {
                await actor.pushData(row);
                return true;
            }
            // The user's spending limit is used up: do not write (and so do not do more paid work).
            if (manager.calculateMaxEventChargeCountWithinLimit(event) < 1) {
                budget?.stop('max_total_charge_usd');
                return false;
            }
            const result = await actor.pushData(row, event);
            if (result?.eventChargeLimitReached) budget?.stop('max_total_charge_usd');
            return true;
        },

        summary() {
            return {
                isPayPerEvent,
                maxTotalChargeUsd: isPayPerEvent ? manager.getMaxTotalChargeUsd() : null,
                chargedEvents: isPayPerEvent
                    ? Object.fromEntries(
                          Object.values(EVENT_NAMES).map((name) => [name, manager.getChargedEventCount(name)]),
                      )
                    : null,
                warning: doubleChargeRisk ? `${DEFAULT_ITEM_EVENT} is enabled: remove it in Console` : null,
            };
        },
    };
}
