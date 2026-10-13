import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Pivot phase 3: one plan ($9.99/month or $89.99/year, 7-day trial). Unlock credits are retired; the free plan keeps
// its 10 setup discoveries a day, paid access isn't metered.
process.env.STRIPE_SECRET_KEY = "sk_test_billing_check";
const {
  FREE_DISCOVERY_LIMIT,
  PLAN,
  canDiscoverSetups,
  getSubscriptionSummary
} = await import("../src/modules/subscriptions/subscriptionService.js");

const migration = readFileSync(new URL("../migrations/013_stripe_billing.sql", import.meta.url), "utf8");
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const signals = readFileSync(new URL("../src/modules/signals/signalService.js", import.meta.url), "utf8");
const stripe = readFileSync(new URL("../src/modules/subscriptions/stripeService.js", import.meta.url), "utf8");
const controller = readFileSync(new URL("../src/modules/subscriptions/subscriptionController.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

assert.equal(PLAN.trialDays, 7);
assert.equal(PLAN.intervals.month.amountCents, 999);
assert.equal(PLAN.intervals.year.amountCents, 8999);
assert.equal(FREE_DISCOVERY_LIMIT, 10);

const free = getSubscriptionSummary({ id: "usr_free", role: "user", plan: "free", emailVerifiedAt: new Date(), discoveriesToday: 4, subscription: { status: "none" } });
assert.equal(free.plan, "free");
assert.equal(free.hasPaidAccess, false);
assert.equal(free.setupDiscoveries.remaining, 6);
assert.deepEqual(free.freeLevelMarkets, ["BTC-USD", "ETH-USD"]);
const trial = getSubscriptionSummary({
  id: "usr_trial", role: "user", plan: "signalforge", emailVerifiedAt: new Date(),
  subscription: { status: "trialing", providerSubscriptionId: "sub_1", stripeMode: "test", billingInterval: "month", trialEnd: "2026-10-21T00:00:00Z" }
});
assert.equal(trial.plan, "signalforge");
assert.equal(trial.hasPaidAccess, true);
assert.equal(trial.setupDiscoveries.limit, null, "paid access isn't metered");
assert.equal(trial.nextChargeCents, 999);
assert.equal(trial.nextChargeAt, "2026-10-21T00:00:00Z");
assert.equal(canDiscoverSetups({ role: "user", emailVerifiedAt: null, subscription: { status: "trialing", providerSubscriptionId: "sub_1", stripeMode: "test" } }), true);
assert.equal("unlockCreditsRemaining" in free, false, "no unlock credits in the summary");

const result = {
  safeBillingMigration: migration.includes("ADD COLUMN IF NOT EXISTS unlock_credits_balance") &&
    migration.includes("CREATE TABLE IF NOT EXISTS setup_discovery_usage") &&
    migration.includes("CREATE TABLE IF NOT EXISTS scan_result_cache") &&
    migration.includes("CREATE TABLE IF NOT EXISTS stripe_webhook_events") &&
    !migration.includes("DELETE FROM users"),
  // The ledger tables stay for history; nothing debits or refunds credits any more.
  creditsRetired: !repositories.includes("consumeSignalUnlockCredit") &&
    !repositories.includes("refundSignalCreditForTerminalOutcome") &&
    !repositories.includes("unlock_credits_balance <= 0"),
  noSetupNoCharge: signals.includes("const quantity = result.publicResult.valid ? 1 : 0") &&
    signals.includes("recordDiscoveryUsage(user, quantity, scanKey)") &&
    signals.includes("result.publicResult.valid ? 1 : 0, scanKey"),
  cacheIsFiveMinutesAndFree: signals.includes("getCachedScanResult") &&
    signals.includes("cached: true") &&
    repositories.includes("ttlSeconds = 300"),
  levelsCheckedOnTheServer: signals.includes("assertCanViewLevels(user, symbol)") &&
    signals.includes("assertCanViewLevels(user, queuedSetup.symbol)"),
  webhookIdempotency: stripe.includes("claimStripeWebhookEvent") &&
    stripe.includes("return { duplicate: true }") &&
    stripe.includes("invoice_already_recorded"),
  signedWebhooks: stripe.includes("createHmac(\"sha256\"") &&
    stripe.includes("timingSafeEqual") &&
    controller.includes('req.headers["stripe-signature"]'),
  checkoutAndPortal: stripe.includes('"/checkout/sessions"') &&
    stripe.includes('"/billing_portal/sessions"') &&
    stripe.includes('payment_method_collection: "always"') &&
    stripe.includes('"subscription_data[trial_period_days]": String(PLAN.trialDays)') &&
    !stripe.includes("allow_promotion_codes"),
  billingUiComplete: html.includes("Setup discoveries") &&
    html.includes(">Cancel subscription</button>") &&
    html.includes(">Update card</button>") &&
    !html.includes("Unlock credit packs") &&
    app.includes("data-plan-interval-choice") &&
    !app.includes("data-billing-pack"),
  testerUnlimited: getSubscriptionSummary({
    role: "tester",
    plan: "tester",
    subscription: { status: "none" }
  }).unlimitedSignals === true
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Stripe billing check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
