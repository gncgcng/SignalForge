import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../migrations/022_signal_setup_key_idempotency.sql", import.meta.url),
  "utf8"
);
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");

const staticChecks = {
  addsSetupKeyIdempotently: /ADD COLUMN IF NOT EXISTS setup_key/i.test(migration),
  backfillsSetupKey: /WHERE setup_key IS NULL/i.test(migration),
  buildsDedupeSet: /CREATE TEMP TABLE signal_setup_key_dedup/i.test(migration) &&
    /row_number\(\) OVER/i.test(migration),
  prefersCompleteUnlockedRows:
    migration.includes("(pt.id IS NOT NULL) DESC") &&
    migration.includes("(j.paper_trade_id IS NOT NULL) DESC") &&
    migration.includes("(u.id IS NOT NULL) DESC") &&
    migration.includes("s.created_at ASC"),
  movesOrRemovesDuplicateDependents:
    migration.includes("UPDATE signal_outcomes") &&
    migration.includes("UPDATE unlocked_signals") &&
    migration.includes("UPDATE paper_trades") &&
    migration.includes("DELETE FROM saved_signals"),
  createsUniqueIndexSafely: /CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_signals_user_setup_key/i.test(migration),
  keepsUnlockAdvisoryLock: repositories.includes("pg_advisory_xact_lock") &&
    repositories.includes("alreadyUnlocked = true")
};

for (const [name, passed] of Object.entries(staticChecks)) {
  assert.equal(passed, true, `Signal setup-key migration static check failed: ${name}`);
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
let liveMigration = { configured: false };

if (testDatabaseUrl) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: testDatabaseUrl });
  await client.connect();

  const schema = `sf_migration_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE saved_signals (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        symbol text NOT NULL,
        timeframe text NOT NULL,
        direction text NOT NULL,
        entry_price numeric NOT NULL,
        stop_loss numeric NOT NULL,
        take_profit numeric NOT NULL,
        risk_reward_ratio numeric NOT NULL,
        confidence_score integer NOT NULL,
        quality_score integer,
        setup_type text,
        reasoning text NOT NULL,
        confirmations jsonb NOT NULL DEFAULT '[]'::jsonb,
        indicators jsonb NOT NULL DEFAULT '{}'::jsonb,
        market_source text NOT NULL,
        generated_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE unlocked_signals (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        saved_signal_id text NOT NULL UNIQUE REFERENCES saved_signals(id) ON DELETE CASCADE
      );
      CREATE TABLE signal_outcomes (
        saved_signal_id text PRIMARY KEY REFERENCES saved_signals(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'Active',
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE paper_trades (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        saved_signal_id text NOT NULL REFERENCES saved_signals(id) ON DELETE CASCADE,
        entered_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, saved_signal_id)
      );
      CREATE TABLE trade_journals (
        paper_trade_id text PRIMARY KEY REFERENCES paper_trades(id) ON DELETE CASCADE,
        user_id text NOT NULL,
        notes_before_entry text NOT NULL DEFAULT '',
        notes_after_exit text NOT NULL DEFAULT '',
        emotion_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
        rating integer,
        screenshot_url text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE detected_alerts (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        symbol text NOT NULL,
        timeframe text NOT NULL,
        direction text NOT NULL,
        detected_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      INSERT INTO saved_signals (
        id, user_id, symbol, timeframe, direction, entry_price, stop_loss,
        take_profit, risk_reward_ratio, confidence_score, quality_score,
        setup_type, reasoning, market_source, generated_at, created_at
      )
      VALUES
        ('sig_old', 'usr_test', 'LTC-USD', '15m', 'long', 100, 95, 110, 2, 80, 80, 'Trend continuation', 'older duplicate', 'coinbase', to_timestamp(1783099436), now() - interval '2 minutes'),
        ('sig_complete', 'usr_test', 'LTC-USD', '15m', 'long', 100, 95, 110, 2, 80, 90, 'Trend continuation', 'complete duplicate', 'coinbase', to_timestamp(1783099436), now() - interval '1 minute');
      INSERT INTO unlocked_signals (id, user_id, saved_signal_id)
      VALUES ('unlk_complete', 'usr_test', 'sig_complete');
      INSERT INTO signal_outcomes (saved_signal_id, status)
      VALUES ('sig_complete', 'Active');
      INSERT INTO paper_trades (id, user_id, saved_signal_id)
      VALUES ('paper_complete', 'usr_test', 'sig_complete');
    `);

    await client.query("BEGIN");
    await client.query(migration);
    await client.query("COMMIT");

    const duplicateCount = await client.query(`
      SELECT count(*)::integer AS count
      FROM saved_signals
      WHERE user_id = 'usr_test'
        AND setup_key = 'LTC-USD:15m:long:1783099436'
    `);
    const keeper = await client.query("SELECT id FROM saved_signals WHERE user_id = 'usr_test'");
    const paper = await client.query("SELECT saved_signal_id FROM paper_trades WHERE id = 'paper_complete'");

    liveMigration = {
      configured: true,
      duplicateCount: duplicateCount.rows[0].count,
      keptCompleteRow: keeper.rows[0]?.id === "sig_complete",
      preservedPaperTrade: paper.rows[0]?.saved_signal_id === "sig_complete"
    };

    assert.equal(liveMigration.duplicateCount, 1, "Duplicate saved_signals should be deduplicated.");
    assert.equal(liveMigration.keptCompleteRow, true, "Most complete/unlocked row should be retained.");
    assert.equal(liveMigration.preservedPaperTrade, true, "Dependent paper trade should remain attached.");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

console.log(JSON.stringify({ ...staticChecks, liveMigration }, null, 2));
