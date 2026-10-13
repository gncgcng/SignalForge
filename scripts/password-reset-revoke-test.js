// Pivot phase 3, test 7: a password reset signs the account out everywhere else (every other session deleted,
// every restore token revoked), the same way a logged-in password change does. DB-backed.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

process.env.NODE_ENV = "development";

const { getPool, query } = await import("../src/db/client.js");
const { completePasswordReset } = await import("../src/modules/auth/authService.js");
const { appConfig } = await import("../src/config/appConfig.js");
// Same keyed hash the reset request stores (authService hashPasswordResetToken).
const resetHash = (token) => createHmac("sha256", appConfig.abuseProtection.hashSecret).update(`password-reset:${token}`).digest("hex");
const { createPasswordResetToken } = await import("../src/db/repositories.js");
const fixtures = await import("./account-deletion-fixtures.js");

const helperIds = [];
const tag = Date.now().toString(36);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

try {
  const userId = await fixtures.createHelperUser("pwreset");
  const otherId = await fixtures.createHelperUser("pwreset_other");
  helperIds.push(userId, otherId);
  for (const [id, owner] of [[`sess_keep_${tag}`, userId], [`sess_phone_${tag}`, userId], [`sess_laptop_${tag}`, userId], [`sess_other_${tag}`, otherId]]) {
    await query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')`, [id, owner]);
  }
  const insertRestore = (id, owner) => query(`INSERT INTO auth_restore_tokens (id, user_id, token_hash, device_fingerprint_hash, expires_at)
    VALUES ($1, $2, $3, 'device', now() + interval '180 days')`, [id, owner, sha256(id)]);
  await insertRestore(`rt_a_${tag}`, userId);
  await insertRestore(`rt_b_${tag}`, userId);
  await insertRestore(`rt_other_${tag}`, otherId);

  const raw = `reset_${tag}`;
  await createPasswordResetToken(userId, resetHash(raw), new Date(Date.now() + 3600000));

  const result = await completePasswordReset({ token: raw, password: "a-New-passw0rd-for-reset", keepSessionId: `sess_keep_${tag}` });
  assert.deepEqual(result, { ok: true });

  const sessions = (await query(`SELECT id FROM sessions WHERE user_id = ANY($1) ORDER BY id`, [[userId, otherId]])).rows.map((row) => row.id);
  assert.deepEqual(sessions.sort(), [`sess_keep_${tag}`, `sess_other_${tag}`].sort(), "only the resetting browser's session survives (and other accounts are untouched)");
  const tokens = (await query(`SELECT id, revoked_at FROM auth_restore_tokens WHERE user_id = ANY($1)`, [[userId, otherId]])).rows;
  assert.ok(tokens.filter((token) => token.id !== `rt_other_${tag}`).every((token) => token.revoked_at), "every restore token of the account is revoked");
  assert.equal(tokens.find((token) => token.id === `rt_other_${tag}`).revoked_at, null, "another account's restore token is untouched");

  // Without a session (reset from a signed-out browser) every session goes.
  await query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')`, [`sess_again_${tag}`, userId]);
  const raw2 = `reset2_${tag}`;
  await createPasswordResetToken(userId, resetHash(raw2), new Date(Date.now() + 3600000));
  await completePasswordReset({ token: raw2, password: "another-New-passw0rd" });
  assert.equal((await query(`SELECT COUNT(*)::integer AS n FROM sessions WHERE user_id = $1`, [userId])).rows[0].n, 0);

  console.log(JSON.stringify({ passwordReset: "revokes other sessions and restore tokens", sessionsLeft: sessions }, null, 2));
} finally {
  await query(`DELETE FROM sessions WHERE user_id = ANY($1)`, [helperIds]);
  await query(`DELETE FROM auth_restore_tokens WHERE user_id = ANY($1)`, [helperIds]);
  await fixtures.cleanupTestUsers(helperIds);
  await getPool().end();
}
