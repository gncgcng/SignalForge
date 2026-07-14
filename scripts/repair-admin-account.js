import { appConfig } from "../src/config/appConfig.js";
import { transaction } from "../src/db/client.js";
import { runPendingMigrations } from "../src/db/migrations.js";
import { hashPassword } from "../src/modules/auth/authService.js";
import { createId } from "../src/shared/ids.js";

const email = String(process.env.REPAIR_ADMIN_EMAIL || "").trim().toLowerCase();
const password = String(process.env.REPAIR_ADMIN_PASSWORD || "");

if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
  throw new Error("REPAIR_ADMIN_EMAIL must be a valid email address.");
}
if (password.length < 6) {
  throw new Error("REPAIR_ADMIN_PASSWORD must contain at least 6 characters.");
}
if (!appConfig.adminEmails.has(email)) {
  throw new Error("REPAIR_ADMIN_EMAIL must also be listed in ADMIN_EMAILS for server-side admin authorization.");
}

await runPendingMigrations();
const passwordRecord = hashPassword(password);

await transaction(async (client) => {
  const existing = await client.query("SELECT id FROM users WHERE lower(email) = $1 FOR UPDATE", [email]);
  const userId = existing.rows[0]?.id || createId("usr");

  if (existing.rows[0]) {
    await client.query(`
      UPDATE users
      SET password_salt = $2,
        password_hash = $3,
        role = 'admin',
        account_status = 'active',
        email_verified_at = COALESCE(email_verified_at, now()),
        abuse_review_status = 'clear',
        updated_at = now()
      WHERE id = $1
    `, [userId, passwordRecord.salt, passwordRecord.hash]);
  } else {
    await client.query(`
      INSERT INTO users (
        id, name, email, password_salt, password_hash, plan,
        email_verified_at, role, account_status, abuse_review_status
      )
      VALUES ($1, 'SignalForge Admin', $2, $3, $4, 'free', now(), 'admin', 'active', 'clear')
    `, [userId, email, passwordRecord.salt, passwordRecord.hash]);
  }

  await client.query(`
    INSERT INTO subscriptions (id, user_id, status, provider)
    VALUES ($1, $2, 'trialing', 'stripe')
    ON CONFLICT (user_id) DO NOTHING
  `, [createId("sub"), userId]);
  await client.query(`
    INSERT INTO credit_balances (
      user_id, trial_signals_used, free_signal_allowance, paid_credits,
      unlock_credits_balance
    )
    VALUES ($1, 0, $2, 0, $2)
    ON CONFLICT (user_id) DO NOTHING
  `, [userId, appConfig.freeSignalAllowance]);
  await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  await client.query("DELETE FROM auth_restore_tokens WHERE user_id = $1", [userId]);
});

console.log(`Admin account repaired for ${email}.`);
