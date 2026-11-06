'use strict';

// Bill-only-on-verified-match. We charge a pay-per-event exactly once per record
// whose matched === true. No-matches, errors and below-threshold near-misses are
// FREE — this beats incumbents that charge per name regardless of outcome.

const EVENT_NAME = 'verified-match';

// `charge` is injected (Apify Actor.charge in production, a counter in tests) so
// the billing policy is unit-testable offline.
async function billIfMatched(record, charge) {
  if (record && record.matched === true) {
    if (typeof charge === 'function') await charge(EVENT_NAME, 1);
    return 1;
  }
  return 0;
}

module.exports = { billIfMatched, EVENT_NAME };
