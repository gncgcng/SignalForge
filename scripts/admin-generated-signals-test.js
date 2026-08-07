import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
    signalService.includes('const generationSource = generationContext.source || "manual_scan"') &&
    signalService.includes("source: generationSource") &&
    autoScan.includes('source: "auto_crypto_watcher"') &&
    autoScan.includes('source: "telegram_alert"') &&
    autoScan.includes("calibrateTelegramAlertSetup") &&
    signalService.includes('source: "candidate_promotion"') &&
    signalService.includes("saveGeneratedSignal(preserveDownstreamConfidence(signal)") &&
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
  generatedHistoryVisibleInAdminView:
    html.includes('class="admin-signal-filters" id="admin-signal-filters"') &&
    html.includes('class="admin-signals-table-wrap" id="admin-signals-table"') &&
    html.includes('class="admin-signals-pagination"') &&
    html.includes("Loading generated signals...") &&
    app.slice(app.indexOf("function renderAdminSignals()"), app.indexOf("function renderAdminSignalQualityPanel"))
      .includes("data.signals.map(renderAdminSignalRow)"),
  userSignalsRemainSeparate:
    controller.includes("/api/admin/signals") &&
    !controller.includes("listUserSignals") &&
    signalService.includes("saveUnlockedSignal(user.id, signal)"),
  mobileSafe:
    css.includes(".admin-generated-row") && css.includes(".admin-signal-detail-card") &&
    css.includes("@media (max-width: 767px)") && css.includes("grid-template-columns: 1fr") &&
    css.includes(".admin-signal-row-actions") &&
    css.includes("grid-template-columns: repeat(2, minmax(0, 1fr))") &&
    css.includes("word-break: normal") &&
    app.includes("Show details") &&
    app.includes("Raw ${Number(signal.rawSetupScore"),
  scannerAdminSourceSeparation:
    !extractNamedFunction(app, "renderSignals").match(/state\.signals|state\.adminSignals|renderAdminSignalRow/) &&
    !extractNamedFunction(app, "renderAdminSignals").match(/state\.scanResults|signalsGrid|renderScanCard/) &&
    !extractNamedFunction(app, "loadAdminSignals").match(/state\.scanResults|signalsGrid|renderSignals\(/) &&
    !extractNamedFunction(app, "renderScanResults").match(/state\.adminSignals|adminSignalsTable|renderAdminSignalRow/)
};

const historicalSignals = [
  ...Array.from({ length: 20 }, (_, index) => adminSignal(`history-sl-${index}`, "Hit SL")),
  ...Array.from({ length: 15 }, (_, index) => adminSignal(`history-expired-${index}`, "Expired")),
  ...Array.from({ length: 14 }, (_, index) => adminSignal(`history-active-${index}`, "Active"))
];
const adminRender = renderActualAdminSignals(historicalSignals);
assert.equal(adminRender.renderedRows, 49);
assert.equal(adminRender.detailButtons, 49);
assert.match(adminRender.html, /Hit SL/);
assert.match(adminRender.html, /Expired/);
assert.match(adminRender.html, /Active/);
assert.equal(adminRender.totalLabel, "49 records");
assert.deepEqual(adminRender.scanResults, ["TRUMP-USD", "PLUME-USD"]);
assert.equal(adminRender.scannerHtml, "scanner-current-session");

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

console.log(JSON.stringify({
  ...checks,
  adminHistoryRendering: {
    availableRecords: historicalSignals.length,
    renderedRows: adminRender.renderedRows,
    detailButtons: adminRender.detailButtons,
    scannerResultsPreserved: adminRender.scanResults.length
  },
  liveMigration
}, null, 2));

function renderActualAdminSignals(signals) {
  const elements = new Map([
    ["#admin-signals-total-label", { textContent: "" }],
    ["#admin-signal-stats", { innerHTML: "" }],
    ["#admin-signals-page-label", { textContent: "" }],
    ["#admin-signals-prev", { disabled: false }],
    ["#admin-signals-next", { disabled: false }]
  ]);
  const adminSignalsTable = { innerHTML: "" };
  const signalsGrid = { innerHTML: "scanner-current-session" };
  const state = {
    scanResults: ["TRUMP-USD", "PLUME-USD"],
    adminSignals: {
      signals,
      total: signals.length,
      page: 1,
      totalPages: 2,
      stats: { total: signals.length, active: 14, hitSl: 20, expired: 15 },
      qualityBreakdown: {}
    }
  };
  const context = {
    state,
    signalsGrid,
    adminSignalsTable,
    document: { querySelector: (selector) => elements.get(selector) },
    renderAdminSignalQualityPanel: () => {},
    formatInteger: (value) => String(Number(value || 0)),
    formatCurrency: (value) => String(value),
    formatDateTime: (value) => String(value),
    escapeHtml: (value) => String(value ?? ""),
    titleCase: (value) => String(value ?? ""),
    adminSignalStatusClass: () => "status-fixture"
  };
  vm.createContext(context);
  vm.runInContext([
    extractNamedFunction(app, "renderAdminSignalRow"),
    extractNamedFunction(app, "renderAdminSignals")
  ].join("\n\n"), context);
  context.renderAdminSignals();
  return {
    html: adminSignalsTable.innerHTML,
    renderedRows: (adminSignalsTable.innerHTML.match(/<article class="admin-generated-row">/g) || []).length,
    detailButtons: (adminSignalsTable.innerHTML.match(/>Show details<\/button>/g) || []).length,
    totalLabel: elements.get("#admin-signals-total-label").textContent,
    scanResults: state.scanResults,
    scannerHtml: signalsGrid.innerHTML
  };
}

function adminSignal(id, status) {
  return {
    id,
    signalId: id,
    displayPair: "BTCUSD",
    pair: "BTC-USD",
    provider: "coinbase",
    direction: "long",
    timeframe: "15m",
    strategy: "Breakout retest",
    entry: 100,
    stopLoss: 98,
    takeProfit: 104,
    riskReward: 2,
    confidence: 82,
    setupQualityScore: 84,
    entryReadinessScore: 90,
    status,
    resultReason: status,
    source: "manual_scan",
    createdAt: "2026-08-07T12:00:00.000Z",
    validUntil: "2026-08-07T18:00:00.000Z"
  };
}

function extractNamedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing function ${name}`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unterminated function ${name}`);
}
