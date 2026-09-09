import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const repositorySource = await readFile(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const originalMigration = await readFile(new URL("../migrations/013_stripe_billing.sql", import.meta.url), "utf8");
const repairMigration = await readFile(new URL("../migrations/055_scan_result_cache_conflict_constraint.sql", import.meta.url), "utf8");
const cacheFunction = repositorySource.slice(
  repositorySource.indexOf("export async function cacheScanResult"),
  repositorySource.indexOf("export async function consumeDiscoveryCredits")
);
const sqlMatch = cacheFunction.match(/await query\(`([\s\S]*?)`, \[userId, scanKey/);
assert.ok(sqlMatch, "Could not extract the production scan_result_cache upsert.");
const productionUpsertSql = sqlMatch[1].trim();

assert.match(productionUpsertSql, /INSERT INTO scan_result_cache \(user_id, scan_key, result_json, expires_at\)/i);
assert.match(productionUpsertSql, /ON CONFLICT \(user_id, scan_key\) DO UPDATE/i);
assert.match(originalMigration, /CREATE TABLE IF NOT EXISTS scan_result_cache[\s\S]*PRIMARY KEY \(user_id, scan_key\)/i);
assert.match(repairMigration, /PARTITION BY user_id, scan_key/i);
assert.match(repairMigration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_result_cache_user_scan_key_unique\s+ON scan_result_cache\(user_id, scan_key\)/i);
assert.doesNotMatch(repairMigration, /generated_signals|saved_signals|setup_candidates/i);

const result = {
  exactConflictTarget: "scan_result_cache(user_id, scan_key)",
  mismatchReproduced: false,
  postgresErrorCode: null,
  migrationAppliedTwice: false,
  upsertSucceededAfterRepair: false,
  runtimeDatabase: process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL" : "not configured"
};

if (process.env.TEST_DATABASE_URL) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `sf_scan_cache_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE scan_result_cache (
        user_id text NOT NULL,
        scan_key text NOT NULL,
        result_json jsonb NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      INSERT INTO scan_result_cache (user_id, scan_key, result_json, expires_at, created_at)
      VALUES
        ('user-1', 'all:fixture', '{"version":1}', now() + interval '1 minute', now() - interval '2 minutes'),
        ('user-1', 'all:fixture', '{"version":2}', now() + interval '2 minutes', now() - interval '1 minute')
    `);

    await assert.rejects(
      client.query(productionUpsertSql, ["user-1", "all:fixture", JSON.stringify({ version: 3 }), 300]),
      (error) => {
        result.mismatchReproduced = error.code === "42P10";
        result.postgresErrorCode = error.code;
        return error.code === "42P10" && /no unique or exclusion constraint/i.test(error.message);
      }
    );

    await client.query(repairMigration);
    await client.query(repairMigration);
    result.migrationAppliedTwice = true;
    await client.query(productionUpsertSql, ["user-1", "all:fixture", JSON.stringify({ version: 3 }), 300]);
    await client.query(productionUpsertSql, ["user-1", "all:fixture", JSON.stringify({ version: 4 }), 300]);
    const rows = await client.query(`
      SELECT result_json
      FROM scan_result_cache
      WHERE user_id = 'user-1' AND scan_key = 'all:fixture'
    `);
    assert.equal(rows.rowCount, 1);
    assert.equal(Number(rows.rows[0].result_json.version), 4);
    result.upsertSucceededAfterRepair = true;
  } finally {
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
}

console.log(JSON.stringify(result, null, 2));
