import assert from "node:assert/strict";

process.env.NODE_ENV = "development";
process.env.STRIPE_SECRET_KEY = "sk_test_account_deletion_check";

const { appConfig } = await import("../src/config/appConfig.js");
const { cancelSubscription, deleteStripeCustomer } = await import("../src/modules/subscriptions/stripeService.js");
const { installStripeAccountDeletionMock } = await import("./test-support/stripe-account-deletion-mock.js");

const mock = installStripeAccountDeletionMock();
const { calls, deletes, gets } = mock;

function subs(prefix, count, status = "active") {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}_${i + 1}`, status }));
}

function user(subscription) {
  return { id: "usr_test", subscription: { stripeMode: "test", ...subscription } };
}

function reset(state, { pageSize = null, fail = null, ...rest } = {}) {
  mock.reset(state, { pageSize, failList: fail, ...rest });
}

const RETRY_MESSAGE = "We couldn't verify your subscription, so your account was not deleted. Please try again.";
const isTransient = (error) => error.statusCode === 503 && error.code === "subscription_check_unavailable" &&
  error.message === RETRY_MESSAGE;
const isPermanent = (error) => error.statusCode === 502 && error.code === "subscription_check_failed" &&
  /contact support/.test(error.message) && !/try again/i.test(error.message);

// 1. No Stripe customer at all: nothing to do, no API calls.
reset({});
assert.deepEqual(
  await cancelSubscription(user({ status: "trialing", providerCustomerId: null, providerSubscriptionId: null })),
  { canceledSubscriptionIds: [], checkedStripe: false }
);
assert.equal(calls.length, 0);

// 2. Active subscription: cancelled immediately via DELETE (not cancel_at_period_end).
reset({ cus_active: [{ id: "sub_active", status: "active" }] });
let result = await cancelSubscription(user({ status: "active", providerCustomerId: "cus_active", providerSubscriptionId: "sub_active" }));
assert.deepEqual(result, { canceledSubscriptionIds: ["sub_active"], checkedStripe: true });
assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
  "GET /subscriptions?customer=cus_active&limit=100",
  "DELETE /subscriptions/sub_active"
]);
assert.equal(mock.customers.cus_active[0].status, "canceled");

// 3. Stripe knows about a subscription our DB missed (lost webhook): still cancelled.
reset({ cus_drift: [
  { id: "sub_old", status: "canceled" },
  { id: "sub_unknown_to_db", status: "past_due" }
] });
result = await cancelSubscription(user({ status: "canceled", providerCustomerId: "cus_drift", providerSubscriptionId: null }));
assert.deepEqual(result.canceledSubscriptionIds, ["sub_unknown_to_db"]);
assert.ok(!calls.some((c) => c.path === "/subscriptions/sub_old"), "already-cancelled subs are not re-cancelled");

// 4. Customer with only terminal subscriptions: checked, nothing cancelled. Idempotent on repeat.
reset({ cus_done: [{ id: "sub_done", status: "canceled" }, { id: "sub_exp", status: "incomplete_expired" }] });
result = await cancelSubscription(user({ status: "canceled", providerCustomerId: "cus_done" }));
assert.deepEqual(result, { canceledSubscriptionIds: [], checkedStripe: true });
assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);

// 5. Stripe does not confirm cancellation: throws, so deletion must not proceed.
reset({ cus_stuck: [{ id: "sub_stuck", status: "active", failCancel: true }] });
await assert.rejects(
  cancelSubscription(user({ status: "active", providerCustomerId: "cus_stuck", providerSubscriptionId: "sub_stuck" })),
  (error) => error.statusCode === 502 && error.code === "subscription_cancel_failed" && /try again/.test(error.message)
);

// 6. Unknown customer (resource_missing): permanent, user told to contact support, not Stripe's raw text.
reset({});
await assert.rejects(
  cancelSubscription(user({ status: "active", providerCustomerId: "cus_missing", providerSubscriptionId: "sub_x" })),
  (error) => isPermanent(error) && !/No such customer/.test(error.message) &&
    error.cause?.stripeCode === "resource_missing" && /No such customer/.test(error.cause.message)
);
assert.equal(deletes().length, 0);

// 6b. Transient list failures (429, 5xx, network): retry message. 401/403: permanent.
const activeUser = user({ status: "active", providerCustomerId: "cus_t", providerSubscriptionId: "sub_t_1" });
for (const [fail, check] of [
  [{ page: 1, status: 429, body: { error: { code: "rate_limit", type: "invalid_request_error", message: "Too many requests" } } }, isTransient],
  [{ page: 1, status: 500, body: { error: { type: "api_error", message: "Internal error" } } }, isTransient],
  [{ page: 1, status: 503, body: "<html>not json</html>" }, isTransient],
  [{ page: 1, network: true }, isTransient],
  [{ page: 1, status: 401, body: { error: { type: "invalid_request_error", message: "Invalid API Key provided" } } }, isPermanent],
  [{ page: 1, status: 403, body: { error: { type: "invalid_request_error", message: "The provided key does not have access" } } }, isPermanent]
]) {
  reset({ cus_t: subs("sub_t", 1) }, { fail });
  await assert.rejects(cancelSubscription(activeUser), check, JSON.stringify(fail));
  assert.equal(deletes().length, 0);
}

// 7. Customer from the other Stripe mode + locally billable: can't verify, fail closed without calling Stripe.
reset({});
await assert.rejects(
  cancelSubscription({ id: "usr_test", subscription: { stripeMode: "live", status: "active", providerCustomerId: "cus_live", providerSubscriptionId: "sub_live" } }),
  (error) => error.statusCode === 409 && error.code === "subscription_unverifiable"
);
assert.equal(calls.length, 0);

// 8. Customer from the other mode but nothing billable locally: allowed through.
result = await cancelSubscription({ id: "usr_test", subscription: { stripeMode: "live", status: "canceled", providerCustomerId: "cus_live" } });
assert.deepEqual(result, { canceledSubscriptionIds: [], checkedStripe: false });

// 9. Stripe not configured + locally active: fail closed.
const savedKey = appConfig.stripe.secretKey;
appConfig.stripe.secretKey = "";
await assert.rejects(
  cancelSubscription(user({ status: "active", providerCustomerId: "cus_active", providerSubscriptionId: "sub_active" })),
  (error) => error.code === "subscription_unverifiable"
);
appConfig.stripe.secretKey = savedKey;

// 10. Two pages (has_more true, then false): every page is fetched before any DELETE, and subs on both pages are cancelled.
reset({ cus_paged: [...subs("sub_p", 3), { id: "sub_p_old", status: "canceled" }] }, { pageSize: 2 });
result = await cancelSubscription(user({ status: "active", providerCustomerId: "cus_paged", providerSubscriptionId: "sub_p_1" }));
assert.deepEqual(result, { canceledSubscriptionIds: ["sub_p_1", "sub_p_2", "sub_p_3"], checkedStripe: true });
assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
  "GET /subscriptions?customer=cus_paged&limit=100",
  "GET /subscriptions?customer=cus_paged&limit=100&starting_after=sub_p_2",
  "DELETE /subscriptions/sub_p_1",
  "DELETE /subscriptions/sub_p_2",
  "DELETE /subscriptions/sub_p_3"
]);

// 11. Page 2 errors: fail closed, nothing cancelled (and deleteAccount never reaches deleteAccountData).
reset({ cus_page_err: subs("sub_e", 3) }, { pageSize: 2, fail: { page: 2, status: 500, body: { error: { type: "api_error", message: "Stripe API error" } } } });
await assert.rejects(
  cancelSubscription(user({ status: "active", providerCustomerId: "cus_page_err", providerSubscriptionId: "sub_e_1" })),
  isTransient
);
assert.equal(gets().length, 2);
assert.equal(deletes().length, 0);
assert.ok(mock.customers.cus_page_err.every((item) => item.status === "active"));

// 12. Page cap exceeded (21 pages at 1 per page, cap is 20): refuse, nothing cancelled.
reset({ cus_huge: subs("sub_h", 21) }, { pageSize: 1 });
await assert.rejects(
  cancelSubscription(user({ status: "active", providerCustomerId: "cus_huge", providerSubscriptionId: "sub_h_1" })),
  (error) => error.statusCode === 409 && error.code === "too_many_subscriptions"
);
assert.equal(gets().length, 20);
assert.equal(deletes().length, 0);

// 12b. Exactly at the cap (20 pages, last has has_more=false): allowed.
reset({ cus_at_cap: subs("sub_c", 20) }, { pageSize: 1 });
result = await cancelSubscription(user({ status: "active", providerCustomerId: "cus_at_cap", providerSubscriptionId: "sub_c_1" }));
assert.equal(result.canceledSubscriptionIds.length, 20);
assert.equal(gets().length, 20);

// 13. Single page: one GET, no starting_after, same result as before.
reset({ cus_single: subs("sub_s", 2) });
result = await cancelSubscription(user({ status: "active", providerCustomerId: "cus_single", providerSubscriptionId: "sub_s_1" }));
assert.deepEqual(result, { canceledSubscriptionIds: ["sub_s_1", "sub_s_2"], checkedStripe: true });
assert.equal(gets().length, 1);
assert.ok(!gets()[0].path.includes("starting_after"));

// 14. Sub flips to canceled between list and DELETE: fail closed with a retry message; a retry re-lists and skips it.
reset({ cus_race: [{ id: "sub_r_1", status: "active", canceledConcurrently: true }, { id: "sub_r_2", status: "active" }] });
const raceUser = user({ status: "active", providerCustomerId: "cus_race", providerSubscriptionId: "sub_r_1" });
await assert.rejects(
  cancelSubscription(raceUser),
  (error) => error.statusCode === 502 && error.code === "subscription_cancel_failed" &&
    /not deleted/.test(error.message) && /try again/i.test(error.message) && /canceled subscription/.test(error.cause?.message)
);
assert.equal(mock.customers.cus_race[1].status, "active", "later subs are not touched after a failure");
calls.length = 0;
result = await cancelSubscription(raceUser);
assert.deepEqual(result, { canceledSubscriptionIds: ["sub_r_2"], checkedStripe: true });
assert.ok(!deletes().some((c) => c.path === "/subscriptions/sub_r_1"));

// 15. deleteStripeCustomer success: DELETE /customers/<id>, Stripe confirms deleted: true.
reset({ cus_del: subs("sub_d", 1, "canceled") });
assert.deepEqual(await deleteStripeCustomer("cus_del"), { deleted: true, alreadyDeleted: false });
assert.deepEqual(mock.trace(), ["DELETE /customers/cus_del"]);

// 16. Already deleted (resource_missing): success, so a retry after a partial failure works.
reset({ cus_gone: [] }, { deletedCustomers: ["cus_gone"] });
assert.deepEqual(await deleteStripeCustomer("cus_gone"), { deleted: true, alreadyDeleted: true });

// 17. Customer delete errors reuse the transient/permanent classes.
const customerErrorCases = [
  [{ status: 503, body: { error: { type: "api_error", message: "Service unavailable" } } }, isTransient],
  [{ status: 429, body: { error: { code: "rate_limit", message: "Too many requests" } } }, isTransient],
  [{ network: true }, isTransient],
  [{ status: 200, body: { id: "cus_x", object: "customer" } }, isTransient], // no deleted: true
  [{ status: 401, body: { error: { type: "invalid_request_error", message: "Invalid API Key provided" } } }, isPermanent],
  [{ status: 403, body: { error: { type: "invalid_request_error", message: "No access" } } }, isPermanent]
];
for (const [failCustomerDelete, check] of customerErrorCases) {
  reset({ cus_x: [] }, { failCustomerDelete });
  await assert.rejects(deleteStripeCustomer("cus_x"), check, JSON.stringify(failCustomerDelete));
}

// 18. Retry after the customer was already deleted: the list call reports resource_missing,
// a retrieve confirms the deleted stub, and cancelSubscription succeeds with nothing to cancel.
reset({ cus_retry: subs("sub_rt", 1, "canceled") }, { deletedCustomers: ["cus_retry"] });
result = await cancelSubscription(user({ status: "active", providerCustomerId: "cus_retry", providerSubscriptionId: "sub_rt_1" }));
assert.deepEqual(result, { canceledSubscriptionIds: [], checkedStripe: true, customerAlreadyDeleted: true });
assert.deepEqual(mock.trace(), [
  "GET /subscriptions?customer=cus_retry&limit=100",
  "GET /customers/cus_retry"
]);

// 19. resource_missing on the list and the retrieve fails transiently: transient, not permanent.
reset({});
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => String(url).includes("/customers/")
  ? (mock.calls.push({ method: "GET", path: "/customers/cus_blip" }), { ok: false, status: 503, json: async () => ({ error: { type: "api_error", message: "down" } }) })
  : realFetch(url, init);
await assert.rejects(
  cancelSubscription(user({ status: "active", providerCustomerId: "cus_blip", providerSubscriptionId: "sub_b" })),
  isTransient
);
globalThis.fetch = realFetch;

console.log(JSON.stringify({ cancelSubscription: "ok", deleteStripeCustomer: "ok", scenarios: 21 }, null, 2));
