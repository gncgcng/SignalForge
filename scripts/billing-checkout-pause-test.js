import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { appConfig } from "../src/config/appConfig.js";
import { createCheckout } from "../src/modules/subscriptions/stripeService.js";
import { handleSubscriptionRoutes } from "../src/modules/subscriptions/subscriptionController.js";
import { getSubscriptionSummary } from "../src/modules/subscriptions/subscriptionService.js";

// BILLING_CHECKOUT_ENABLED gates new Checkout Sessions. With it off, the checkout endpoint must
// refuse with a JSON error before any Stripe request; with it on, checkout behaves as before.

const stripeCalls = [];
globalThis.fetch = async (url, options = {}) => {
  stripeCalls.push({ url: String(url), method: options.method || "GET" });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ id: "cs_test_pause", url: "https://checkout.stripe.test/session" })
  };
};

Object.assign(appConfig.stripe, {
  secretKey: "sk_test_checkout_pause",
  appUrl: "https://app.test",
  successUrl: "https://app.test/#billing?checkout=success",
  cancelUrl: "https://app.test/#billing?checkout=cancelled",
  prices: { ...appConfig.stripe.prices, monthly: "price_test_monthly", annual: "price_test_annual" }
});

function testUser() {
  return {
    id: "usr_checkout_pause",
    email: "pause@example.invalid",
    name: "Pause Test",
    role: "user",
    plan: "free",
    emailVerifiedAt: new Date(),
    subscription: {
      status: "canceled",
      providerCustomerId: "cus_test_existing",
      stripeMode: "test",
      providerSubscriptionId: null,
      // Subscribed before, so no trial (and no database lookup for trial claims).
      firstSubscribedAt: new Date("2026-01-01T00:00:00Z")
    }
  };
}

function fakeRequest(body, user) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  req.user = user;
  return req;
}

function fakeResponse() {
  return {
    statusCode: null,
    body: "",
    writeHead(status) { this.statusCode = status; },
    setHeader() {},
    end(chunk = "") { this.body += chunk; }
  };
}

async function postCheckout(body) {
  const res = fakeResponse();
  await handleSubscriptionRoutes(fakeRequest(body, testUser()), res, "/api/subscriptions/checkout");
  return { status: res.statusCode, json: JSON.parse(res.body || "{}") };
}

// Flag off (the default): refused, JSON error, no Stripe call, monthly and annual alike.
assert.equal(process.env.BILLING_CHECKOUT_ENABLED, undefined, "run this test without BILLING_CHECKOUT_ENABLED set");
assert.equal(appConfig.stripe.checkoutEnabled, false, "checkout must default to paused");
assert.equal(getSubscriptionSummary(testUser()).checkoutEnabled, false);

for (const body of [{ interval: "month" }, { interval: "year" }]) {
  const response = await postCheckout(body);
  assert.equal(response.status, 403, `paused checkout should be refused for ${JSON.stringify(body)}`);
  assert.match(response.json.error.message, /paused/i);
  assert.equal(response.json.error.details.code, "checkout_paused");
}
await assert.rejects(() => createCheckout(testUser(), { interval: "month" }), (error) => error.code === "checkout_paused");
assert.equal(stripeCalls.length, 0, "a paused checkout must not call Stripe");

// Flag on: unchanged behaviour (existing customer reused, one Checkout Session request).
appConfig.stripe.checkoutEnabled = true;
assert.equal(getSubscriptionSummary(testUser()).checkoutEnabled, true);
const enabled = await postCheckout({ interval: "month" });
assert.equal(enabled.status, 200);
assert.deepEqual(enabled.json.checkout, {
  url: "https://checkout.stripe.test/session",
  id: "cs_test_pause",
  mode: "subscription",
  trial: false
});
assert.deepEqual(stripeCalls.map((call) => `${call.method} ${call.url}`), [
  "POST https://api.stripe.com/v1/checkout/sessions"
]);

console.log(JSON.stringify({
  pausedRefusesPlansAndPacks: true,
  pausedMakesNoStripeCall: true,
  enabledCreatesCheckoutSession: true
}, null, 2));
process.exit(0);
