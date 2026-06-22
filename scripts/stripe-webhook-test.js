import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "development";
process.env.STRIPE_SECRET_KEY = "sk_test_webhook_check";
process.env.STRIPE_PRO_PRICE_ID = "price_pro_webhook";
process.env.STRIPE_ELITE_PRICE_ID = "price_elite_webhook";

const { getPlanEntitlementsForPrice } = await import(
  "../src/modules/subscriptions/stripeService.js"
);

const migration = readFileSync(
  new URL("../migrations/015_stripe_webhook_processing.sql", import.meta.url),
  "utf8"
);
const historyMigration = readFileSync(
  new URL("../migrations/018_stripe_webhook_history.sql", import.meta.url),
  "utf8"
);
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const stripe = readFileSync(
  new URL("../src/modules/subscriptions/stripeService.js", import.meta.url),
  "utf8"
);
const controller = readFileSync(
  new URL("../src/modules/subscriptions/subscriptionController.js", import.meta.url),
  "utf8"
);
const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

assert.deepEqual(getPlanEntitlementsForPrice("price_pro_webhook"), {
  plan: "pro",
  scanCredits: 300,
  unlockCredits: 100
});
assert.deepEqual(getPlanEntitlementsForPrice("price_elite_webhook"), {
  plan: "elite",
  scanCredits: 1000,
  unlockCredits: 500
});

const result = {
  requiredEventsHandled:
    stripe.includes('event.type === "checkout.session.completed"') &&
    stripe.includes('event.type === "invoice.payment_succeeded"') &&
    stripe.includes('event.type === "customer.subscription.deleted"'),
  checkoutSyncsSubscription:
    stripe.includes('stripeGet(`/subscriptions/${encodeURIComponent(subscriptionId)}`)') &&
    stripe.includes('processSubscriptionChanged(subscription, "customer.subscription.created")'),
  invoiceUpdatesSubscription:
    stripe.includes("processInvoicePaymentSucceeded") &&
    stripe.includes("updateStripeSubscription({") &&
    stripe.includes('status: subscription?.status || "active"'),
  proAndEliteCredits:
    stripe.includes("scanCredits: plan.discoveryLimit") &&
    stripe.includes("unlockCredits: plan.monthlyUnlockGrant"),
  entitlementGrantPersisted:
    migration.includes("CREATE TABLE IF NOT EXISTS billing_entitlement_grants") &&
    migration.includes("scan_credits") &&
    migration.includes("unlock_credits") &&
    repositories.includes("grantSubscriptionEntitlements") &&
    repositories.includes("unlock_credits_balance = unlock_credits_balance + $2"),
  safeMigration:
    migration.includes("ADD COLUMN IF NOT EXISTS status") &&
    migration.includes("CREATE INDEX IF NOT EXISTS") &&
    !/\bDELETE\s+FROM\b/i.test(migration) &&
    !/\bDROP\s+(TABLE|COLUMN)\b/i.test(migration),
  duplicateEventsIgnored:
    repositories.includes("ON CONFLICT (event_id) DO UPDATE") &&
    repositories.includes("WHERE stripe_webhook_events.status = 'failed'") &&
    stripe.includes("return { duplicate: true }"),
  failedEventsRetryable:
    migration.includes("status IN ('processing', 'processed', 'failed')") &&
    repositories.includes("failStripeWebhookEvent") &&
    repositories.includes("status = 'failed'") &&
    repositories.includes("processing_started_at < now() - interval '10 minutes'") &&
    stripe.includes("retryStripeWebhookEvent"),
  paidEventsCannotSilentlySucceed:
    stripe.includes('throw retryableWebhookError("Unable to resolve the checkout user.")') &&
    stripe.includes('throw retryableWebhookError("Unable to resolve the invoice user.")') &&
    stripe.includes('throw retryableWebhookError("Unable to resolve the subscription user.")'),
  checkoutUpgradesImmediately:
    stripe.includes('status: "active"') &&
    stripe.includes("plan: planId") &&
    stripe.includes("activateAffiliateReferral(userId, planId)"),
  durableEventHistory:
    historyMigration.includes("ADD COLUMN IF NOT EXISTS payload_json jsonb") &&
    historyMigration.includes("ADD COLUMN IF NOT EXISTS result_json jsonb") &&
    historyMigration.includes("ADD COLUMN IF NOT EXISTS completed_at timestamptz") &&
    repositories.includes("listStripeWebhookEvents") &&
    repositories.includes("getRetryableStripeWebhookEvent"),
  adminEventHistory:
    controller.includes("/api/admin/stripe/webhooks") &&
    controller.includes("isAdminUser(req.user)") &&
    html.includes('data-view="webhook-events"') &&
    frontend.includes("renderWebhookEvents") &&
    frontend.includes("data-webhook-retry"),
  safeFailureLogging:
    stripe.includes("sanitizeStripeError") &&
    stripe.includes("[redacted-key]") &&
    stripe.includes("[redacted-webhook-secret]") &&
    controller.includes("Webhook request failed status=") &&
    controller.includes("Stripe webhook processing failed.") &&
    controller.includes("Stripe webhook rejected.") &&
    !controller.includes("STRIPE_SECRET_KEY"),
  cancellationDowngrades:
    stripe.includes('eventType.endsWith(".deleted") ? "canceled"') &&
    stripe.includes('const plan = active ? planFromPrice(priceId) : "free"'),
  billingAutoRefresh:
    frontend.includes("refreshBillingAfterCheckout()") &&
    frontend.includes("await loadSubscription()") &&
    frontend.includes("Purchase confirmed. Billing credits are updated.")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Stripe webhook check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
