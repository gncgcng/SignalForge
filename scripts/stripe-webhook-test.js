import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "development";
process.env.STRIPE_SECRET_KEY = "sk_test_webhook_check";
process.env.STRIPE_PRICE_MONTHLY = "price_monthly_webhook";
process.env.STRIPE_PRICE_ANNUAL = "price_annual_webhook";

const { intervalForPrice } = await import("../src/modules/subscriptions/subscriptionService.js");

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

// One plan: the two prices map to an interval; anything else is unknown (and grants nothing).
assert.equal(intervalForPrice("price_monthly_webhook"), "month");
assert.equal(intervalForPrice("price_annual_webhook"), "year");
assert.equal(intervalForPrice("price_something_else"), null);

const result = {
  requiredEventsHandled:
    stripe.includes('event.type === "checkout.session.completed"') &&
    stripe.includes('event.type === "invoice.paid"') &&
    stripe.includes('event.type === "invoice.payment_failed"') &&
    stripe.includes('event.type === "customer.subscription.created"') &&
    stripe.includes('event.type === "customer.subscription.updated"') &&
    stripe.includes('event.type === "customer.subscription.deleted"') &&
    stripe.includes('event.type === "customer.subscription.trial_will_end"') &&
    stripe.includes('event.type === "charge.refunded"'),
  productionWebhookRoute:
    controller.includes('pathname === "/api/stripe/webhook"') &&
    controller.includes('pathname === "/api/subscriptions/webhook"') &&
    controller.indexOf('pathname === "/api/stripe/webhook"') <
      controller.indexOf('if (!pathname.startsWith("/api/subscriptions"))') &&
    controller.includes("verifyStripeSignature(rawBody, req.headers[\"stripe-signature\"]") &&
    controller.includes("processStripeEvent(event)"),
  // Pivot phase 3: checkout reads the subscription's own status from Stripe; nothing assumes "active".
  checkoutSyncsSubscription:
    stripe.includes('stripeGet(`/subscriptions/${encodeURIComponent(subscriptionId)}`)') &&
    stripe.includes('processSubscriptionChanged(subscription, "checkout.session.completed"'),
  invoiceUpdatesSubscription:
    stripe.includes("async function processInvoicePaid(") &&
    stripe.includes("updateStripeSubscription({") &&
    !stripe.includes('status: subscription?.status || "active"'),
  noCreditGrants:
    !stripe.includes("grantSubscriptionEntitlements") &&
    !stripe.includes("grantUnlockCredits") &&
    stripe.includes('return { action: "zero_amount_invoice_ignored", userId: null };'),
  entitlementGrantPersisted:
    // Kept for history only: the table stays, nothing writes to it any more.
    migration.includes("CREATE TABLE IF NOT EXISTS billing_entitlement_grants"),
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
  checkoutNeverAssumesActive:
    !stripe.includes('status: "active"') &&
    !stripe.includes("activateAffiliateReferral(userId"),
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
    stripe.includes('const status = deleted ? "canceled" : String(subscription.status || "incomplete");') &&
    stripe.includes('plan: paid ? PLAN.id : "free"'),
  billingAutoRefresh:
    frontend.includes("refreshBillingAfterCheckout()") &&
    frontend.includes("await loadSubscription()") &&
    frontend.includes("Confirmed. Your plan is active.")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Stripe webhook check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
