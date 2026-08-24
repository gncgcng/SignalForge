import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  attachMomentumEntryDiagnostics,
  calculateMomentumEntryDiagnostics
} from "../src/modules/signals/momentumEntryDiagnostics.js";
import { buildMomentumProspectiveReport } from "./momentum-breakout-prospective-report.js";

const longCandles = buildCandles("long");
const longContext = {
  setupType: "Momentum breakout",
  candles: longCandles,
  direction: "long",
  entryPrice: 106,
  stopLoss: 102,
  indicators: { atr14: 2, ema20: 104, ema50: 102, volumeMa20: 100 }
};
const longDiagnostics = calculateMomentumEntryDiagnostics(longContext);
const repeatedDiagnostics = calculateMomentumEntryDiagnostics(longContext);

assert.deepEqual(repeatedDiagnostics, longDiagnostics, "Momentum diagnostics must be deterministic");
assert.deepEqual(pick(longDiagnostics, [
  "latestCandleRangeAtr",
  "latestBodyAtr",
  "bodyToRangeRatio",
  "breakoutDistanceAtr",
  "ema20DistanceAtr",
  "ema50DistanceAtr",
  "stopDistanceAtr",
  "stopBeyondBreakoutCandleAtr",
  "closeBeyondLevelAtr",
  "volumeRatio",
  "prior3BarMoveAtr",
  "directionalExpansionCount3"
]), {
  latestCandleRangeAtr: 2,
  latestBodyAtr: 1,
  bodyToRangeRatio: 0.5,
  breakoutDistanceAtr: 0.5,
  ema20DistanceAtr: 1,
  ema50DistanceAtr: 2,
  stopDistanceAtr: 2,
  stopBeyondBreakoutCandleAtr: 0.5,
  closeBeyondLevelAtr: 0.5,
  volumeRatio: 1.5,
  prior3BarMoveAtr: 3,
  directionalExpansionCount3: 1
});
assert.deepEqual(longDiagnostics.marketQuality, {
  windowCandles: 40,
  nearZeroRangeFraction: 0,
  maxRangeToMedianRange: 1,
  maxVolumeToMedianVolume: 1.2,
  medianRecentRange: 10,
  medianRecentVolume: 100
});

const shortDiagnostics = calculateMomentumEntryDiagnostics({
  setupType: "Momentum breakout",
  candles: buildCandles("short"),
  direction: "short",
  entryPrice: 94,
  stopLoss: 98,
  indicators: { atr14: 2, ema20: 96, ema50: 98, volumeMa20: 100 }
});
assert.deepEqual(pick(shortDiagnostics, [
  "breakoutDistanceAtr",
  "ema20DistanceAtr",
  "ema50DistanceAtr",
  "stopDistanceAtr",
  "stopBeyondBreakoutCandleAtr",
  "closeBeyondLevelAtr",
  "prior3BarMoveAtr"
]), {
  breakoutDistanceAtr: 0.5,
  ema20DistanceAtr: 1,
  ema50DistanceAtr: 2,
  stopDistanceAtr: 2,
  stopBeyondBreakoutCandleAtr: 0.5,
  closeBeyondLevelAtr: 0.5,
  prior3BarMoveAtr: 3
});

for (const invalidAtrValue of [0, null, undefined, Number.NaN]) {
  const invalidAtr = calculateMomentumEntryDiagnostics({
    ...longContext,
    indicators: { ...longContext.indicators, atr14: invalidAtrValue }
  });
  for (const field of [
    "latestCandleRangeAtr",
    "latestBodyAtr",
    "breakoutDistanceAtr",
    "ema20DistanceAtr",
    "ema50DistanceAtr",
    "stopDistanceAtr",
    "stopBeyondBreakoutCandleAtr",
    "closeBeyondLevelAtr",
    "prior3BarMoveAtr"
  ]) {
    assert.equal(invalidAtr[field], null, `${field} must be null when ATR is ${String(invalidAtrValue)}`);
  }
  assert.equal(invalidAtr.bodyToRangeRatio, 0.5);
  assert.equal(invalidAtr.volumeRatio, 1.5);
}

const originalIndicators = { atr14: 2, regime: "Breakout" };
assert.equal(
  attachMomentumEntryDiagnostics(originalIndicators, { ...longContext, setupType: "Breakout retest" }),
  originalIndicators,
  "Non-Momentum indicators must remain untouched"
);

const beforeSignal = {
  direction: "long",
  setupType: "Momentum breakout",
  entryPrice: 106,
  stopLoss: 102,
  takeProfit: 114,
  riskRewardRatio: 2,
  confidenceScore: 88,
  readinessScore: 96,
  qualityScore: 91,
  resultType: "ready_signal",
  validationPassed: true,
  status: "Active",
  indicators: originalIndicators
};
const afterSignal = {
  ...beforeSignal,
  indicators: attachMomentumEntryDiagnostics(beforeSignal.indicators, longContext)
};
assert.deepEqual(decisionProjection(afterSignal), decisionProjection(beforeSignal));
assert.deepEqual(afterSignal.indicators.momentumEntryDiagnostics, longDiagnostics);
assert.doesNotMatch(JSON.stringify(longDiagnostics), /outcome|realized|hitTp|hitSl|expired/i);

const report = buildMomentumProspectiveReport([
  reportRow("tp", "Hit TP", 2, longDiagnostics, { pair: "BTC-USD", timeframe: "15m" }),
  reportRow("sl", "Hit SL", -1, {
    ...longDiagnostics,
    latestCandleRangeAtr: 1.6,
    stopBeyondBreakoutCandleAtr: 0.2,
    ema20DistanceAtr: 1.8,
    breakoutDistanceAtr: 0.9,
    prior3BarMoveAtr: 2.2,
    volumeRatio: 2,
    marketQuality: {
      ...longDiagnostics.marketQuality,
      nearZeroRangeFraction: 0.35,
      maxRangeToMedianRange: 8,
      maxVolumeToMedianVolume: 12
    }
  }, { pair: "FIDA-USD", timeframe: "1h" }),
  reportRow("expired", "Expired", 0, longDiagnostics),
  reportRow("active", "Active", null, longDiagnostics),
  reportRow("legacy", "Hit SL", -1, null)
]);

assert.deepEqual(report.totals, {
  observations: 4,
  terminalObservations: 3,
  pendingObservations: 1,
  terminalWithRealizedR: 3,
  terminalMissingRealizedR: 0,
  tp: 1,
  sl: 1,
  expired: 1,
  netR: 1,
  expectancyR: 0.333333,
  legacyMomentumSignalsWithoutDiagnostics: 1
});
assert.equal(report.tpVsSlMedians.latestCandleRangeAtr.tp, 2);
assert.equal(report.tpVsSlMedians.latestCandleRangeAtr.sl, 1.6);
assert.equal(report.bySymbol.some((group) => group.value === "FIDA-USD"), true);
assert.deepEqual(report.byLiquidityTier.map((group) => group.value), ["unavailable"]);
assert.equal(report.marketQualityExamples.highestNearZeroRangeFraction[0].symbol, "FIDA-USD");
assert.equal(report.prospectiveStudy.minimumMet, false);
assert.equal(report.productionThresholdRecommendation, null);
assert.equal(report.safety.activatesThresholds, false);
assert.deepEqual(report.terminalOutcomeWindow, {
  from: "2026-08-23T12:00:00.000Z",
  to: "2026-08-23T12:00:00.000Z"
});

const repositorySource = await readFile(resolve("src/modules/admin-signals/generatedSignalRepository.js"), "utf8");
assert.match(repositorySource, /indicators: signal\.indicators \|\| \{\}/, "Existing full_analysis persistence must retain signal indicators");
const productionReferences = await findProductionReferences(resolve("src"), "momentumEntryDiagnostics");
assert.deepEqual(
  productionReferences.map((file) => file.replaceAll("\\", "/")).sort(),
  [
    resolve("src/modules/signals/momentumEntryDiagnostics.js").replaceAll("\\", "/"),
    resolve("src/modules/signals/signalGenerator.js").replaceAll("\\", "/")
  ].sort(),
  "No production decision service may read Momentum shadow diagnostics"
);

console.log(JSON.stringify({
  deterministic: true,
  longDiagnostics,
  shortDirectionalMirror: pick(shortDiagnostics, [
    "breakoutDistanceAtr",
    "stopBeyondBreakoutCandleAtr",
    "closeBeyondLevelAtr"
  ]),
  invalidAtrUsesNull: true,
  nonMomentumUnchanged: true,
  decisionProjectionUnchanged: decisionProjection(afterSignal),
  persistenceLocation: "generated_signals.full_analysis.indicators.momentumEntryDiagnostics",
  report: report.totals,
  productionReferences
}, null, 2));

function buildCandles(direction) {
  const candles = Array.from({ length: 57 }, (_, index) => ({
    time: 1_700_000_000 + index * 900,
    open: 100,
    high: 105,
    low: 95,
    close: 100,
    volume: 100
  }));
  if (direction === "long") {
    candles.push(
      { time: 1_700_000_000 + 57 * 900, open: 101, high: 103, low: 100, close: 102, volume: 110 },
      { time: 1_700_000_000 + 58 * 900, open: 102, high: 104, low: 101, close: 103, volume: 120 },
      { time: 1_700_000_000 + 59 * 900, open: 104, high: 107, low: 103, close: 106, volume: 150 }
    );
  } else {
    candles.push(
      { time: 1_700_000_000 + 57 * 900, open: 99, high: 100, low: 97, close: 98, volume: 110 },
      { time: 1_700_000_000 + 58 * 900, open: 98, high: 99, low: 96, close: 97, volume: 120 },
      { time: 1_700_000_000 + 59 * 900, open: 96, high: 97, low: 93, close: 94, volume: 150 }
    );
  }
  return candles;
}

function decisionProjection(signal) {
  return pick(signal, [
    "direction",
    "setupType",
    "entryPrice",
    "stopLoss",
    "takeProfit",
    "riskRewardRatio",
    "confidenceScore",
    "readinessScore",
    "qualityScore",
    "resultType",
    "validationPassed",
    "status"
  ]);
}

function reportRow(id, status, realizedR, diagnostics, overrides = {}) {
  return {
    id,
    signal_id: `signal-${id}`,
    setup_key: `setup-${id}`,
    pair: "BTC-USD",
    timeframe: "15m",
    strategy: "Momentum breakout",
    direction: "long",
    status,
    realized_r: realizedR,
    outcome_evaluated_at: status === "Active" ? null : "2026-08-23T12:00:00.000Z",
    created_at: "2026-08-23T10:00:00.000Z",
    full_analysis: { indicators: diagnostics ? { momentumEntryDiagnostics: diagnostics } : {} },
    ...overrides
  };
}

function pick(value, fields) {
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
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
