import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "development";
delete process.env.APP_URL;
process.env.STRIPE_SECRET_KEY = "sk_test_configuration_check";
delete process.env.STRIPE_WEBHOOK_SECRET;
// Pivot phase 3: one plan with a monthly and an annual price.
process.env.STRIPE_PRICE_MONTHLY = "price_test_monthly";
process.env.STRIPE_PRICE_ANNUAL = "price_test_annual";
// These checks cover checkout itself, so they run with new checkouts enabled (default is paused).
process.env.BILLING_CHECKOUT_ENABLED = "true";

const {
  appConfig,
  getStripeConfigurationStatus,
  logStripeConfiguration,
  resolveAppUrl,
  stripeEnvironmentKeys
} = await import("../src/config/appConfig.js");
const { createCheckout } = await import("../src/modules/subscriptions/stripeService.js");

const configSource = readFileSync(new URL("../src/config/appConfig.js", import.meta.url), "utf8");
const stripeSource = readFileSync(
  new URL("../src/modules/subscriptions/stripeService.js", import.meta.url),
  "utf8"
);
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

const status = getStripeConfigurationStatus();
let checkoutRequest = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  checkoutRequest = {
    url,
    authorization: options.headers.authorization,
    body: Object.fromEntries(options.body.entries())
  };
  return {
    ok: true,
    async json() {
      return {
        id: "cs_test_signalforge",
        url: "https://checkout.stripe.com/c/pay/cs_test_signalforge"
      };
    }
  };
};
let checkout;
try {
  checkout = await createCheckout({
    id: "usr_test",
    email: "test@example.com",
    name: "Test User",
    subscription: {
      providerCustomerId: "cus_test_signalforge",
      stripeMode: "test",
      providerSubscriptionId: null,
      // Subscribed before: no trial, and no database lookup for trial claims.
      firstSubscribedAt: new Date("2026-01-01T00:00:00Z")
    }
  }, { interval: "month" });
} finally {
  globalThis.fetch = originalFetch;
}

let startupLog = "";
const originalInfo = console.info;
console.info = (message) => {
  startupLog += String(message);
};
try {
  logStripeConfiguration();
} finally {
  console.info = originalInfo;
}

const expectedKeys = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_MONTHLY",
  "STRIPE_PRICE_ANNUAL"
];

const checkoutFunction = stripeSource.match(
  /export async function createCheckout[\s\S]*?export async function createCustomerPortal/
)?.[0] || "";
const webhookFunction = stripeSource.match(
  /export function verifyStripeSignature[\s\S]*?export async function processStripeEvent/
)?.[0] || "";

const result = {
  exactRailwayKeys: JSON.stringify(stripeEnvironmentKeys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => configSource.includes(`process.env.${key}`)) &&
    expectedKeys.every((key) => envExample.includes(`${key}=`)),
  legacyPackKeysRemoved:
    !configSource.includes("STRIPE_CREDIT_PACK_25_PRICE_ID") &&
    !configSource.includes("STRIPE_CREDIT_PACK_300_PRICE_ID") &&
    !envExample.includes("STRIPE_CREDIT_PACK_"),
  exactPriceMapping:
    appConfig.stripe.prices.monthly === "price_test_monthly" &&
    appConfig.stripe.prices.annual === "price_test_annual" &&
    Object.keys(appConfig.stripe.prices).join(",") === "monthly,annual",
  creditPackKeysRemoved:
    !configSource.includes("STRIPE_CREDITS_10_PRICE_ID") &&
    !envExample.includes("STRIPE_CREDITS_10_PRICE_ID") &&
    !configSource.includes("STRIPE_PRO_PRICE_ID"),
  testModeDetected: status.mode === "test" && status.checkoutConfigured === true,
  webhookIndependent: status.webhookConfigured === false &&
    !checkoutFunction.includes("webhookSecret") &&
    webhookFunction.includes("STRIPE_WEBHOOK_SECRET"),
  safeStartupLogging: serverSource.includes("logStripeConfiguration()") &&
    startupLog.includes("STRIPE_SECRET_KEY") &&
    startupLog.includes("STRIPE_WEBHOOK_SECRET") &&
    !startupLog.includes(process.env.STRIPE_SECRET_KEY) &&
    !startupLog.includes(process.env.STRIPE_PRICE_MONTHLY),
  appUrlRedirects:
    appConfig.stripe.successUrl === "http://localhost:4173/#billing?checkout=success" &&
    appConfig.stripe.cancelUrl === "http://localhost:4173/#billing?checkout=cancelled" &&
    checkoutRequest.body.success_url === appConfig.stripe.successUrl &&
    checkoutRequest.body.cancel_url === appConfig.stripe.cancelUrl,
  productionDoesNotFallbackToLocalhost:
    resolveAppUrl("", "production", 4173) === "" &&
    resolveAppUrl("", "development", 4173) === "http://localhost:4173" &&
    resolveAppUrl("https://signalforge.example.com///", "production") ===
      "https://signalforge.example.com",
  legacyRedirectVariablesRemoved:
    !configSource.includes("process.env.STRIPE_SUCCESS_URL") &&
    !configSource.includes("process.env.STRIPE_CANCEL_URL") &&
    !envExample.includes("STRIPE_SUCCESS_URL=") &&
    !envExample.includes("STRIPE_CANCEL_URL=") &&
    envExample.includes("APP_URL=http://localhost:4173"),
  developmentDiagnostics: stripeSource.includes("missing ${key}") &&
    frontend.includes("Missing Stripe configuration:") &&
    frontend.includes("STRIPE_WEBHOOK_SECRET"),
  checkoutUsesBearerSecret: stripeSource.includes(
    "authorization: `Bearer ${appConfig.stripe.secretKey}`"
  ),
  testModeCheckoutWorks:
    checkout.url.includes("checkout.stripe.com") &&
    checkoutRequest.url.endsWith("/checkout/sessions") &&
    checkoutRequest.authorization === `Bearer ${process.env.STRIPE_SECRET_KEY}` &&
    checkoutRequest.body["line_items[0][price]"] === process.env.STRIPE_PRICE_MONTHLY &&
    checkoutRequest.body.mode === "subscription" &&
    checkoutRequest.body.payment_method_collection === "always"
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Stripe configuration check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
