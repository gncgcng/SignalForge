// Stage-2 test: calls the deletion service/function directly against the local database.
// Requires DATABASE_URL (local docker-compose Postgres). Stripe is left unconfigured so the
// "can't verify an active subscription" path is exercised without network calls.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";

process.env.NODE_ENV = "development";
delete process.env.STRIPE_SECRET_KEY;

const { getPool, query } = await import("../src/db/client.js");
const { registerOrLogin } = await import("../src/modules/auth/authService.js");
const { deleteAccount } = await import("../src/modules/account-deletion/accountDeletionService.js");
const { deleteAccountData } = await import("../src/modules/account-deletion/accountDeletionRepository.js");
const {
  createEmailVerificationToken, expireActiveSignalsPastValidity, findUserByEmail, findUserById,
  grantOAuthFreeTrial, listActiveSignals, verifyEmailToken
} = await import("../src/db/repositories.js");
const fixtures = await import("./account-deletion-fixtures.js");

const req = { headers: {}, socket: { remoteAddress: "127.0.0.9" } };
const helperIds = [];

try {
  const affiliateId = await fixtures.createHelperUser("aff");
  const adminId = await fixtures.createHelperUser("admin", "admin");
  const userId = await fixtures.createHelperUser("victim");
  helperIds.push(affiliateId, adminId, userId);
  const seeded = await fixtures.seedAccountData(userId, { affiliateId, adminId });
  const before = await fixtures.countRows(userId);
  const empty = Object.entries(before).filter(([key, n]) => n === 0 && !key.startsWith("affiliate_referrals.affiliate_user_id"));
  assert.deepEqual(empty, [], "fixture should populate every classified table");

  const load = () => findUserById(userId);
  const assertUntouched = async (label) => {
    assert.deepEqual(await fixtures.countRows(userId), before, `${label}: data changed`);
    assert.equal((await load()).email, seeded.email, `${label}: user anonymized`);
  };
  const rejects = async (promise, statusCode, code) => assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, statusCode, error.message);
    if (code) assert.equal(error.code, code);
    return true;
  });

  // Refusals: each must leave every row untouched.
  await rejects(deleteAccount(await load(), { password: "helper-password", confirmation: "delete me" }, req), 400, "confirmation_required");
  await assertUntouched("bad confirmation");
  await rejects(deleteAccount(await load(), { password: "wrong-password", confirmation: "DELETE" }, req), 401, "reauth_failed");
  await assertUntouched("wrong password");
  await rejects(deleteAccount(await findUserById(adminId), { password: "helper-password", confirmation: "DELETE" }, req), 403, "admin_account");

  await query(`INSERT INTO affiliate_payout_requests (id, affiliate_user_id, amount_cents, payout_method, payout_destination, status)
    VALUES ('payout_pending_deltest', $1, 2500, 'paypal', 'x', 'pending')`, [userId]);
  await rejects(deleteAccount(await load(), { password: "helper-password", confirmation: "DELETE" }, req), 409, "pending_payout");
  await query(`DELETE FROM affiliate_payout_requests WHERE id = 'payout_pending_deltest'`);
  await assertUntouched("pending payout");

  // Still-billed account whose subscription can't be verified with Stripe: refuse, touch nothing.
  await query(`UPDATE subscriptions SET status = 'active', provider_subscription_id = 'sub_deltest' WHERE user_id = $1`, [userId]);
  await rejects(deleteAccount(await load(), { password: "helper-password", confirmation: "DELETE" }, req), 409, "subscription_unverifiable");
  await assertUntouched("unverifiable subscription");
  await query(`UPDATE subscriptions SET status = 'canceled', provider_subscription_id = NULL WHERE user_id = $1`, [userId]);

  // Success.
  assert.deepEqual(await deleteAccount(await load(), { password: "helper-password", confirmation: "DELETE" }, req), { deleted: true });
  const report = await fixtures.verifyDeletedAccount(userId, seeded);

  // Outcome trackers must not revive or resolve the retained still-active signal.
  const ledgerBefore = (await query(`SELECT COUNT(*)::integer AS n FROM signal_credit_transactions WHERE user_id = $1`, [userId])).rows[0].n;
  assert.ok(!(await listActiveSignals()).some((signal) => signal.userId === userId), "tracker lists deleted user's signals");
  await expireActiveSignalsPastValidity();
  const liveOutcome = (await query(`SELECT status FROM signal_outcomes WHERE saved_signal_id = $1`, [seeded.activeLedgerSignal])).rows[0];
  assert.equal(liveOutcome.status, "Active", "expiry job resolved a deleted user's signal");
  const ledgerAfter = (await query(`SELECT COUNT(*)::integer AS n FROM signal_credit_transactions WHERE user_id = $1`, [userId])).rows[0].n;
  assert.equal(ledgerAfter, ledgerBefore, "expiry job refunded into a deleted account");

  // Can't log back in: old email no longer resolves; placeholder email + old password is rejected.
  assert.equal(await findUserByEmail(seeded.email), null);
  await rejects(registerOrLogin({ email: `deleted-user-${userId}@signalforge.invalid`, password: "helper-password" }, req), 401);

  // A new signup on the deleted account's device is still a repeat trial, on both signup paths.
  const oauthResignup = await fixtures.createHelperUser("resignup_oauth");
  const emailResignup = await fixtures.createHelperUser("resignup_email");
  helperIds.push(oauthResignup, emailResignup);
  await query(`UPDATE users SET device_fingerprint_hash = $2 WHERE id = ANY($1)`, [[oauthResignup, emailResignup], seeded.deviceHash]);
  assert.equal(await grantOAuthFreeTrial(oauthResignup, seeded.deviceHash), false, "OAuth re-signup granted a second trial");
  await createEmailVerificationToken(emailResignup, `tok_${emailResignup}`, new Date(Date.now() + 3600_000));
  const verified = await verifyEmailToken(`tok_${emailResignup}`);
  assert.equal(verified.trialGranted, false, "email re-signup granted a second trial");
  for (const id of [oauthResignup, emailResignup]) {
    const flags = (await query(`SELECT abuse_flags FROM users WHERE id = $1`, [id])).rows[0].abuse_flags;
    assert.ok(flags.includes("repeated_trial_device"), `${id} not flagged as a repeat trial device`);
  }
  const trialOwner = (await query(`SELECT first_user_id FROM device_trial_history WHERE device_fingerprint_hash = $1`, [seeded.deviceHash])).rows[0];
  assert.equal(trialOwner.first_user_id, userId, "trial history reassigned to the new signup");

  // Idempotent.
  assert.deepEqual(await deleteAccountData({ userId, email: seeded.email }), { alreadyDeleted: true });

  console.log(JSON.stringify({ accountDeletion: "ok", userId, report }, null, 2));
} finally {
  if (!process.argv.includes("--keep")) await fixtures.cleanupTestUsers(helperIds);
  await getPool().end();
}
