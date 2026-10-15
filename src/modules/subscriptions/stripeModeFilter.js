import { getStripeMode } from "../../config/appConfig.js";

const KNOWN_STRIPE_MODES = Object.freeze(["test", "live"]);

// A subscription row stored under the other Stripe mode (e.g. an old test-mode subscription under a live key).
// It is stale here: it never pays, never shows as the account's status, never counts as a previous trial and never
// counts in the admin billing metrics.
export function isOtherStripeModeSubscription(subscription, currentMode = getStripeMode()) {
  return KNOWN_STRIPE_MODES.includes(currentMode) &&
    KNOWN_STRIPE_MODES.includes(subscription?.stripeMode) &&
    subscription.stripeMode !== currentMode;
}

// The SQL twin of !isOtherStripeModeSubscription for a stripe_mode column: true for rows that count in this mode.
// The mode is inlined from a fixed list (never user input), so the fragment drops into any query without parameters.
// scripts/billing-admin-metrics-test.js checks both agree on every combination.
export function countsInCurrentStripeModeSql(column, currentMode = getStripeMode()) {
  if (!KNOWN_STRIPE_MODES.includes(currentMode)) return "true";
  const otherMode = KNOWN_STRIPE_MODES.find((mode) => mode !== currentMode);
  return `(${column} IS DISTINCT FROM '${otherMode}')`;
}
