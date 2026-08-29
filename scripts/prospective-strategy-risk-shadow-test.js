import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildStructuralShadowStop,
  calculateStrategyRiskShadowDiagnostics,
  evaluateStrategyRiskShadowOutcomes,
  STRATEGY_RISK_SHADOW_STARTED_AT,
  STRATEGY_RISK_SHADOW_VERSION
} from "../src/modules/signals/strategyRiskShadowDiagnostics.js";
import {
  buildProspectiveStrategyRiskShadowReport,
  evaluateProspectiveStrategyRiskRows
} from "./prospective-strategy-risk-shadow-report.js";

assert.equal(STRATEGY_RISK_SHADOW_VERSION, "strategy_risk_shadow_v1");
assert.equal(buildStructuralShadowStop({ direction: "long", naturalInvalidation: 95, atr: 2 }), 94.6);
assert.equal(buildStructuralShadowStop({ direction: "short", naturalInvalidation: 105, atr: 2 }), 105.4);
assert.equal(buildStructuralShadowStop({ direction: "long", naturalInvalidation: null, atr: 2 }), null);

const longSignal = signalFixture({ direction: "long", invalidationLevel: 95 });
const longDiagnostics = calculateStrategyRiskShadowDiagnostics(longSignal);
assert.equal(longDiagnostics.invalidationStatus, "USABLE");
assert.equal(longDiagnostics.shadowPlan.stopLoss, 94.6);
assert.equal(longDiagnostics.shadowPlan.modelB.takeProfit, longSignal.takeProfit);
assert.equal(longDiagnostics.shadowPlan.modelB.riskReward, 2.222222);
assert.equal(longDiagnostics.shadowPlan.modelC.takeProfit, 110);
assert.equal(longDiagnostics.shadowPlan.modelC.riskReward, 1.851852);
assert.equal(longDiagnostics.shadowPlan.modelC.opposingStructureCapApplied, true);
assert.equal(longDiagnostics.productionEntry, longSignal.entryPrice);
assert.equal(longDiagnostics.productionSL, longSignal.stopLoss);
assert.equal(longDiagnostics.productionTP, longSignal.takeProfit);
assert.equal(longDiagnostics.productionRR, longSignal.riskRewardRatio);
assert.equal(longDiagnostics.shadowSL, 94.6);
assert.equal(longDiagnostics.shadowRiskDistance, 5.4);
assert.equal(longDiagnostics.originalTpShadowRR, 2.222222);
assert.equal(longDiagnostics.sameRShadowTP, 110);
assert.equal(longDiagnostics.sameRShadowRR, 1.851852);
assert.equal(longDiagnostics.shadowWouldPassRR, true);
assert.equal(longDiagnostics.productionPlan.stopLoss, longSignal.stopLoss);
assert.equal(longDiagnostics.productionPlan.takeProfit, longSignal.takeProfit);
assert.equal(longDiagnostics.productionPlan.riskReward, longSignal.riskRewardRatio);
assert.deepEqual(decisionProjection(longSignal), decisionProjection({ ...longSignal, diagnostics: longDiagnostics }));

const shadowRrFailureSignal = signalFixture({ takeProfit: 108, riskRewardRatio: 2 });
const shadowRrFailure = calculateStrategyRiskShadowDiagnostics(shadowRrFailureSignal);
assert.equal(shadowRrFailure.shadowWouldPassRR, false);
assert.equal(shadowRrFailure.originalTpShadowRR, 1.481481);
assert.deepEqual(
  decisionProjection(shadowRrFailureSignal),
  decisionProjection({ ...shadowRrFailureSignal, diagnostics: shadowRrFailure }),
  "A diagnostic shadow R/R failure must not change production eligibility"
);

const shortSignal = signalFixture({
  direction: "short",
  entryPrice: 100,
  stopLoss: 106,
  takeProfit: 88,
  invalidationLevel: 105,
  indicators: { atr14: 2, support: 90, resistance: 105.5, ema20: 102, ema50: 104, regime: "Trend Down" }
});
const shortDiagnostics = calculateStrategyRiskShadowDiagnostics(shortSignal);
assert.equal(shortDiagnostics.shadowPlan.stopLoss, 105.4);
assert.equal(shortDiagnostics.shadowPlan.modelB.takeProfit, 88);
assert.equal(shortDiagnostics.shadowPlan.modelC.takeProfit, 90);

const unavailable = calculateStrategyRiskShadowDiagnostics(signalFixture({
  strategyEvidence: { strategy: "Breakout retest", qualified: false, invalidationLevel: null }
}));
assert.equal(unavailable.invalidationStatus, "UNAVAILABLE");
assert.equal(unavailable.shadowPlan, null);

const momentum = calculateStrategyRiskShadowDiagnostics(signalFixture({
  setupType: "Momentum breakout",
  strategyEvidence: {
    strategy: "Momentum breakout",
    qualified: true,
    referenceLevel: 104,
    triggerCandle: candle("2026-08-28T01:00:00.000Z", 104, 107, 103, 106)
  }
}));
assert.equal(momentum.invalidationStatus, "PARTIAL");
assert.equal(momentum.shadowPlan, null);
assert.deepEqual(momentum.momentumCandidates, {
  breakoutReferenceLevel: 104,
  triggerDirectionalExtreme: 103,
  localStructuralSwing: 96
});

const mtf = calculateStrategyRiskShadowDiagnostics(signalFixture({
  setupType: "Multi-timeframe continuation",
  strategyEvidence: {
    strategy: "Multi-timeframe continuation",
    passed: true,
    baseRegimeDirection: "long",
    higherTimeframes: [{ timeframe: "1h", state: "aligned" }],
    alignedCount: 1,
    opposingCount: 0,
    unavailableCount: 0
  }
}));
assert.equal(mtf.invalidationStatus, "MISSING");
assert.equal(mtf.shadowPlan, null);
assert.equal(mtf.multiTimeframeContext.baseRegime, "long");
assert.equal(mtf.multiTimeframeContext.ema20, 98);

const terminalCandles = [
  candle("2026-08-28T01:15:00.000Z", 100, 101, 94.8, 100),
  candle("2026-08-28T01:30:00.000Z", 100, 113, 94.5, 110)
];
const terminal = evaluateStrategyRiskShadowOutcomes({
  diagnostics: longDiagnostics,
  candles: terminalCandles,
  validUntil: "2026-08-28T01:45:00.000Z",
  productionOutcome: "Hit TP"
});
assert.equal(terminal.shadowOriginalTpOutcome, "Hit SL", "stop-first ordering must win an ambiguous candle");
assert.equal(terminal.shadowSameRTargetOutcome, "Hit SL");
assert.equal(terminal.sameCandleAmbiguity, true);
assert.equal(terminal.postInvalidation.occurred, true);
assert.equal(terminal.postInvalidation.laterProductionPathOutcome, "Hit TP");
assert.equal(terminal.immediateShadowStopTouch, "candles_2_to_3");

const expired = evaluateStrategyRiskShadowOutcomes({
  diagnostics: longDiagnostics,
  candles: [
    candle("2026-08-28T01:15:00.000Z", 100, 105, 96, 101),
    candle("2026-08-28T01:30:00.000Z", 101, 106, 96, 102)
  ],
  validUntil: "2026-08-28T01:45:00.000Z",
  productionOutcome: "Expired"
});
assert.equal(expired.shadowOriginalTpOutcome, "Expired");
assert.equal(expired.shadowSameRTargetOutcome, "Expired");
const incomplete = evaluateStrategyRiskShadowOutcomes({
  diagnostics: longDiagnostics,
  candles: [candle("2026-08-28T01:15:00.000Z", 100, 105, 96, 101)],
  validUntil: "2026-08-28T01:45:00.000Z",
  productionOutcome: "Expired"
});
assert.equal(incomplete.shadowOriginalTpOutcome, null);
assert.equal(incomplete.shadowSameRTargetOutcome, null);

const generatedRows = await evaluateProspectiveStrategyRiskRows([
  reportRow("terminal", "Hit TP", 2, longDiagnostics),
  reportRow("active", "Active", null, longDiagnostics),
  reportRow("legacy", "Hit SL", -1, { ...longDiagnostics, version: "strategy_risk_shadow_v0" }),
  reportRow("before-start", "Hit SL", -1, {
    ...longDiagnostics,
    generatedAt: "2026-08-27T23:59:59.000Z"
  })
], async () => terminalCandles);
const report = buildProspectiveStrategyRiskShadowReport(generatedRows);
assert.equal(report.version, STRATEGY_RISK_SHADOW_VERSION);
assert.equal(report.studyStartedAt, STRATEGY_RISK_SHADOW_STARTED_AT);
assert.equal(report.totals.generated, 2, "old versions and pre-study observations must be excluded");
assert.equal(report.totals.terminal, 1);
assert.equal(report.totals.open, 1);
assert.equal(report.totals.production.tp, 1);
assert.equal(report.totals.modelB.sl, 1);
assert.equal(report.totals.sampleSufficiency, "INSUFFICIENT");
assert.equal(report.safety.recommendation, null);

const early = buildProspectiveStrategyRiskShadowReport(Array.from({ length: 10 }, (_, index) => ({
  ...generatedRows[0], id: `early-${index}`, setupKey: `early-${index}`
})));
assert.equal(early.totals.sampleSufficiency, "EARLY EVIDENCE");
const formal = buildProspectiveStrategyRiskShadowReport(Array.from({ length: 30 }, (_, index) => ({
  ...generatedRows[0], id: `formal-${index}`, setupKey: `formal-${index}`
})));
assert.equal(formal.totals.sampleSufficiency, "ELIGIBLE FOR FORMAL REVIEW");

const repositorySource = await readFile(resolve("src/modules/admin-signals/generatedSignalRepository.js"), "utf8");
assert.match(repositorySource, /full_analysis/);
assert.match(repositorySource, /strategyRiskShadowDiagnostics/);
assert.match(repositorySource, /signal\.resultType === "ready_signal"/);
assert.match(repositorySource, /calculateStrategyRiskShadowDiagnostics/);
const reportSource = await readFile(resolve("scripts/prospective-strategy-risk-shadow-report.js"), "utf8");
assert.match(reportSource, /BEGIN READ ONLY/);
assert.doesNotMatch(reportSource, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|generated_signals|FROM)\b/i);

const productionReferences = await findProductionReferences(resolve("src"), "strategyRiskShadowDiagnostics");
assert.deepEqual(productionReferences.map(normalizePath).sort(), [
  resolve("src/modules/admin-signals/generatedSignalRepository.js")
].map(normalizePath).sort(), "Only the persistence adapter may attach the stored snapshot field");

for (const path of [
  "src/modules/risk/riskEngineService.js",
  "src/modules/signals/signalService.js",
  "src/modules/signals/signalValidationService.js",
  "src/modules/signals/generatedSignalQualityGate.js",
  "src/modules/alerts/autoScanService.js",
  "src/modules/notifications/notificationService.js"
]) {
  const source = await readFile(resolve(path), "utf8");
  assert.doesNotMatch(source, /strategyRiskShadowDiagnostics|shadowSL|shadowTP|shadowPlan/);
}

const momentumSource = await readFile(resolve("src/modules/signals/momentumEntryDiagnostics.js"), "utf8");
assert.match(momentumSource, /momentum_entry_shadow_v1/);
assert.doesNotMatch(momentumSource, /strategy_risk_shadow_v1/);

console.log(JSON.stringify({
  version: STRATEGY_RISK_SHADOW_VERSION,
  formulas: { longStop: longDiagnostics.shadowPlan.stopLoss, shortStop: shortDiagnostics.shadowPlan.stopLoss },
  productionProjectionUnchanged: decisionProjection(longSignal),
  modelB: longDiagnostics.shadowPlan.modelB,
  modelC: longDiagnostics.shadowPlan.modelC,
  momentumStatus: momentum.invalidationStatus,
  mtfStatus: mtf.invalidationStatus,
  stopFirstOutcome: terminal.shadowOriginalTpOutcome,
  prospectiveFiltering: report.totals,
  productionReferences
}, null, 2));

function signalFixture(overrides = {}) {
  const base = {
    symbol: "BTC-USD",
    timeframe: "15m",
    direction: "long",
    setupType: "Breakout retest",
    entryPrice: 100,
    stopLoss: 94,
    takeProfit: 112,
    riskRewardRatio: 2,
    confidenceScore: 92,
    qualityScore: 95,
    readinessScore: 97,
    resultType: "ready_signal",
    validationPassed: true,
    status: "Active",
    generatedAt: "2026-08-28T01:00:00.000Z",
    validUntil: "2026-08-28T01:45:00.000Z",
    riskPlan: { targetMultiple: 2 },
    indicators: { atr14: 2, support: 96, resistance: 110, ema20: 98, ema50: 96, regime: "Breakout" },
    strategyEvidence: {
      strategy: "Breakout retest",
      qualified: true,
      invalidationLevel: 95,
      retestCandle: candle("2026-08-28T01:00:00.000Z", 99, 101, 95.2, 100)
    }
  };
  return {
    ...base,
    ...overrides,
    indicators: { ...base.indicators, ...(overrides.indicators || {}) },
    strategyEvidence: overrides.strategyEvidence || {
      ...base.strategyEvidence,
      invalidationLevel: overrides.invalidationLevel ?? base.strategyEvidence.invalidationLevel
    }
  };
}

function reportRow(id, status, realizedR, diagnostics) {
  return {
    id,
    signal_id: `signal-${id}`,
    setup_key: `setup-${id}`,
    pair: "BTC-USD",
    timeframe: "15m",
    strategy: diagnostics.strategy,
    direction: diagnostics.direction,
    status,
    realized_r: realizedR,
    created_at: diagnostics.generatedAt,
    valid_until: "2026-08-28T01:45:00.000Z",
    full_analysis: { indicators: { strategyRiskShadowDiagnostics: diagnostics } }
  };
}

function candle(time, open, high, low, close) {
  return { time, open, high, low, close, volume: 100 };
}

function decisionProjection(signal) {
  return Object.fromEntries([
    "entryPrice", "stopLoss", "takeProfit", "riskRewardRatio", "confidenceScore",
    "qualityScore", "readinessScore", "resultType", "validationPassed", "status"
  ].map((field) => [field, signal[field]]));
}

async function findProductionReferences(folder, token) {
  const references = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) references.push(...await findProductionReferences(path, token));
    else if (/\.(js|mjs|cjs)$/.test(entry.name) && (await readFile(path, "utf8")).includes(token)) references.push(resolve(path));
  }
  return references;
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}
