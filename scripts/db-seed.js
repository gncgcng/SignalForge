import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import { createId } from "../src/shared/ids.js";
import { query, transaction } from "../src/db/client.js";
import { appConfig } from "../src/config/appConfig.js";
import { hashPassword } from "../src/modules/auth/authService.js";

const email = process.env.SEED_EMAIL || "demo@signalforge.app";
const password = process.env.SEED_PASSWORD || "signal123";
const userId = createId("usr");

if (appConfig.isProduction) {
  throw new Error("Demo seed data is disabled in production.");
}

const created = await transaction(async (client) => {
  const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);

  if (existing.rows[0]) {
    return false;
  }

  const { salt, hash } = hashPassword(password);

  await client.query(`
    INSERT INTO users (
      id, name, email, password_salt, password_hash, plan, email_verified_at
    )
    VALUES ($1, 'Demo Trader', $2, $3, $4, 'free', now())
  `, [userId, email, salt, hash]);

  await client.query(`
    INSERT INTO subscriptions (id, user_id, status, provider)
    VALUES ($1, $2, 'trialing', 'stripe')
  `, [createId("sub"), userId]);

  await client.query(`
    INSERT INTO credit_balances (
      user_id, trial_signals_used, free_signal_allowance, paid_credits,
      unlock_credits_balance
    )
    VALUES ($1, 0, $2, 0, $2)
  `, [userId, appConfig.freeSignalAllowance]);
  return true;
});

console.log(created ? `Seeded demo user: ${email} / ${password}` : `Demo user already exists: ${email}`);
