import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("migrations/043_admin_generated_signals.sql");
const repository = read("src/modules/admin-signals/generatedSignalRepository.js");
const service = read("src/modules/admin-signals/generatedSignalService.js");
const controller = read("src/modules/admin-signals/generatedSignalController.js");
const signalService = read("src/modules/signals/signalService.js");
const outcomeService = read("src/modules/signals/signalOutcomeService.js");
const autoScan = read("src/modules/alerts/autoScanService.js");
const backtest = read("src/modules/backtesting/backtestService.js");
const server = read("src/server.js");
const html = read("public/index.html");
const app = read("public/app.js");
const css = read("public/styles.css");

const checks = {
  createsIndexedStore:
    /CREATE TABLE IF NOT EXISTS generated_signals/i.test(migration) &&
    ["created", "pair", "timeframe", "status", "source", "strategy", "pattern"]
      .every((name) => migration.includes(`idx_generated_signals_${name}`)),
  safeLegacyBackfill:
    migration.includes("SELECT DISTINCT ON") &&
    migration.includes("legacy_saved_signal") &&
    migration.includes("legacy_unlocked_signal") &&
    migration.includes("ON CONFLICT (dedupe_key) DO UPDATE") &&
    !/DELETE\s+FROM\s+(?:users|saved_signals|unlocked_signals|subscriptions|credit_balances)/i.test(migration),
  centralizedAutomaticSave:
    signalService.includes("saveGeneratedSignal(signal") &&
    signalService.includes('source: generationContext.source || "manual_scan"') &&
    autoScan.includes('source: "auto_crypto_watcher"') &&
    autoScan.includes('source: "telegram_alert"') &&
    signalService.includes('source: "candidate_promotion"') &&
    signalService.includes("if (signal) {") &&
    signalService.includes("validation?.passed"),
  backtestShadowStored:
    backtest.includes("persistBacktestShadowSignals(reports, user)") &&
    backtest.includes('source: "backtest_shadow"') &&
    backtest.includes("Promise.allSettled"),
  dedupeAndUpdate:
    repository.includes("ON CONFLICT (dedupe_key) DO UPDATE") &&
    repository.includes("buildGeneratedSignalKey") &&
    repository.includes("source_history") &&
    repository.includes("generated_signals.source_history") &&
    !repository.includes("signal_id = EXCLUDED.signal_id"),
  terminalStatusProtected:
    repository.includes("WHEN 'Hit TP' THEN 6") &&
    repository.includes("WHEN 'Hit SL' THEN 5") &&
    repository.includes("manually_closed_at") &&
    migration.includes("generated_signals.status IN ('Hit TP', 'Hit SL', 'Manually closed')"),
  outcomesStaySynchronized:
    outcomeService.includes("updateAllGeneratedSignalOutcomes") &&
    outcomeService.includes("syncGeneratedSignalOutcome") &&
    repository.includes("post_mortem_tags") &&
    repository.includes("max_favorable_excursion"),
  adminOnlyApi:
    controller.includes("if (!req.user)") &&
    controller.includes("if (!isAdminUser(req.user))") &&
    controller.includes('pathname.startsWith("/api/admin/signals")') &&
    server.includes("handleAdminGeneratedSignalRoutes"),
  noAdminCreditPath:
    !`${repository}\n${service}\n${controller}`.match(/deduct|consume.*credit|recordDiscoveryUsage|saveUnlockedSignal|credit_balances/i),
  filtersAndPagination:
    repository.includes("filters.pair") && repository.includes("filters.timeframe") &&
    repository.includes("filters.status") && repository.includes("filters.source") &&
    repository.includes("filters.strategy") && repository.includes("LIMIT") &&
    repository.includes("OFFSET") && repository.includes("totalPages"),
  dashboardAndFullDetails:
    html.includes('id="admin-signals-view"') && html.includes("All generated signals") &&
    html.includes('id="admin-signal-modal"') && app.includes("renderAdminSignalDetail") &&
    app.includes("Entry") && app.includes("Stop loss") && app.includes("Take profit") &&
    app.includes("Signal quality breakdown") && app.includes("Candidate origin") &&
    app.includes("Outcome and post-mortem"),
  userSignalsRemainSeparate:
    controller.includes("/api/admin/signals") &&
    !controller.includes("listUserSignals") &&
    signalService.includes("saveUnlockedSignal(user.id, signal)"),
  mobileSafe:
    css.includes(".admin-generated-row") && css.includes(".admin-signal-detail-card") &&
    css.includes("@media (max-width: 760px)") && css.includes("grid-template-columns: 1fr")
};

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(Boolean(passed), true, `Admin generated signals check failed: ${name}`);
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
let liveMigration = { configured: false };
if (testDatabaseUrl) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: testDatabaseUrl });
  await client.connect();
  const schema = `sf_admin_signals_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE saved_signals (
        id text PRIMARY KEY, setup_key text, symbol text, market_source text,
        timeframe text, direction text, setup_type text, entry_price numeric,
        stop_loss numeric, take_profit numeric, risk_reward_ratio numeric,
        confidence_score numeric, quality_score numeric, indicators jsonb DEFAULT '{}'::jsonb,
        reasoning text, confirmations jsonb DEFAULT '[]'::jsonb, validation_passed boolean,
        validation_score numeric, valid_until timestamptz, expired_at timestamptz,
        generated_at timestamptz, created_at timestamptz
      );
      CREATE TABLE signal_outcomes (saved_signal_id text, status text, resolved_at timestamptz, status_reason text, updated_at timestamptz);
      CREATE TABLE unlocked_signals (saved_signal_id text);
      CREATE TABLE signal_learning_events (signal_id text, post_mortem_tags jsonb DEFAULT '[]'::jsonb);
    `);
    await client.query(`INSERT INTO saved_signals VALUES
      ('sig_a','same-key','BTC-USD','coinbase','15m','long','Pullback bounce',100,95,110,2,82,84,'{}','A','[]',true,90,now()+interval '6 hours',null,now(),now()-interval '1 minute'),
      ('sig_b','same-key','BTC-USD','coinbase','15m','long','Pullback bounce',100,95,110,2,83,85,'{}','B','[]',true,91,now()+interval '6 hours',null,now(),now());
    INSERT INTO unlocked_signals VALUES ('sig_b');`);
    await client.query(migration);
    await client.query(migration);
    const rows = await client.query("SELECT count(*)::integer AS count, max(source) AS source FROM generated_signals");
    liveMigration = { configured: true, rows: rows.rows[0].count, source: rows.rows[0].source };
    assert.equal(liveMigration.rows, 1, "Backfill must deduplicate legacy signals.");
    assert.equal(liveMigration.source, "legacy_unlocked_signal", "Backfill should preserve the more complete unlocked row.");
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

console.log(JSON.stringify({ ...checks, liveMigration }, null, 2));
