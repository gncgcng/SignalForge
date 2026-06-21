import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BILLING_PLANS,
  CREDIT_PACKS,
  canGenerateSignal,
  getSubscriptionSummary
} from "../src/modules/subscriptions/subscriptionService.js";

const migration = readFileSync(new URL("../migrations/013_stripe_billing.sql", import.meta.url), "utf8");
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const signals = readFileSync(new URL("../src/modules/signals/signalService.js", import.meta.url), "utf8");
const stripe = readFileSync(
  new URL("../src/modules/subscriptions/stripeService.js", import.meta.url),
  "utf8"
);
const controller = readFileSync(
  new URL("../src/modules/subscriptions/subscriptionController.js", import.meta.url),
  "utf8"
);
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

assert.equal(BILLING_PLANS.free.discoveryLimit, 10);
assert.equal(BILLING_PLANS.free.lifetimeUnlockGrant, 3);
assert.equal(BILLING_PLANS.pro.discoveryLimit, 300);
assert.equal(BILLING_PLANS.pro.monthlyUnlockGrant, 100);
assert.equal(BILLING_PLANS.elite.discoveryLimit, 1000);
assert.equal(BILLING_PLANS.elite.monthlyUnlockGrant, 500);
assert.equal(CREDIT_PACKS.pack100.quantity, 100);

const proSummary = getSubscriptionSummary({
  id: "usr_pro",
  role: "user",
  plan: "pro",
  emailVerifiedAt: new Date(),
  unlockCreditsBalance: 137,
  discoveriesPeriod: 25,
  subscription: { status: "active", currentPeriodStart: new Date() }
});
assert.equal(proSummary.setupDiscoveries.remaining, 275);
assert.equal(proSummary.unlockCreditsRemaining, 137);
assert.equal(proSummary.unlockCreditsRollover, true);
assert.equal(canGenerateSignal({
  role: "user",
  emailVerifiedAt: new Date(),
  unlockCreditsBalance: 1
}), true);

const result = {
  safeBillingMigration: migration.includes("ADD COLUMN IF NOT EXISTS unlock_credits_balance") &&
    migration.includes("CREATE TABLE IF NOT EXISTS setup_discovery_usage") &&
    migration.includes("CREATE TABLE IF NOT EXISTS scan_result_cache") &&
    migration.includes("CREATE TABLE IF NOT EXISTS stripe_webhook_events") &&
    !migration.includes("DELETE FROM users"),
  separateCreditLedgers: repositories.includes("consumeDiscoveryCredits") &&
    repositories.includes("unlock_credits_balance = unlock_credits_balance - 1") &&
    repositories.includes("lifetime_unlocks_used = lifetime_unlocks_used + 1"),
  noSetupNoCharge: signals.includes("const quantity = result.publicResult.valid ? 1 : 0") &&
    signals.includes("recordDiscoveryUsage(user, quantity, scanKey)") &&
    signals.includes("result.publicResult.valid ? 1 : 0, scanKey"),
  cacheIsFiveMinutesAndFree: signals.includes("getCachedScanResult") &&
    signals.includes("cached: true") &&
    repositories.includes("ttlSeconds = 300"),
  scanAllMetersReturnedSetups: signals.includes("allowedSetups.length") &&
    signals.includes("limitedByCredits"),
  unlockDebitIsAtomicWithSave: repositories.indexOf("FOR UPDATE OF c") <
    repositories.indexOf("INSERT INTO saved_signals"),
  rolloverGrantIsAdditive: repositories.includes(
    "unlock_credits_balance = unlock_credits_balance + $2"
  ),
  webhookIdempotency: migration.includes("external_reference text NOT NULL UNIQUE") &&
    stripe.includes("hasStripeWebhookEvent") &&
    stripe.includes("invoice:${invoice.id}"),
  signedWebhooks: stripe.includes("createHmac(\"sha256\"") &&
    stripe.includes("timingSafeEqual") &&
    controller.includes('req.headers["stripe-signature"]'),
  checkoutAndPortal: stripe.includes('"/checkout/sessions"') &&
    stripe.includes('"/billing_portal/sessions"'),
  billingUiComplete: html.includes("Setup discoveries") &&
    html.includes("Unlock credit packs") &&
    html.includes("Manage subscription") &&
    app.includes("data-billing-plan") &&
    app.includes("data-billing-pack"),
  testerUnlimited: getSubscriptionSummary({
    role: "tester",
    plan: "tester",
    subscription: { status: "active" }
  }).unlimitedSignals === true
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Stripe billing check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
