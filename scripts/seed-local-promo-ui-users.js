// Local-only seed for manually verifying the promo-code UI: one admin and two regular users.
// Idempotent: re-running resets their passwords and unlock-credit balances.
// Passwords are generated fresh on every run and printed once to the console; none are stored
// in the repo. All emails use the reserved .invalid TLD (RFC 2606), so none can ever be a real
// mailbox or collide with the production admin address.
// The admin only gets admin rights if ADMIN_EMAILS includes PROMO_UI_ADMIN_EMAIL (see
// .claude/launch.json for the local server).
//   DATABASE_URL=postgres://signalforge:signalforge@localhost:5432/signalforge node scripts/seed-local-promo-ui-users.js
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import { randomBytes } from "node:crypto";
import { getPool, transaction } from "../src/db/client.js";
import { hashPassword } from "../src/modules/auth/authService.js";
import { createId } from "../src/shared/ids.js";

export const PROMO_UI_ADMIN_EMAIL = "promo-admin@signalforge-local.invalid";
const USERS = [
  { email: PROMO_UI_ADMIN_EMAIL, name: "Promo Admin" },
  { email: "promo-user-a@signalforge-local.invalid", name: "Promo User A" },
  { email: "promo-user-b@signalforge-local.invalid", name: "Promo User B" }
];
const STARTING_CREDITS = 3;

for (const { email } of USERS) {
  if (!email.endsWith(".invalid")) {
    throw new Error(`Seed email must use the reserved .invalid TLD: ${email}`);
  }
}

function generatePassword() {
  return `Local-${randomBytes(18).toString("base64url")}`;
}

try {
  for (const { email, name } of USERS) {
    const password = generatePassword();
    const { salt, hash } = hashPassword(password);
    await transaction(async (client) => {
      const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
      const userId = existing.rows[0]?.id || createId("usr");
      if (existing.rows[0]) {
        await client.query(`
          UPDATE users SET password_salt = $2, password_hash = $3, account_status = 'active',
            email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
          WHERE id = $1
        `, [userId, salt, hash]);
      } else {
        await client.query(`
          INSERT INTO users (id, name, email, password_salt, password_hash, plan, email_verified_at)
          VALUES ($1, $2, $3, $4, $5, 'free', now())
        `, [userId, name, email, salt, hash]);
        await client.query(`
          INSERT INTO subscriptions (id, user_id, status, provider) VALUES ($1, $2, 'trialing', 'stripe')
          ON CONFLICT (user_id) DO NOTHING
        `, [createId("sub"), userId]);
      }
      await client.query(`
        INSERT INTO credit_balances (user_id, trial_signals_used, free_signal_allowance, paid_credits, unlock_credits_balance)
        VALUES ($1, 0, $2, 0, $2)
        ON CONFLICT (user_id) DO UPDATE SET unlock_credits_balance = $2, paid_credits = 0, updated_at = now()
      `, [userId, STARTING_CREDITS]);
    });
    console.log(`seeded ${email} password=${password} (${STARTING_CREDITS} unlock credits)`);
  }
} finally {
  await getPool().end();
}
