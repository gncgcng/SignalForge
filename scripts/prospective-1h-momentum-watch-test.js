import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  calculateMomentum1hWatchDiagnostics,
  evaluatePreFixMomentumClassifier,
  MOMENTUM_1H_WATCH_STARTED_AT,
  MOMENTUM_1H_WATCH_VERSION
} from "../src/modules/signals/momentum1hWatchDiagnostics.js";
import {
  buildProspective1hMomentumWatchReport,
  sampleLabel
} from "./prospective-1h-momentum-watch-report.js";

const generatedAt = "2026-09-02T01:00:00.000Z";
const baseSignal = {
  id: "sig-watch",
  symbol: "BTC-USD",
  timeframe: "1h",
  setupType: "Momentum breakout",
  direction: "long",
  generatedAt,
  status: "Active",
  entryPrice: 105,
  stopLoss: 101,
  takeProfit: 115,
  riskRewardRatio: 2.5,
  confidenceScore: 88,
  qualityScore: 91,
  readinessScore: 96,
  strategyEvidence: {
    strategy: "Momentum breakout",
    qualified: true,
    referenceLevel: 100,
    interveningCloseMinus3: 99,
    interveningCloseMinus2: 99.5,
    priorBreakoutDetected: false,
    breakoutFresh: true,
    triggerCandle: { time: generatedAt, open: 101, high: 106, low: 100.5, close: 105, volume: 150 }
  },
  indicators: {
    atr14: 2,
    ema20: 103,
    ema50: 100,
    rsi14: 61,
    adx14: 27,
    trendStrength: 0.68,
    regime: "Breakout",
    momentumEntryDiagnostics: {
      version: "momentum_entry_shadow_v1",
      latestCandleRangeAtr: 2.75,
      latestBodyAtr: 2,
      bodyToRangeRatio: 0.727273,
      breakoutDistanceAtr: 2.5,
      ema20DistanceAtr: 1,
      ema50DistanceAtr: 2.5,
      stopDistanceAtr: 2,
      stopBeyondBreakoutCandleAtr: -0.25,
      closeBeyondLevelAtr: 2.5,
      volumeRatio: 1.5,
      prior3BarMoveAtr: 2.25,
      directionalExpansionCount3: 1
    }
  }
};

const before = JSON.parse(JSON.stringify(baseSignal));
const diagnostic = calculateMomentum1hWatchDiagnostics(baseSignal);
assert.equal(diagnostic.version, MOMENTUM_1H_WATCH_VERSION);
assert.equal(diagnostic.studyStartedAt, MOMENTUM_1H_WATCH_STARTED_AT);
assert.equal(diagnostic.productionDecisionInput, false);
assert.equal(diagnostic.productionSnapshot.entry, 105);
assert.equal(diagnostic.productionSnapshot.stopLoss, 101);
assert.equal(diagnostic.productionSnapshot.takeProfit, 115);
assert.equal(diagnostic.productionSnapshot.riskReward, 2.5);
assert.equal(diagnostic.productionSnapshot.confidence, 88);
assert.equal(diagnostic.productionSnapshot.quality, 91);
assert.equal(diagnostic.productionSnapshot.readiness, 96);
assert.equal(diagnostic.momentumEvidence.referenceLevel, 100);
assert.equal(diagnostic.momentumEvidence.candleRangeAtr, 2.75);
assert.equal(diagnostic.preFixCounterfactual.wouldPreFixMomentumPass, true);
assert.equal(diagnostic.preFixCounterfactual.reason, "PASS");
assert.equal(diagnostic.preFixCounterfactual.diagnosticOnly, true);
assert.equal(diagnostic.shadowDisabled.affectsProduction, false);
assert.deepEqual(baseSignal, before, "diagnostic calculation must not mutate the production signal");

assert.equal(calculateMomentum1hWatchDiagnostics({ ...baseSignal, timeframe: "15m" }), null);
assert.equal(calculateMomentum1hWatchDiagnostics({ ...baseSignal, timeframe: "4h" }), null);
assert.equal(calculateMomentum1hWatchDiagnostics({ ...baseSignal, setupType: "Breakout retest" }), null);
assert.equal(calculateMomentum1hWatchDiagnostics({
  ...baseSignal,
  generatedAt: "2026-09-01T23:59:59.999Z"
}), null, "pre-study signals must not receive the prospective diagnostic");

const oldReject = evaluatePreFixMomentumClassifier({
  direction: "long",
  entryPrice: 105,
  indicators: baseSignal.indicators,
  momentum: baseSignal.indicators.momentumEntryDiagnostics,
  evidence: { ...baseSignal.strategyEvidence, interveningCloseMinus2: 101 }
});
assert.equal(oldReject.deterministic, true);
assert.equal(oldReject.wouldPreFixMomentumPass, false);
assert.equal(oldReject.reason, "FRESHNESS");
assert.equal(oldReject.diagnosticOnly, true);

const activeDiagnostic = calculateMomentum1hWatchDiagnostics({
  ...baseSignal,
  id: "sig-active",
  generatedAt: "2026-09-02T03:00:00.000Z"
});
const rejectDiagnostic = {
  ...diagnostic,
  generatedAt: "2026-09-02T02:00:00.000Z",
  preFixCounterfactual: oldReject
};
const rows = [
  row("tp", diagnostic, { status: "Hit TP", realized_r: 2.5, outcome_evaluated_at: "2026-09-02T10:00:00.000Z" }),
  row("sl", rejectDiagnostic, { status: "Hit SL", realized_r: -1, outcome_evaluated_at: "2026-09-02T12:00:00.000Z" }),
  row("active", activeDiagnostic, { status: "Active", realized_r: null, outcome_evaluated_at: null }),
  row("wrong-timeframe", { ...diagnostic, timeframe: "15m" }, { timeframe: "15m" }),
  row("pre-study", { ...diagnostic, generatedAt: "2026-09-01T23:00:00.000Z" }, {
    created_at: "2026-09-01T23:00:00.000Z",
    status: "Hit SL",
    realized_r: -1
  })
];
const originalStatuses = rows.map((item) => item.status);
const report = buildProspective1hMomentumWatchReport(rows, {
  asOf: "2026-09-05T00:00:00.000Z",
  timezone: "America/Tijuana"
});

assert.equal(report.production.generated, 3);
assert.equal(report.production.terminal, 2);
assert.equal(report.production.decided, 2);
assert.equal(report.production.active, 1);
assert.equal(report.production.tp, 1);
assert.equal(report.production.sl, 1);
assert.equal(report.production.expired, 0);
assert.equal(report.production.netR, 1.5);
assert.equal(report.production.expectancyR, 0.75);
assert.equal(report.preFixPass.generated, 2);
assert.equal(report.preFixReject.generated, 1);
assert.equal(report.preFixRejectReasons.FRESHNESS, 1);
assert.equal(report.shadowDisabled.disabledNetR, 0);
assert.equal(report.shadowDisabled.netRDifference, -1.5);
assert.equal(report.shadowDisabled.unresolvedTradesAreNotTerminalZeroes, true);
assert.equal(report.sampleMaturity.label, "INSUFFICIENT");
assert.equal(report.maturity.at24Hours.eligibleGenerated, 3);
assert.equal(report.maturity.at24Hours.active, 1);
assert.deepEqual(rows.map((item) => item.status), originalStatuses, "reporting must not alter canonical outcomes");

assert.equal(sampleLabel(9), "INSUFFICIENT");
assert.equal(sampleLabel(10), "VERY EARLY");
assert.equal(sampleLabel(20), "EARLY EVIDENCE");
assert.equal(sampleLabel(30), "ELIGIBLE FOR FORMAL REVIEW");

const repositorySource = await readFile(resolve("src/modules/admin-signals/generatedSignalRepository.js"), "utf8");
const reportSource = await readFile(resolve("scripts/prospective-1h-momentum-watch-report.js"), "utf8");
const signalServiceSource = await readFile(resolve("src/modules/signals/signalService.js"), "utf8");
const watcherSource = await readFile(resolve("src/modules/alerts/autoScanService.js"), "utf8");
const notificationSource = await readFile(resolve("src/modules/notifications/notificationService.js"), "utf8");

assert.match(repositorySource, /calculateMomentum1hWatchDiagnostics\(signal\)/);
assert.match(repositorySource, /productionReady[\s\S]*momentum1hWatchDiagnostics/);
assert.match(reportSource, /BEGIN READ ONLY/);
assert.match(reportSource, /default_transaction_read_only=on/);
assert.doesNotMatch(reportSource, /\b(?:INSERT|UPDATE|DELETE)\b/);
assert.doesNotMatch(signalServiceSource, /momentum1hWatchDiagnostics|momentum_1h_watch_v1/);
assert.doesNotMatch(watcherSource, /momentum1hWatchDiagnostics|momentum_1h_watch_v1/);
assert.doesNotMatch(notificationSource, /momentum1hWatchDiagnostics|momentum_1h_watch_v1/);

console.log(JSON.stringify({
  version: MOMENTUM_1H_WATCH_VERSION,
  studyStartedAt: MOMENTUM_1H_WATCH_STARTED_AT,
  eligibleDiagnostic: diagnostic,
  report: {
    production: report.production,
    preFixPass: report.preFixPass,
    preFixReject: report.preFixReject,
    shadowDisabled: report.shadowDisabled,
    sampleMaturity: report.sampleMaturity
  },
  productionProjectionUnchanged: before,
  safety: report.safety
}, null, 2));

function row(id, watchDiagnostic, overrides = {}) {
  const createdAt = overrides.created_at || watchDiagnostic.generatedAt;
  return {
    id: `agen-${id}`,
    signal_id: `sig-${id}`,
    setup_key: `BTC-USD:1h:long:${id}`,
    pair: "BTC-USD",
    timeframe: overrides.timeframe || "1h",
    strategy: "Momentum breakout",
    direction: "long",
    status: overrides.status || "Active",
    valid_until: overrides.valid_until || "2026-09-03T00:00:00.000Z",
    realized_r: overrides.realized_r ?? null,
    outcome_evaluated_at: overrides.outcome_evaluated_at ?? null,
    created_at: createdAt,
    full_analysis: { indicators: { momentum1hWatchDiagnostics: watchDiagnostic } }
  };
}
