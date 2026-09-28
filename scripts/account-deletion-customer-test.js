// Account deletion with a mocked Stripe against the local database: Stripe customer deletion
// (success, already deleted, transient, permanent, retry after a failed DB transaction) and
// webhook events that arrive for the deleted customer afterwards.
// Requires DATABASE_URL (local docker-compose Postgres). Never run against production.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";

process.env.NODE_ENV = "development";
process.env.STRIPE_SECRET_KEY = "sk_test_account_deletion_customer_check";

const { getPool, query } = await import("../src/db/client.js");
const { deleteAccount } = await import("../src/modules/account-deletion/accountDeletionService.js");
const { processStripeEvent } = await import("../src/modules/subscriptions/stripeService.js");
const { findUserById, updateStripeSubscription } = await import("../src/db/repositories.js");
const { installStripeAccountDeletionMock } = await import("./test-support/stripe-account-deletion-mock.js");
const fixtures = await import("./account-deletion-fixtures.js");

const mock = installStripeAccountDeletionMock();
const helperIds = [];
const eventIds = [];
const input = { password: "helper-password", confirmation: "DELETE" };
let ipCounter = 20;
const req = () => ({ headers: {}, socket: { remoteAddress: `127.0.1.${ipCounter++}` } });
const isTransient = (error) => error.statusCode === 503 && error.code === "subscription_check_unavailable" && /try again/i.test(error.message);
const isPermanent = (error) => error.statusCode === 502 && error.code === "subscription_check_failed" && /contact support/.test(error.message);

const affiliateId = await fixtures.createHelperUser("cust_aff");
const adminId = await fixtures.createHelperUser("cust_admin", "admin");
helperIds.push(affiliateId, adminId);

// A fresh victim with an active Stripe subscription on customer cus_<userId>.
async function victim(tag) {
  const userId = await fixtures.createHelperUser(tag);
  helperIds.push(userId);
  const seeded = await fixtures.seedAccountData(userId, { affiliateId, adminId });
  await query(`UPDATE subscriptions SET status = 'active', provider_subscription_id = $2 WHERE user_id = $1`, [userId, `sub_${userId}`]);
  const before = await fixtures.countRows(userId);
  const assertUntouched = async (label) => {
    assert.deepEqual(await fixtures.countRows(userId), before, `${label}: data changed`);
    const user = await findUserById(userId);
    assert.equal(user.email, seeded.email, `${label}: user anonymized`);
    assert.equal(user.subscription.providerCustomerId, `cus_${userId}`, `${label}: customer id cleared`);
  };
  return { userId, customerId: `cus_${userId}`, subId: `sub_${userId}`, seeded, assertUntouched };
}

try {
  // 1. Success: subscription cancelled, then customer deleted, then local data anonymized.
  {
    const v = await victim("cust_ok");
    mock.reset({ [v.customerId]: [{ id: v.subId, status: "active" }] });
    assert.deepEqual(await deleteAccount(await findUserById(v.userId), input, req()), { deleted: true });
    assert.deepEqual(mock.trace(), [
      `GET /subscriptions?customer=${v.customerId}&limit=100`,
      `DELETE /subscriptions/${v.subId}`,
      `DELETE /customers/${v.customerId}`
    ]);
    assert.ok(mock.deletedCustomers.has(v.customerId));
    await fixtures.verifyDeletedAccount(v.userId, v.seeded);

    // Webhooks Stripe sends afterwards for this customer: acknowledged, never applied.
    const deleted = await findUserById(v.userId);
    const send = async (type, object) => {
      const id = `evt_deltest_${eventIds.length}_${type.replace(/\W/g, "_")}_${v.userId}`;
      eventIds.push(id);
      return processStripeEvent({ id, type, data: { object } });
    };
    const subObject = (metadata) => ({
      id: v.subId, object: "subscription", status: "canceled", customer: v.customerId, metadata,
      items: { data: [{ price: { id: "price_pro" } }] }
    });
    assert.equal((await send("customer.subscription.deleted", subObject({ user_id: v.userId }))).action, "ignored_deleted_account");
    assert.equal((await send("customer.subscription.updated", subObject({ user_id: v.userId }))).action, "ignored_deleted_account");
    assert.equal((await send("customer.deleted", { id: v.customerId, object: "customer", deleted: true })).action, "ignored");
    // No user_id metadata: the customer id no longer maps to anyone. Acknowledged, not retried.
    const noMeta = { ...subObject({}), id: `${v.subId}_nometa` };
    assert.equal((await send("customer.subscription.deleted", noMeta)).action, "subscription_deleted_unknown_customer");
    assert.equal((await send("invoice.payment_failed", { id: `in_${v.userId}`, customer: v.customerId, metadata: { user_id: v.userId } })).action,
      "ignored_deleted_account");

    const acknowledged = [...eventIds];
    const rows = (await query(`SELECT status, user_id FROM stripe_webhook_events WHERE event_id = ANY($1)`, [acknowledged])).rows;
    assert.equal(rows.length, 5);

    // Cases the unknown-customer rule must NOT swallow: each throws, so Stripe retries.
    const mustRetry = async (label, type, object, message = /Unable to resolve the subscription user/) => {
      await assert.rejects(send(type, object), message, label);
      const row = (await query(`SELECT status FROM stripe_webhook_events WHERE event_id = $1`, [eventIds.at(-1)])).rows[0];
      assert.equal(row.status, "failed", `${label}: must be left retryable`);
    };
    // Unlinked but legitimate: the customer exists in Stripe, checkout just hasn't linked it yet.
    const unlinked = `cus_unlinked_${v.userId}`;
    mock.customers[unlinked] = [];
    await mustRetry("unlinked live customer", "customer.subscription.deleted",
      { ...subObject({}), id: `sub_unlinked_${v.userId}`, customer: unlinked });
    // user_id metadata present but no such user: not the deleted-customer case.
    await mustRetry("unknown metadata user", "customer.subscription.deleted",
      { ...subObject({ user_id: `usr_missing_${v.userId}` }), id: `sub_meta_${v.userId}` });
    // Deleted customer, but not a .deleted event.
    await mustRetry("updated event", "customer.subscription.updated", { ...subObject({}), id: `sub_upd_${v.userId}` });
    // Customer that never existed in this Stripe account (retrieve 404s): not confirmed deleted.
    await mustRetry("never-existed customer", "customer.subscription.deleted",
      { ...subObject({}), id: `sub_ghost_${v.userId}`, customer: `cus_ghost_${v.userId}` }, /No such customer/);
    assert.ok(rows.every((row) => row.status === "processed" && row.user_id === null), "webhook rows must be processed and unlinked");
    const after = await findUserById(v.userId);
    assert.equal(after.subscription.providerCustomerId, null, "webhook restored the customer id");
    assert.equal(after.accountStatus, "deleted");
    assert.equal(after.plan, deleted.plan);

    // A webhook that resolved the user just before deletion committed: the locked write is a no-op.
    assert.equal(await updateStripeSubscription({
      userId: v.userId, customerId: v.customerId, subscriptionId: v.subId, status: "active", plan: "pro",
      priceId: "price_pro", periodStart: null, periodEnd: null, stripeMode: "test"
    }), false);
    const raced = await findUserById(v.userId);
    assert.equal(raced.subscription.providerCustomerId, null);
    assert.equal(raced.plan, "free");
  }

  // 2. Customer already deleted in Stripe (e.g. by a previous attempt): still succeeds.
  {
    const v = await victim("cust_gone");
    mock.reset({ [v.customerId]: [{ id: v.subId, status: "canceled" }] }, { deletedCustomers: [v.customerId] });
    assert.deepEqual(await deleteAccount(await findUserById(v.userId), input, req()), { deleted: true });
    assert.deepEqual(mock.trace(), [
      `GET /subscriptions?customer=${v.customerId}&limit=100`,
      `GET /customers/${v.customerId}`,
      `DELETE /customers/${v.customerId}`
    ]);
    await fixtures.verifyDeletedAccount(v.userId, v.seeded);
  }

  // 3. Transient customer-delete error: retry message, nothing after it runs, no DB changes.
  {
    const v = await victim("cust_transient");
    mock.reset({ [v.customerId]: [{ id: v.subId, status: "active" }] },
      { failCustomerDelete: { status: 503, body: { error: { type: "api_error", message: "Service unavailable" } } } });
    await assert.rejects(deleteAccount(await findUserById(v.userId), input, req()), isTransient);
    assert.equal(mock.trace().at(-1), `DELETE /customers/${v.customerId}`, "nothing ran after the failed customer delete");
    await v.assertUntouched("transient customer delete");
  }

  // 4. Permanent customer-delete error (401): support message, no DB changes.
  {
    const v = await victim("cust_permanent");
    mock.reset({ [v.customerId]: [{ id: v.subId, status: "active" }] },
      { failCustomerDelete: { status: 401, body: { error: { type: "invalid_request_error", message: "Invalid API Key provided" } } } });
    await assert.rejects(deleteAccount(await findUserById(v.userId), input, req()), isPermanent);
    await v.assertUntouched("permanent customer delete");
  }

  // 5. Stripe steps succeed, the DB transaction fails; the retry then succeeds.
  {
    const v = await victim("cust_retry");
    mock.reset({ [v.customerId]: [{ id: v.subId, status: "active" }] });
    const fn = `deltest_fail_${v.userId.replace(/\W/g, "_")}`;
    await query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${v.userId}' AND NEW.account_status = 'deleted' THEN
          RAISE EXCEPTION 'simulated account deletion failure';
        END IF;
        RETURN NEW;
      END $$`);
    await query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      await assert.rejects(deleteAccount(await findUserById(v.userId), input, req()), /simulated account deletion failure/);
    } finally {
      await query(`DROP TRIGGER IF EXISTS ${fn} ON users`);
      await query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    assert.ok(mock.deletedCustomers.has(v.customerId), "first attempt deleted the Stripe customer");
    await v.assertUntouched("failed DB transaction");

    mock.calls.length = 0;
    assert.deepEqual(await deleteAccount(await findUserById(v.userId), input, req()), { deleted: true });
    assert.deepEqual(mock.trace(), [
      `GET /subscriptions?customer=${v.customerId}&limit=100`,
      `GET /customers/${v.customerId}`,
      `DELETE /customers/${v.customerId}`
    ]);
    await fixtures.verifyDeletedAccount(v.userId, v.seeded);
  }

  console.log(JSON.stringify({ accountDeletionCustomer: "ok", scenarios: 5, webhookEvents: eventIds.length }, null, 2));
} finally {
  await query(`DELETE FROM stripe_webhook_events WHERE event_id = ANY($1)`, [eventIds]);
  if (!process.argv.includes("--keep")) await fixtures.cleanupTestUsers(helperIds);
  await getPool().end();
}
