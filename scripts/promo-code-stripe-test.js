import assert from "node:assert/strict";

// Mocked-Stripe test for the promo Stripe helpers: exact version header and params on the
// wire, and orphaned-coupon cleanup when the promotion-code call fails. No database needed:
// every scenario either calls the helpers directly or fails before the promo row insert.
process.env.NODE_ENV = "development";
process.env.STRIPE_SECRET_KEY = "sk_test_promo_code_stripe_check";

const {
  createPromoCoupon,
  createPromoPromotionCode,
  deletePromoCoupon,
  updatePromoPromotionCodeActive
} = await import("../src/modules/subscriptions/stripeService.js");
const { createPromoCode } = await import("../src/modules/promo-codes/promoCodeService.js");

const VERSION = "2025-09-30.clover";
const calls = [];
let responders = {};

globalThis.fetch = async (url, init = {}) => {
  const method = init.method || "GET";
  const path = String(url).replace("https://api.stripe.com/v1", "");
  const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
  calls.push({ method, path, headers: init.headers || {}, body });
  const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
  const key = `${method} ${path.replace(/\/(coupon|promo)_[A-Za-z0-9]+$/, "/:id")}`;
  const respond = responders[key];
  if (!respond) throw new Error(`Unexpected Stripe call ${method} ${path}`);
  return respond(json, body);
};

function reset(next) {
  calls.length = 0;
  responders = next;
}

const okResponders = {
  "POST /coupons": (json) => json(200, { id: "coupon_ok", object: "coupon" }),
  "POST /promotion_codes": (json, body) => json(200, { id: "promo_ok", object: "promotion_code", code: body.code }),
  "POST /promotion_codes/:id": (json, body) => json(200, { id: "promo_ok", active: body.active === "true" }),
  "DELETE /coupons/:id": (json) => json(200, { id: "coupon_ok", object: "coupon", deleted: true })
};
const stripe400 = (json) => json(400, { error: {
  type: "invalid_request_error", code: "resource_already_exists",
  message: "An active promotion code with `code: SPRING25` already exists."
} });
const admin = { id: "usr_admin_promo_test" };
const discountInput = { type: "stripe_discount", code: "spring25", maxRedemptions: 5, discountPercentOff: 25 };

const captured = { warn: [], error: [] };
const original = { warn: console.warn, error: console.error };
console.warn = (...args) => captured.warn.push(args.join(" "));
console.error = (...args) => captured.error.push(args.join(" "));

try {
  // (a) Success path: exact version header and params on the wire for all three helpers.
  reset(okResponders);
  const expiresAt = new Date("2030-01-01T00:00:00Z");
  const coupon = await createPromoCoupon({ percentOff: 25, amountOffCents: null, maxRedemptions: 5, expiresAt });
  const promo = await createPromoPromotionCode({ couponId: coupon.id, code: "SPRING25", maxRedemptions: 5, expiresAt });
  await updatePromoPromotionCodeActive(promo.id, false);
  await deletePromoCoupon(coupon.id);

  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "POST /coupons",
    "POST /promotion_codes",
    "POST /promotion_codes/promo_ok",
    "DELETE /coupons/coupon_ok"
  ]);
  for (const call of calls) {
    assert.equal(call.headers["stripe-version"], VERSION, `${call.method} ${call.path} version header`);
    assert.equal(call.headers.authorization, "Bearer sk_test_promo_code_stripe_check");
  }
  assert.deepEqual(calls[0].body, {
    percent_off: "25", duration: "once", max_redemptions: "5", redeem_by: "1893456000"
  });
  assert.deepEqual(calls[1].body, {
    "promotion[type]": "coupon",
    "promotion[coupon]": "coupon_ok",
    code: "SPRING25",
    max_redemptions: "5",
    expires_at: "1893456000"
  });
  assert.ok(!("coupon" in calls[1].body), "no top-level coupon param");
  assert.deepEqual(calls[2].body, { active: "false" });
  assert.deepEqual(calls[3].body, {});

  // (b) Stripe 400 on the promotion-code call: coupon deleted, admin sees Stripe's message.
  reset({ ...okResponders, "POST /promotion_codes": stripe400 });
  await assert.rejects(createPromoCode(admin, discountInput), (error) =>
    error.statusCode === 400 && error.message === "An active promotion code with `code: SPRING25` already exists."
  );
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "POST /coupons",
    "POST /promotion_codes",
    "DELETE /coupons/coupon_ok"
  ]);
  assert.equal(calls[2].headers["stripe-version"], VERSION);
  assert.ok(captured.warn.some((line) => line.includes("deleted orphaned Stripe coupon=coupon_ok")));

  // (c) Cleanup DELETE also fails: the original promotion-code error still surfaces, cleanup failure is logged.
  captured.warn.length = 0;
  captured.error.length = 0;
  reset({
    ...okResponders,
    "POST /promotion_codes": stripe400,
    "DELETE /coupons/:id": (json) => json(500, { error: { type: "api_error", message: "Stripe is down" } })
  });
  await assert.rejects(createPromoCode(admin, discountInput), (error) =>
    error.statusCode === 400 && /already exists/.test(error.message) && !/Stripe is down/.test(error.message)
  );
  assert.equal(calls.at(-1).method, "DELETE");
  assert.ok(captured.error.some((line) =>
    line.includes("orphaned Stripe coupon=coupon_ok could not be deleted") &&
    line.includes("already exists") && line.includes("Stripe is down")
  ));

  // (c2) Cleanup DELETE throws a network error: same outcome.
  reset({
    ...okResponders,
    "POST /promotion_codes": stripe400,
    "DELETE /coupons/:id": () => { throw new TypeError("fetch failed"); }
  });
  await assert.rejects(createPromoCode(admin, discountInput), (error) => /already exists/.test(error.message));

  // Coupon creation itself fails: nothing to clean up, no DELETE.
  reset({ ...okResponders, "POST /coupons": stripe400 });
  await assert.rejects(createPromoCode(admin, discountInput), (error) => error.statusCode === 400);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /coupons"]);
} finally {
  console.warn = original.warn;
  console.error = original.error;
}

console.log(JSON.stringify({ promoCodeStripe: "ok", scenarios: 5 }, null, 2));
