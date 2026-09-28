// Deadlock/serialization retry around the account-deletion DB transaction, with mocked Stripe.
// Deterministic: a test-only trigger raises a real SQLSTATE on the transaction's final
// UPDATE users for the first N attempts, so every failed attempt truly rolls back. Attempts are
// counted with a sequence, which is not rolled back. No timing races, no real deadlocks.
// Requires DATABASE_URL (local docker-compose Postgres). Never run against production.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";

process.env.NODE_ENV = "development";
process.env.STRIPE_SECRET_KEY = "sk_test_account_deletion_retry_check";

const { getPool, query } = await import("../src/db/client.js");
const { deleteAccount } = await import("../src/modules/account-deletion/accountDeletionService.js");
const { findUserById } = await import("../src/db/repositories.js");
const { installStripeAccountDeletionMock } = await import("./test-support/stripe-account-deletion-mock.js");
const fixtures = await import("./account-deletion-fixtures.js");

const mock = installStripeAccountDeletionMock();
const helperIds = [];
const input = { password: "helper-password", confirmation: "DELETE" };
let ip = 40;
const req = () => ({ headers: {}, socket: { remoteAddress: `127.0.2.${ip++}` } });

const affiliateId = await fixtures.createHelperUser("retry_aff");
const adminId = await fixtures.createHelperUser("retry_admin", "admin");
helperIds.push(affiliateId, adminId);

async function victim(tag) {
  const userId = await fixtures.createHelperUser(tag);
  helperIds.push(userId);
  const seeded = await fixtures.seedAccountData(userId, { affiliateId, adminId });
  const before = await fixtures.countRows(userId);
  return { userId, customerId: `cus_${userId}`, seeded, before };
}

// Fails the deletion's final UPDATE users with `errcode` for the first `failTimes` attempts.
async function withInjectedFailure(userId, { errcode, failTimes }, run) {
  const name = `deltest_retry_${userId.replace(/\W/g, "_")}`;
  await query(`CREATE SEQUENCE ${name}_seq`);
  await query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id = '${userId}' AND NEW.account_status = 'deleted' THEN
        IF nextval('${name}_seq') <= ${failTimes} THEN
          RAISE EXCEPTION 'simulated failure %', '${errcode}' USING ERRCODE = '${errcode}';
        END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await query(`CREATE TRIGGER ${name} BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try {
    return await run(async () => Number((await query(`SELECT last_value FROM ${name}_seq`)).rows[0].last_value));
  } finally {
    await query(`DROP TRIGGER IF EXISTS ${name} ON users`);
    await query(`DROP FUNCTION IF EXISTS ${name}()`);
    await query(`DROP SEQUENCE IF EXISTS ${name}_seq`);
  }
}

// Report minus per-user identifiers/timestamps, so two deletions can be compared field by field.
function normalized(report, userId) {
  const copy = JSON.parse(JSON.stringify(report).split(userId).join("<uid>"));
  delete copy.retained.users.deleted_at;
  return copy;
}

const logs = [];
const originalWarn = console.warn;
console.warn = (...args) => { logs.push(args.join(" ")); originalWarn(...args); };

try {
  // Baseline: a normal deletion, no injected failure.
  const baseline = await victim("retry_base");
  mock.reset({ [baseline.customerId]: [] });
  assert.deepEqual(await deleteAccount(await findUserById(baseline.userId), input, req()), { deleted: true });
  const baselineReport = normalized(await fixtures.verifyDeletedAccount(baseline.userId, baseline.seeded), baseline.userId);

  // (a) First attempt deadlocks (40P01), second succeeds. Stripe steps run exactly once.
  {
    const v = await victim("retry_once");
    mock.reset({ [v.customerId]: [] });
    await withInjectedFailure(v.userId, { errcode: "40P01", failTimes: 1 }, async (attempts) => {
      assert.deepEqual(await deleteAccount(await findUserById(v.userId), input, req()), { deleted: true });
      assert.equal(await attempts(), 2, "expected exactly one retry");
    });
    assert.deepEqual(mock.trace(), [
      `GET /subscriptions?customer=${v.customerId}&limit=100`,
      `DELETE /customers/${v.customerId}`
    ], "Stripe steps must not be repeated by the DB retry");
    const report = normalized(await fixtures.verifyDeletedAccount(v.userId, v.seeded), v.userId);
    assert.deepEqual(report, baselineReport, "retried deletion differs from a normal deletion");
    assert.ok(logs.some((line) => line.includes(`transaction retry user=${v.userId} attempt=1/3 code=40P01`)));
  }

  // (a2) Serialization failure (40001) is retried the same way.
  {
    const v = await victim("retry_serial");
    mock.reset({ [v.customerId]: [] });
    await withInjectedFailure(v.userId, { errcode: "40001", failTimes: 1 }, async (attempts) => {
      assert.deepEqual(await deleteAccount(await findUserById(v.userId), input, req()), { deleted: true });
      assert.equal(await attempts(), 2);
    });
    await fixtures.verifyDeletedAccount(v.userId, v.seeded);
  }

  // (b) All 3 attempts deadlock: retry message, no Postgres text, data untouched.
  {
    const v = await victim("retry_exhausted");
    mock.reset({ [v.customerId]: [] });
    await withInjectedFailure(v.userId, { errcode: "40P01", failTimes: 99 }, async (attempts) => {
      await assert.rejects(deleteAccount(await findUserById(v.userId), input, req()), (error) =>
        error.statusCode === 503 && error.code === "account_deletion_busy" &&
        /Please try again/.test(error.message) && !/simulated|deadlock|40P01/i.test(error.message) &&
        error.cause?.code === "40P01"
      );
      assert.equal(await attempts(), 3, "expected exactly 3 attempts");
    });
    assert.deepEqual(await fixtures.countRows(v.userId), v.before, "data changed after exhausted retries");
    const user = await findUserById(v.userId);
    assert.equal(user.email, v.seeded.email);
    assert.equal(user.accountStatus, "active");
    assert.equal(logs.filter((line) => line.includes(`transaction retry user=${v.userId}`)).length, 2);
  }

  // (c) A non-deadlock error (check_violation) is thrown immediately, never retried.
  {
    const v = await victim("retry_other");
    mock.reset({ [v.customerId]: [] });
    await withInjectedFailure(v.userId, { errcode: "23514", failTimes: 99 }, async (attempts) => {
      await assert.rejects(deleteAccount(await findUserById(v.userId), input, req()), (error) =>
        error.code === "23514" && error.statusCode === undefined
      );
      assert.equal(await attempts(), 1, "non-deadlock error was retried");
    });
    assert.deepEqual(await fixtures.countRows(v.userId), v.before);
    assert.ok(!logs.some((line) => line.includes(`transaction retry user=${v.userId}`)));
  }

  console.log(JSON.stringify({ accountDeletionRetry: "ok", scenarios: 4 }, null, 2));
} finally {
  console.warn = originalWarn;
  if (!process.argv.includes("--keep")) await fixtures.cleanupTestUsers(helperIds);
  await getPool().end();
}
