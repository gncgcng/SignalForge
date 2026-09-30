// DB-backed: exercises the real login and account-deletion re-auth paths against the local
// database to confirm legacy sha256 hashes are upgraded to scrypt on successful authentication.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

process.env.NODE_ENV = "development";
delete process.env.STRIPE_SECRET_KEY;

const { getPool, query } = await import("../src/db/client.js");
const { hashPassword, registerOrLogin } = await import("../src/modules/auth/authService.js");
const { deleteAccount } = await import("../src/modules/account-deletion/accountDeletionService.js");
const { findUserById, upgradeUserPasswordHash } = await import("../src/db/repositories.js");
const { cleanupTestUsers } = await import("./account-deletion-fixtures.js");

const PASSWORD = "legacy-password-123";
const run = Date.now().toString(36);
const userIds = [];
let ipCounter = 0;

// Old formula inline, independent of whatever authService does with legacy code later.
function legacyRecord(password) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: createHash("sha256").update(`${salt}:${password}`).digest("hex") };
}

async function seedLegacyUser(tag) {
  const id = `usr_pwmig_${tag}_${run}`;
  const record = legacyRecord(PASSWORD);
  await query(`
    INSERT INTO users (id, name, email, password_salt, password_hash, plan, email_verified_at)
    VALUES ($1, $2, $3, $4, $5, 'free', now())
  `, [id, `pwmig ${tag}`, `${id}@example.test`, record.salt, record.hash]);
  userIds.push(id);
  return { id, email: `${id}@example.test`, record };
}

async function storedHash(id) {
  return (await query(`SELECT password_salt, password_hash FROM users WHERE id = $1`, [id])).rows[0];
}

// A fresh IP per scenario keeps the per-IP login counters from one scenario out of the next.
function freshReq() {
  ipCounter += 1;
  return { headers: {}, socket: { remoteAddress: `127.0.${ipCounter}.77` } };
}

const login = (email, password, req = freshReq()) => registerOrLogin({ email, password }, req);
async function hasSession(loginResult) {
  if (typeof loginResult?.sessionId !== "string") return false;
  return (await query(`SELECT 1 FROM sessions WHERE id = $1`, [loginResult.sessionId])).rowCount === 1;
}

const isScrypt = (row) => /^scrypt\$/.test(row.password_hash) && row.password_salt === "";

const result = {};

try {
  // 1. Wrong password against a legacy hash: rejected, nothing upgraded.
  {
    const user = await seedLegacyUser("wrong");
    await assert.rejects(login(user.email, "not-the-password"), (error) => error.statusCode === 401);
    const row = await storedHash(user.id);
    result.failedLoginLeavesLegacyHashUntouched =
      row.password_hash === user.record.hash && row.password_salt === user.record.salt;
  }

  // 2. Successful login upgrades in place; the new hash then works on its own.
  {
    const user = await seedLegacyUser("login");
    const first = await login(user.email, PASSWORD);
    const upgraded = await storedHash(user.id);
    const second = await login(user.email, PASSWORD);
    const afterSecond = await storedHash(user.id);
    await assert.rejects(login(user.email, "not-the-password"), (error) => error.statusCode === 401);
    result.successfulLegacyLoginReturnsSession = await hasSession(first);
    result.successfulLegacyLoginUpgradesToScrypt = isScrypt(upgraded) && upgraded.password_hash !== user.record.hash;
    result.secondLoginVerifiesAgainstNewHash = await hasSession(second);
    result.scryptLoginDoesNotRehash = afterSecond.password_hash === upgraded.password_hash;
  }

  // 3. A failing upgrade write must not block the login.
  {
    const user = await seedLegacyUser("writefail");
    await query(`
      CREATE OR REPLACE FUNCTION pwmig_block_upgrade() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${user.id}' AND NEW.password_hash LIKE 'scrypt$%' THEN
          RAISE EXCEPTION 'pwmig simulated upgrade failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await query(`CREATE TRIGGER pwmig_block_upgrade BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION pwmig_block_upgrade()`);
    try {
      const session = await login(user.email, PASSWORD);
      const row = await storedHash(user.id);
      result.failedUpgradeWriteStillLogsIn = await hasSession(session);
      result.failedUpgradeWriteLeavesLegacyHash = row.password_hash === user.record.hash;
    } finally {
      await query(`DROP TRIGGER IF EXISTS pwmig_block_upgrade ON users`);
      await query(`DROP FUNCTION IF EXISTS pwmig_block_upgrade()`);
    }
  }

  // 4. Account-deletion re-auth upgrades on success, independently of the login path. A pending
  //    payout makes deletion refuse right after re-auth, so the row survives to be inspected.
  {
    const user = await seedLegacyUser("reauth");
    await query(`INSERT INTO affiliate_payout_requests (id, affiliate_user_id, amount_cents, payout_method, payout_destination, status)
      VALUES ($1, $2, 2500, 'paypal', 'x', 'pending')`, [`payout_pwmig_${run}`, user.id]);
    try {
      await assert.rejects(
        deleteAccount(await findUserById(user.id), { password: "not-the-password", confirmation: "DELETE" }, freshReq()),
        (error) => error.statusCode === 401 && error.code === "reauth_failed"
      );
      const afterWrong = await storedHash(user.id);
      result.failedReauthLeavesLegacyHashUntouched = afterWrong.password_hash === user.record.hash;

      await assert.rejects(
        deleteAccount(await findUserById(user.id), { password: PASSWORD, confirmation: "DELETE" }, freshReq()),
        (error) => error.statusCode === 409 && error.code === "pending_payout"
      );
      const afterReauth = await storedHash(user.id);
      result.successfulReauthUpgradesToScrypt = isScrypt(afterReauth);
      const session = await login(user.email, PASSWORD);
      result.reauthUpgradedHashVerifiesOnLogin = await hasSession(session);
    } finally {
      await query(`DELETE FROM affiliate_payout_requests WHERE id = $1`, [`payout_pwmig_${run}`]);
    }
  }

  // 5. The upgrade write is compare-and-set: a stale upgrade can't overwrite a newer password.
  {
    const user = await seedLegacyUser("race");
    const reset = hashPassword("password-set-by-reset");
    await query(`UPDATE users SET password_salt = $2, password_hash = $3 WHERE id = $1`, [user.id, reset.salt, reset.hash]);
    const applied = await upgradeUserPasswordHash(user.id, user.record.hash, hashPassword(PASSWORD));
    const row = await storedHash(user.id);
    result.staleUpgradeDoesNotOverwriteReset = applied === false && row.password_hash === reset.hash;
  }
} finally {
  await cleanupTestUsers(userIds);
  await getPool().end();
}

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Password hash migration check failed: ${name}`);
}
assert.equal(Object.keys(result).length, 11, "every scenario must report");

console.log(JSON.stringify(result, null, 2));
