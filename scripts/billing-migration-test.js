// Pivot phase 3, test 8: migration 068 applies on a fresh database and on one at 067, and free users end up at
// 'none' (no more "trialing" default). Uses its own scratch database on the local Postgres and drops it.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const { default: pg } = await import("pg");
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
const scratch = `sf_billing_migration_${process.pid}`;
const url = new URL(process.env.DATABASE_URL);
url.pathname = `/${scratch}`;
const migrate = () => spawnSync(process.execPath, ["scripts/db-migrate.js"], { env: { ...process.env, DATABASE_URL: url.toString() }, encoding: "utf8" });
const results = {};

await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
await admin.query(`CREATE DATABASE ${scratch}`);
const client = new pg.Client({ connectionString: url.toString() });
try {
  const fresh = migrate();
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /\[database\] Applied migration 068_single_plan_billing\.sql/);
  await client.connect();
  const defaultStatus = (await client.query(`SELECT column_default FROM information_schema.columns WHERE table_name = 'subscriptions' AND column_name = 'status'`)).rows[0].column_default;
  assert.match(defaultStatus, /'none'/);
  for (const table of ["trial_card_claims", "billing_invoices", "billing_anomalies"]) {
    assert.ok((await client.query(`SELECT to_regclass($1) AS t`, [table])).rows[0].t, `${table} exists`);
  }
  results.fresh = { applied: "001..068", statusDefault: "none" };

  // Back to 067 (undo 068), with users as production has them: free rows defaulted to 'trialing'.
  await client.query(`
    DROP TABLE trial_card_claims; DROP TABLE billing_invoices; DROP TABLE billing_anomalies;
    ALTER TABLE subscriptions DROP COLUMN trial_end, DROP COLUMN first_subscribed_at, DROP COLUMN billing_interval;
    ALTER TABLE subscriptions ALTER COLUMN status SET DEFAULT 'trialing';
    DELETE FROM schema_migrations WHERE filename = '068_single_plan_billing.sql';
  `);
  assert.equal((await client.query(`SELECT max(filename) AS f FROM schema_migrations`)).rows[0].f, "067_real_trades.sql");
  const users = [
    ["usr_free_1", "trialing", null, null],
    ["usr_free_2", "trialing", null, null],
    ["usr_free_3", "active", null, null], // a stray non-Stripe 'active'
    ["usr_legacy_pro", "active", "sub_legacy", "cus_legacy"], // an old Pro subscription (test mode)
    ["usr_past_canceled", "canceled", null, "cus_canceled"] // subscribed once, now cancelled
  ];
  for (const [id, status, subscriptionId, customerId] of users) {
    await client.query(`INSERT INTO users (id, name, email, password_salt, password_hash) VALUES ($1, $1, $1 || '@example.test', '', '')`, [id]);
    await client.query(`INSERT INTO subscriptions (id, user_id, status, provider_subscription_id, provider_customer_id) VALUES ($1, $2, $3, $4, $5)`,
      [`sub_row_${id}`, id, status, subscriptionId, customerId]);
  }
  const at067 = migrate();
  assert.equal(at067.status, 0, at067.stderr);
  assert.deepEqual(at067.stdout.trim().split("\n").filter((line) => line.includes("Applied migration")), ["[database] Applied migration 068_single_plan_billing.sql"]);
  const rows = Object.fromEntries((await client.query(`SELECT user_id, status, first_subscribed_at IS NOT NULL AS had_subscription FROM subscriptions ORDER BY user_id`)).rows
    .map((row) => [row.user_id, { status: row.status, hadSubscription: row.had_subscription }]));
  assert.deepEqual(rows, {
    usr_free_1: { status: "none", hadSubscription: false },
    usr_free_2: { status: "none", hadSubscription: false },
    usr_free_3: { status: "none", hadSubscription: false },
    usr_legacy_pro: { status: "active", hadSubscription: true },
    usr_past_canceled: { status: "canceled", hadSubscription: true }
  });
  results.at067 = { applied: "only 068", subscriptions: rows };
  // New free users get 'none'.
  await client.query(`INSERT INTO users (id, name, email, password_salt, password_hash) VALUES ('usr_new', 'n', 'new@example.test', '', '')`);
  await client.query(`INSERT INTO subscriptions (id, user_id) VALUES ('sub_row_new', 'usr_new')`);
  assert.equal((await client.query(`SELECT status FROM subscriptions WHERE user_id = 'usr_new'`)).rows[0].status, "none");
  results.newFreeUser = "none";
  console.log(JSON.stringify(results, null, 2));
} finally {
  await client.end().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  await admin.end();
}
