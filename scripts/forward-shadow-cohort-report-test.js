import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  FORWARD_OUTCOME_R_VERSION,
  buildForwardOutcomeMetrics
} from "../src/modules/admin-signals/generatedSignalRepository.js";
import { updateAllGeneratedSignalOutcomes } from "../src/modules/admin-signals/generatedSignalService.js";
import {
  buildForwardShadowCohortReport,
  parseForwardShadowArguments
} from "./forward-shadow-cohort-report.js";

const tests = [];
const test = (name, callback) => tests.push({ name, callback });
const evaluatedAt = "2026-08-05T12:00:00.000Z";

test("TP maps to stored risk/reward with the exact outcome version and evaluation timestamp", () => {
  const metrics = buildForwardOutcomeMetrics("Hit TP", 2.35, evaluatedAt);
  assert.equal(metrics.realizedR, 2.35);
  assert.equal(metrics.outcomeRVersion, "terminal_v1_tp_rr_sl_minus1_expired_zero");
  assert.equal(metrics.outcomeEvaluatedAt.toISOString(), evaluatedAt);
});

test("SL maps to -1R and Expired maps to 0R", () => {
  assert.equal(buildForwardOutcomeMetrics("Hit SL", null, evaluatedAt).realizedR, -1);
  assert.equal(buildForwardOutcomeMetrics("Expired", null, evaluatedAt).realizedR, 0);
});

test("invalid TP risk/reward fails safely and visibly", () => {
  for (const riskReward of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => buildForwardOutcomeMetrics("Hit TP", riskReward, evaluatedAt),
      (error) => error.code === "INVALID_GENERATED_SIGNAL_RISK_REWARD"
    );
  }
});

test("outcome tracking isolates terminal update failures per signal and continues later groups", async () => {
  const nowMs = Date.parse("2026-08-05T12:00:00.000Z");
  const future = "2026-08-05T18:00:00.000Z";
  const expired = "2026-08-05T11:00:00.000Z";
  const createdAt = "2026-08-05T10:00:00.000Z";
  const signals = [
    activeSignal("bad-tp", { pair: "BTCUSD", timeframe: "15m", riskReward: 0, validUntil: future, createdAt }),
    activeSignal("good-sl", {
      pair: "BTCUSD",
      timeframe: "15m",
      riskReward: 2,
      validUntil: future,
      createdAt,
      direction: "short",
      stopLoss: 105,
      takeProfit: 90
    }),
    activeSignal("failed-expiration", { pair: "SOLUSD", timeframe: "1h", validUntil: expired, createdAt }),
    activeSignal("good-expiration", { pair: "SOLUSD", timeframe: "1h", validUntil: expired, createdAt }),
    activeSignal("later-group-tp", { pair: "ETHUSD", timeframe: "4h", riskReward: 2.4, validUntil: future, createdAt })
  ];
  const stored = new Map(signals.map((signal) => [signal.id, { ...signal }]));
  const warnings = [];
  const marketData = new Map([
    ["BTCUSD:15m", { candles: [{ time: "2026-08-05T11:00:00.000Z", high: 111, low: 91 }] }],
    ["ETHUSD:4h", { candles: [{ time: "2026-08-05T11:00:00.000Z", high: 111, low: 99 }] }]
  ]);

  const updateStatus = async (id, status, details) => {
    if (id === "failed-expiration") {
      const error = new Error("Fixture expiration persistence failure");
      error.code = "FIXTURE_EXPIRATION_UPDATE_FAILURE";
      throw error;
    }
    const current = stored.get(id);
    const metrics = details.recordForwardOutcomeMetrics
      ? buildForwardOutcomeMetrics(status, details.riskReward, details.evaluatedAt)
      : null;
    current.status = status;
    if (metrics) {
      current.realizedR = metrics.realizedR;
      current.outcomeEvaluatedAt = metrics.outcomeEvaluatedAt;
      current.outcomeRVersion = metrics.outcomeRVersion;
    }
    return current;
  };

  const updated = await updateAllGeneratedSignalOutcomes({
    listActiveGeneratedSignals: async () => signals,
    updateGeneratedSignalStatus: updateStatus,
    loadMarketData: async (signal) => marketData.get(`${signal.pair}:${signal.timeframe}`) || null,
    now: () => nowMs,
    warn: (message) => warnings.push(message)
  });

  assert.equal(updated, 3);
  assert.equal(stored.get("bad-tp").status, "Active");
  assert.equal(stored.get("bad-tp").realizedR, undefined);
  assert.equal(stored.get("good-sl").status, "Hit SL");
  assert.equal(stored.get("good-sl").realizedR, -1);
  assert.equal(stored.get("failed-expiration").status, "Active");
  assert.equal(stored.get("good-expiration").status, "Expired");
  assert.equal(stored.get("good-expiration").realizedR, 0);
  assert.equal(stored.get("later-group-tp").status, "Hit TP");
  assert.equal(stored.get("later-group-tp").realizedR, 2.4);
  assert.equal(warnings.length, 2);
  const expirationWarning = warnings.find((message) => message.includes('"signalId":"failed-expiration"'));
  const malformedTpWarning = warnings.find((message) => message.includes('"signalId":"bad-tp"'));
  assert.match(expirationWarning, /"attemptedStatus":"Expired"/);
  assert.match(expirationWarning, /"errorCode":"FIXTURE_EXPIRATION_UPDATE_FAILURE"/);
  assert.match(malformedTpWarning, /"pair":"BTCUSD"/);
  assert.match(malformedTpWarning, /"timeframe":"15m"/);
  assert.match(malformedTpWarning, /"attemptedStatus":"Hit TP"/);
  assert.match(malformedTpWarning, /"errorCode":"INVALID_GENERATED_SIGNAL_RISK_REWARD"/);
});

test("non-terminal signals receive no metrics", () => {
  for (const status of ["Active", "Watching", "Avoid Trade", "Rejected", "Manually closed"]) {
    assert.equal(buildForwardOutcomeMetrics(status, 2, evaluatedAt), null);
  }
});

test("migration adds nullable fields without defaults or backfill", async () => {
  const migration = await readFile(new URL("../migrations/054_generated_signal_forward_outcomes.sql", import.meta.url), "utf8");
  assert.match(migration, /realized_r numeric/i);
  assert.match(migration, /outcome_evaluated_at timestamptz/i);
  assert.match(migration, /outcome_r_version text/i);
  assert.doesNotMatch(migration, /\bDEFAULT\b/i);
  assert.doesNotMatch(migration, /\bUPDATE\s+generated_signals\b/i);
});

test("repository update is first-transition-only, atomic, and preserves existing metrics", async () => {
  const repository = await readFile(new URL("../src/modules/admin-signals/generatedSignalRepository.js", import.meta.url), "utf8");
  assert.match(repository, /UPDATE generated_signals SET[\s\S]*realized_r[\s\S]*outcome_evaluated_at[\s\S]*outcome_r_version[\s\S]*RETURNING \*/);
  assert.match(repository, /realized_r = COALESCE\(realized_r,/);
  assert.match(repository, /outcome_evaluated_at = COALESCE\(outcome_evaluated_at,/);
  assert.match(repository, /outcome_r_version = COALESCE\(outcome_r_version,/);
  assert.equal((repository.match(/WHEN status = 'Active' AND \$6::numeric IS NOT NULL/g) || []).length, 3);
});

test("confidence boundaries, dates, active separation, missing metrics, and source exclusions", () => {
  const rows = [
    row("sig-80", { confidence: 80, status: "Hit TP", realized_r: 2, pair: "BTCUSD" }),
    row("sig-84", { confidence: 84, status: "Hit SL", realized_r: -1, pair: "ETHUSD", timeframe: "1h" }),
    row("sig-79", { confidence: 79, status: "Hit TP", realized_r: 2 }),
    row("sig-85", { confidence: 85, status: "Hit TP", realized_r: 2 }),
    row("sig-before", { created_at: "2026-07-31T23:59:59.000Z", status: "Hit TP", realized_r: 2 }),
    row("sig-after", { created_at: "2026-09-01T00:00:01.000Z", status: "Hit TP", realized_r: 2 }),
    row("sig-active", { confidence: 82, status: "Active", realized_r: null, outcome_r_version: null, outcome_evaluated_at: null }),
    row("sig-missing", { confidence: 83, status: "Expired", realized_r: null, outcome_r_version: null, outcome_evaluated_at: null }),
    row("sig-backtest", { source: "backtest_shadow", status: "Hit TP", realized_r: 2 }),
    row("sig-test", { source: "admin_test", status: "Hit TP", realized_r: 2 }),
    row("sig-fixture", { generated_by: "fixture", status: "Hit TP", realized_r: 2 })
  ];
  const report = buildForwardShadowCohortReport(rows, {
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-09-01T00:00:00.000Z"
  });
  assert.equal(report.totals.matchingSignals, 4);
  assert.equal(report.totals.evaluatedSignals, 2);
  assert.equal(report.totals.activeIncompleteSignals, 1);
  assert.equal(report.totals.missingMetricRecords, 1);
  assert.equal(report.totals.tp, 1);
  assert.equal(report.totals.sl, 1);
  assert.equal(report.totals.totalRealizedR, 1);
  assert.deepEqual(report.missingMetricRecords[0].missing.sort(), ["outcome_evaluated_at", "outcome_r_version", "realized_r"]);
});

test("missing metrics are reported and never inferred from terminal status", () => {
  const report = buildForwardShadowCohortReport([
    row("missing-sl", { status: "Hit SL", realized_r: null, outcome_evaluated_at: null, outcome_r_version: null })
  ], { from: "2026-08-01T00:00:00.000Z" });
  assert.equal(report.totals.evaluatedSignals, 0);
  assert.equal(report.totals.sl, 0);
  assert.equal(report.totals.totalRealizedR, 0);
  assert.equal(report.totals.missingMetricRecords, 1);
});

test("canonical setup identity is deduplicated without double-counting", () => {
  const duplicate = row("duplicate-row", { setup_key: "shared-setup", status: "Hit TP", realized_r: 2, updated_at: "2026-08-05T13:00:00.000Z" });
  const report = buildForwardShadowCohortReport([
    row("original-row", { setup_key: "shared-setup", status: "Active", realized_r: null, outcome_r_version: null, outcome_evaluated_at: null }),
    duplicate
  ], { from: "2026-08-01T00:00:00.000Z" });
  assert.equal(report.totals.matchingSignals, 1);
  assert.equal(report.totals.evaluatedSignals, 1);
  assert.equal(report.signalIdentifiers[0].id, "duplicate-row");
});

test("forward target requires 30 evaluated signals, two symbols, and two timeframes", () => {
  const qualifying = Array.from({ length: 30 }, (_, index) => row(`target-${index}`, {
    pair: index % 2 ? "BTCUSD" : "ETHUSD",
    timeframe: index % 2 ? "15m" : "1h",
    status: index % 3 === 0 ? "Hit TP" : "Hit SL",
    realized_r: index % 3 === 0 ? 2 : -1
  }));
  const met = buildForwardShadowCohortReport(qualifying, { from: "2026-08-01T00:00:00.000Z" });
  assert.equal(met.forwardObservationTarget.met, true);
  assert.equal(met.liveRecommendation, null);

  const tooFew = buildForwardShadowCohortReport(qualifying.slice(0, 29), { from: "2026-08-01T00:00:00.000Z" });
  assert.equal(tooFew.forwardObservationTarget.met, false);
  const oneSymbol = qualifying.map((item) => ({ ...item, pair: "BTCUSD" }));
  assert.equal(buildForwardShadowCohortReport(oneSymbol, { from: "2026-08-01T00:00:00.000Z" }).forwardObservationTarget.met, false);
  const oneTimeframe = qualifying.map((item) => ({ ...item, timeframe: "15m" }));
  assert.equal(buildForwardShadowCohortReport(oneTimeframe, { from: "2026-08-01T00:00:00.000Z" }).forwardObservationTarget.met, false);
});

test("report arguments require an ISO from timestamp", () => {
  assert.throws(() => parseForwardShadowArguments([]), /--from/);
  assert.throws(() => parseForwardShadowArguments(["--from", "not-a-date"]), /ISO/);
  assert.deepEqual(parseForwardShadowArguments(["--from", "2026-08-01T00:00:00.000Z"]), {
    from: "2026-08-01T00:00:00.000Z",
    to: null,
    output: null
  });
});

test("report and instrumentation contain no Telegram queue or credit behavior", async () => {
  const reportSource = await readFile(new URL("./forward-shadow-cohort-report.js", import.meta.url), "utf8");
  const repositorySource = await readFile(new URL("../src/modules/admin-signals/generatedSignalRepository.js", import.meta.url), "utf8");
  const serviceSource = await readFile(new URL("../src/modules/admin-signals/generatedSignalService.js", import.meta.url), "utf8");
  const changedSources = `${reportSource}\n${repositorySource}\n${serviceSource}`;
  assert.doesNotMatch(changedSources, /enqueueTelegramNotification|telegram_notification_queue|unlockCredits|credit/i);
});

function row(id, overrides = {}) {
  return {
    id,
    signal_id: `signal:${id}`,
    dedupe_key: `dedupe:${id}`,
    setup_key: `setup:${id}`,
    pair: "BTCUSD",
    timeframe: "15m",
    strategy: "Breakout retest",
    direction: "long",
    confidence: 82,
    calibrated_confidence: null,
    source: "manual_scan",
    source_history: ["manual_scan"],
    generated_by: "system",
    status: "Expired",
    risk_reward: 2,
    realized_r: 0,
    outcome_evaluated_at: evaluatedAt,
    outcome_r_version: FORWARD_OUTCOME_R_VERSION,
    created_at: "2026-08-05T12:00:00.000Z",
    updated_at: "2026-08-05T12:00:00.000Z",
    ...overrides
  };
}

function activeSignal(id, overrides = {}) {
  return {
    id,
    pair: "BTCUSD",
    timeframe: "15m",
    direction: "long",
    entry: 100,
    stopLoss: 90,
    takeProfit: 110,
    riskReward: 2,
    status: "Active",
    source: "manual_scan",
    sourceHistory: ["manual_scan"],
    generatedBy: "system",
    createdAt: "2026-08-05T10:00:00.000Z",
    validUntil: "2026-08-05T18:00:00.000Z",
    ...overrides
  };
}

let failures = 0;
for (const item of tests) {
  try {
    await item.callback();
    console.log(`PASS ${item.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${item.name}`);
    console.error(error.stack || error.message);
  }
}

console.log(`\nForward-shadow cohort tests: ${tests.length - failures} passed, ${failures} failed.`);
if (failures) process.exitCode = 1;
