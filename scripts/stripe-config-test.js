import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "development";
process.env.STRIPE_SECRET_KEY = "sk_test_configuration_check";
delete process.env.STRIPE_WEBHOOK_SECRET;
process.env.STRIPE_PRO_PRICE_ID = "price_test_pro";
process.env.STRIPE_ELITE_PRICE_ID = "price_test_elite";
process.env.STRIPE_CREDITS_10_PRICE_ID = "price_test_10";
process.env.STRIPE_CREDITS_50_PRICE_ID = "price_test_50";
process.env.STRIPE_CREDITS_100_PRICE_ID = "price_test_100";

const {
  appConfig,
  getStripeConfigurationStatus,
  logStripeConfiguration,
  stripeEnvironmentKeys
} = await import("../src/config/appConfig.js");
const { CREDIT_PACKS } = await import("../src/modules/subscriptions/subscriptionService.js");
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
      providerSubscriptionId: null
    }
  }, { pack: "pack10" });
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
  "STRIPE_PRO_PRICE_ID",
  "STRIPE_ELITE_PRICE_ID",
  "STRIPE_CREDITS_10_PRICE_ID",
  "STRIPE_CREDITS_50_PRICE_ID",
  "STRIPE_CREDITS_100_PRICE_ID"
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
    appConfig.stripe.prices.pack10 === "price_test_10" &&
    appConfig.stripe.prices.pack50 === "price_test_50" &&
    appConfig.stripe.prices.pack100 === "price_test_100",
  packQuantitiesMatch: CREDIT_PACKS.pack10.quantity === 10 &&
    CREDIT_PACKS.pack50.quantity === 50 &&
    CREDIT_PACKS.pack100.quantity === 100,
  testModeDetected: status.mode === "test" && status.checkoutConfigured === true,
  webhookIndependent: status.webhookConfigured === false &&
    !checkoutFunction.includes("webhookSecret") &&
    webhookFunction.includes("STRIPE_WEBHOOK_SECRET"),
  safeStartupLogging: serverSource.includes("logStripeConfiguration()") &&
    startupLog.includes("STRIPE_SECRET_KEY") &&
    startupLog.includes("STRIPE_WEBHOOK_SECRET") &&
    !startupLog.includes(process.env.STRIPE_SECRET_KEY) &&
    !startupLog.includes(process.env.STRIPE_PRO_PRICE_ID),
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
    checkoutRequest.body["line_items[0][price]"] === process.env.STRIPE_CREDITS_10_PRICE_ID &&
    checkoutRequest.body.mode === "payment"
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Stripe configuration check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
