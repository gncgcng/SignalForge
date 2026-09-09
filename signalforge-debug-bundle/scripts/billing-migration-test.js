import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../migrations/013_stripe_billing.sql", import.meta.url),
  "utf8"
);
const normalized = migration.toLowerCase();
const balanceUpdate = migration.match(
  /UPDATE credit_balances c[\s\S]*?FROM users u[\s\S]*?;/i
)?.[0] || "";

const result = {
  qualifiesAmbiguousTrialUsage: balanceUpdate.includes("c.trial_signals_used"),
  qualifiesAllBalanceColumns: [
    "c.unlock_credits_balance",
    "c.paid_credits",
    "c.free_signal_allowance",
    "c.trial_signals_used"
  ].every((column) => balanceUpdate.includes(column)),
  joinsUsersExplicitly: /WHERE u\.id = c\.user_id/i.test(balanceUpdate),
  columnsAreIdempotent: [
    "provider_subscription_id",
    "price_id",
    "current_period_start",
    "cancel_at_period_end",
    "unlock_credits_balance",
    "lifetime_unlocks_used"
  ].every((column) => new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i").test(migration)),
  tablesAndIndexesAreIdempotent:
    (migration.match(/CREATE TABLE IF NOT EXISTS/gi) || []).length === 4 &&
    (migration.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/gi) || []).length === 4,
  backfillIsRepeatSafe: /SET unlock_credits_balance = GREATEST\(/i.test(migration),
  preservesProductionData:
    !/\bDELETE\s+FROM\b/i.test(normalized) &&
    !/\bDROP\s+(TABLE|COLUMN)\b/i.test(normalized) &&
    !/\bTRUNCATE\b/i.test(normalized)
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Billing migration check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
