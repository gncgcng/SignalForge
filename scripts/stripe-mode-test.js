import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "development";
process.env.STRIPE_SECRET_KEY = "sk_test_mode_check";

const { getStripeMode } = await import("../src/config/appConfig.js");
const { getSubscriptionSummary } = await import(
  "../src/modules/subscriptions/subscriptionService.js"
);
const { shouldReuseStripeCustomer } = await import(
  "../src/modules/subscriptions/stripeService.js"
);

const migration = readFileSync(
  new URL("../migrations/014_stripe_customer_mode.sql", import.meta.url),
  "utf8"
);
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const stripeService = readFileSync(
  new URL("../src/modules/subscriptions/stripeService.js", import.meta.url),
  "utf8"
);
const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const mismatchSummary = getSubscriptionSummary({
  id: "usr_mode",
  email: "admin@example.com",
  role: "user",
  plan: "free",
  unlockCreditsBalance: 3,
  subscription: {
    status: "trialing",
    providerCustomerId: "cus_live_old",
    stripeMode: "live",
    providerSubscriptionId: "sub_live_old"
  }
});

const result = {
  detectsSecretKeyMode:
    getStripeMode("sk_test_example") === "test" &&
    getStripeMode("sk_live_example") === "live" &&
    getStripeMode("") === "unconfigured",
  safeIdempotentMigration:
    migration.includes("ADD COLUMN IF NOT EXISTS stripe_mode") &&
    migration.includes("stripe_mode IN ('test', 'live')") &&
    migration.includes("CREATE INDEX IF NOT EXISTS") &&
    !/\bDELETE\s+FROM\b/i.test(migration) &&
    !/\bDROP\s+(TABLE|COLUMN)\b/i.test(migration),
  onlyReusesMatchingMode:
    shouldReuseStripeCustomer("cus_test", "test", "test") &&
    !shouldReuseStripeCustomer("cus_live", "live", "test") &&
    !shouldReuseStripeCustomer("cus_unknown", null, "test"),
  modeStoredWithCustomer:
    repositories.includes("SET provider_customer_id = $2") &&
    repositories.includes("stripe_mode = $3") &&
    repositories.includes("stripeMode: row.stripe_mode"),
  staleModeReferencesCleared:
    repositories.includes("provider_subscription_id = CASE WHEN $4 THEN NULL") &&
    repositories.includes("price_id = CASE WHEN $4 THEN NULL") &&
    stripeService.includes("user.subscription.providerSubscriptionId = null"),
  webhookLookupIsModeScoped:
    repositories.includes("provider_customer_id = $1 AND stripe_mode = $2") &&
    stripeService.includes("findUserByStripeCustomer(customerId, getStripeMode())"),
  mismatchCreatesNewCustomer:
    stripeService.includes("storedMode !== currentMode") &&
    stripeService.includes("creating a new customer") &&
    stripeService.includes("updateStripeCustomer(user.id, customer.id, currentMode, modeMismatch)"),
  warningIsDebugOnly:
    mismatchSummary.customerPortalAvailable === false &&
    mismatchSummary.stripeConfiguration.customerModeWarning.includes(
      "A new customer will be created automatically."
    ) &&
    frontend.includes("config.customerModeWarning"),
  warningDoesNotExposeCustomerId:
    !stripeService.includes("storedCustomerId}; creating") &&
    !mismatchSummary.stripeConfiguration.customerModeWarning.includes("cus_live_old")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Stripe mode check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
