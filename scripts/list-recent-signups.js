// Disposable, read-only diagnostic. Prints the most recently created users to confirm the one-step signup stores
// consent, age and a generated username on both paths. Prints no emails, names or IDs. SELECT only; writes nothing.
//
// auth_method: "google" when a Google identity was linked within 2 minutes of account creation (the Google callback
// creates and links in one go); "password" otherwise, "password+google" if Google was linked later.
// Columns from migrations 063/064 print "n/a" if the database has not run them yet.
// email_verified / unlocks / free_allowance show whether the account could verify and what it holds now
// (free_allowance is 3 once a free trial was granted, 0 if never).
//
// Runs from the repo (node scripts/list-recent-signups.js) or pasted standalone into /tmp inside the Railway
// container, where it loads pg from /app (APP_ROOT overrides).
//
//   node scripts/list-recent-signups.js [--limit 10] [--since 2026-10-11T03:00:00Z] [--json]
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.APP_ROOT || (existsSync(join(scriptDirectory, "..", "package.json")) && existsSync(join(scriptDirectory, "..", "src")) ? join(scriptDirectory, "..") : "/app");
const { Client } = createRequire(join(APP_ROOT, "package.json"))("pg");

const json = process.argv.includes("--json");
const limitIndex = process.argv.indexOf("--limit");
const limit = Math.min(100, Math.max(1, Number(limitIndex >= 0 ? process.argv[limitIndex + 1] : 10) || 10));
const sinceIndex = process.argv.indexOf("--since");
const since = sinceIndex >= 0 ? new Date(process.argv[sinceIndex + 1]) : null;
if (since && Number.isNaN(since.getTime())) {
  console.error("Listing recent signups failed: --since needs an ISO timestamp, e.g. 2026-10-11T03:00:00Z.");
  process.exit(1);
}
const OPTIONAL_COLUMNS =["username_generated", "legal_consent_accepted_at", "legal_consent_version", "age_confirmed_at"];

const connectionString = String(process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || "").trim();
if (!connectionString) {
  console.error("Listing recent signups failed: DATABASE_URL is required.");
  process.exit(1);
}
const client = new Client({ connectionString, options: "-c default_transaction_read_only=on" });
try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const present = new Set((await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = ANY($1)
  `, [OPTIONAL_COLUMNS])).rows.map((row) => row.column_name));
  const column = (name, expression) => (present.has(name) ? expression : "NULL");
  const { rows } = await client.query(`
    SELECT
      u.created_at,
      CASE
        WHEN g.created_at IS NULL THEN 'password'
        WHEN g.created_at <= u.created_at + interval '2 minutes' THEN 'google'
        ELSE 'password+google'
      END AS auth_method,
      ${column("username_generated", "u.username_generated")} AS username_generated,
      ${column("legal_consent_accepted_at", "u.legal_consent_accepted_at IS NOT NULL")} AS consent_at_set,
      ${column("legal_consent_version", "u.legal_consent_version IS NOT NULL")} AS consent_version_set,
      ${column("age_confirmed_at", "u.age_confirmed_at IS NOT NULL")} AS age_confirmed_set,
      u.email_verified_at IS NOT NULL AS email_verified,
      c.unlock_credits_balance AS unlocks,
      c.free_signal_allowance AS free_allowance
    FROM users u
    LEFT JOIN oauth_accounts g ON g.user_id = u.id AND g.provider = 'google'
    LEFT JOIN credit_balances c ON c.user_id = u.id
    WHERE $2::timestamptz IS NULL OR u.created_at >= $2::timestamptz
    ORDER BY u.created_at DESC
    LIMIT $1
  `, [limit, since ? since.toISOString() : null]);
  await client.query("ROLLBACK");

  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    const missing = OPTIONAL_COLUMNS.filter((name) => !present.has(name));
    console.log(`${rows.length} most recently created users${missing.length ? ` (not migrated yet: ${missing.join(", ")})` : ""}`);
    const flag = (value) => (value === null || value === undefined ? "n/a" : value ? "yes" : "no");
    const header = ["created_at", "auth_method", "username_generated", "consent_at", "consent_version", "age_confirmed_at", "email_verified", "unlocks", "free_allowance"];
    const widths = [24, 15, 18, 10, 15, 16, 14, 7, 14];
    console.log(header.map((name, index) => name.padEnd(widths[index])).join("  "));
    for (const row of rows) {
      const cells = [
        new Date(row.created_at).toISOString(),
        row.auth_method,
        flag(row.username_generated),
        flag(row.consent_at_set),
        flag(row.consent_version_set),
        flag(row.age_confirmed_set),
        flag(row.email_verified),
        row.unlocks === null ? "n/a" : String(row.unlocks),
        row.free_allowance === null ? "n/a" : String(row.free_allowance)
      ];
      console.log(cells.map((cell, index) => cell.padEnd(widths[index])).join("  "));
    }
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`Listing recent signups failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
