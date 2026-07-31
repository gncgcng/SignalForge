import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  inspectStopLoss,
  repairInvalidStopLoss
} from "../src/modules/signals/signalStopRepairService.js";
import { evaluateSignalQualityGateV2 } from "../src/modules/signals/signalQualityGateV2Service.js";

const nowSeconds = Math.floor(Date.now() / 1000);

function candleSeries(direction = "long", { stale = false, noSwing = false } = {}) {
  const interval = 15 * 60;
  const end = stale ? nowSeconds - interval * 20 : nowSeconds - 30;
  const lows = noSwing ? [95, 96, 97, 98, 98.4, 98.8, 99] : [100, 99.5, 98, 98.8, 99.2, 99.4, 99.1];
  const highs = noSwing ? [101, 101.2, 101.4, 101.6, 101.8, 102, 102.2] : [100.5, 101, 102, 101.2, 100.9, 100.8, 100.7];
  return lows.map((low, index) => ({
    time: end - (lows.length - 1 - index) * interval,
    open: direction === "long" ? 99.5 : 100.5,
    high: highs[index],
    low,
    close: direction === "long" ? 100 : 100,
    volume: 1200
  }));
}

function market(direction = "long", overrides = {}) {
  return {
    volumeAvailable: true,
    marketStatus: { stale: false, code: "LIVE" },
    regime: { label: direction === "long" ? "trending up" : "trending down", metrics: { atr14: 2 } },
    candles: candleSeries(direction),
    levels: direction === "long"
      ? { support: 98, resistance: 112 }
      : { support: 88, resistance: 102 },
    ...overrides
  };
}

function signal(direction = "long", overrides = {}) {
  return {
    id: `sig_stop_${direction}`,
    symbol: "ATOM-USD",
    timeframe: "15m",
    direction,
    setupType: "Breakout Retest",
    entryPrice: 100,
    stopLoss: direction === "long" ? 99.5 : 100.5,
    takeProfit: direction === "long" ? 107 : 93,
    riskRewardRatio: 14,
    confidenceScore: 86,
    qualityScore: 100,
    readinessScore: 100,
    entryQuality: "good",
    alignmentBadge: "Full Alignment",
    marketStructure: direction === "long"
      ? { retestConfirmed: true, retestLow: 98 }
      : { retestConfirmed: true, retestHigh: 102 },
    indicators: {
      atr14: 2,
      volumeConfirmed: true,
      regime: direction === "long" ? "trending up" : "trending down",
      support: direction === "long" ? 98 : 88,
      resistance: direction === "long" ? 112 : 102
    },
    confirmations: [
      { name: "Retest", passed: true, detail: "Broken level retested and held." },
      { name: "Volume", passed: true, detail: "Volume expanded on confirmation." },
      { name: "Structure", passed: true, detail: "Breakout structure is clear." }
    ],
    duplicateBlocked: false,
    cooldownBlocked: false,
    telegramStatus: "not_evaluated",
    ...overrides
  };
}

const originalLong = signal("long", { stopLoss: 101 });
assert.equal(inspectStopLoss(originalLong, market("long")).reasonCode, "stop_wrong_side_of_entry");
const repairedLong = repairInvalidStopLoss(originalLong, market("long"));
assert.ok(repairedLong.stopLoss < repairedLong.entryPrice, "LONG repaired stop must be below entry");
assert.equal(repairedLong.stopRepairSucceeded, true);
assert.equal(repairedLong.stopRepairSource, "retest_structure");
assert.ok(repairedLong.stopLoss <= 97.7, "LONG repair should use retest/support plus the ATR buffer");
assert.equal(repairedLong.stopRepairDiagnostics.original_stop_loss, 101);
assert.equal(repairedLong.stopRepairDiagnostics.stop_repair_succeeded, true);

const originalShort = signal("short", { stopLoss: 99 });
assert.equal(inspectStopLoss(originalShort, market("short")).reasonCode, "stop_wrong_side_of_entry");
const repairedShort = repairInvalidStopLoss(originalShort, market("short"));
assert.ok(repairedShort.stopLoss > repairedShort.entryPrice, "SHORT repaired stop must be above entry");
assert.equal(repairedShort.stopRepairSucceeded, true);
assert.equal(repairedShort.stopRepairSource, "retest_structure");
assert.ok(repairedShort.stopLoss >= 102.3, "SHORT repair should use resistance plus the ATR buffer");

const swingLong = repairInvalidStopLoss(signal("long", {
  setupType: "Trend Continuation",
  marketStructure: { swingLow: 98 },
  indicators: { ...signal("long").indicators, support: null }
}), market("long", { levels: { resistance: 112 } }));
assert.equal(swingLong.stopRepairSource, "recent_swing");
assert.ok(swingLong.stopLoss <= 97.7, "LONG swing-low repair must include the ATR buffer");

const swingShort = repairInvalidStopLoss(signal("short", {
  setupType: "Trend Continuation",
  marketStructure: { swingHigh: 102 },
  indicators: { ...signal("short").indicators, resistance: null }
}), market("short", { levels: { support: 88 } }));
assert.equal(swingShort.stopRepairSource, "recent_swing");
assert.ok(swingShort.stopLoss >= 102.3, "SHORT swing-high repair must include the ATR buffer");

const noStructureMarket = market("long", {
  candles: candleSeries("long", { noSwing: true }),
  levels: {}
});
const insideNoise = evaluateSignalQualityGateV2(signal("long", {
  setupType: "Trend Continuation",
  marketStructure: {},
  indicators: {
    ...signal("long").indicators,
    support: null,
    resistance: null
  }
}), { marketData: noStructureMarket });
assert.equal(insideNoise.passed, false);
assert.equal(insideNoise.status, "invalid_stop_loss");
assert.equal(insideNoise.adjustedSignal.stopRepairDiagnostics.originalFailureReason, "stop_inside_noise");
assert.equal(insideNoise.reasonCode, "no_structural_stop_available");
assert.equal(insideNoise.adjustedSignal.stopRepairAttempted, true, "invalid stop must attempt repair before blocking");

const doubleBottom = repairInvalidStopLoss(signal("long", {
  setupType: "Double Bottom",
  patternContext: { keyLevels: { invalidation: 97 } },
  marketStructure: {},
  indicators: {
    ...signal("long").indicators,
    support: 95
  }
}), market("long", { levels: { support: 95, resistance: 112 } }));
assert.equal(doubleBottom.stopRepairSource, "pattern_invalidation", "strategy-specific invalidation should be preferred");
assert.ok(doubleBottom.stopLoss < 97);

const originalRiskReward = signal("long").riskRewardRatio;
assert.notEqual(repairedLong.riskRewardRatio, originalRiskReward, "R/R must be recomputed after stop repair");
assert.equal(
  repairedLong.riskRewardRatio,
  Number((Math.abs(repairedLong.takeProfit - repairedLong.entryPrice) / Math.abs(repairedLong.entryPrice - repairedLong.stopLoss)).toFixed(2))
);
assert.equal(repairedLong.takeProfit, originalLong.takeProfit, "stop repair must not change take-profit calculation");

const repairedGate = evaluateSignalQualityGateV2(signal("long"), { marketData: market("long") });
assert.equal(repairedGate.passed, true, "valid repaired stop should allow the candidate to continue");
assert.equal(repairedGate.adjustedSignal.stopRepairSucceeded, true);

const brokenRiskReward = evaluateSignalQualityGateV2(signal("long", {
  takeProfit: 102,
  marketStructure: { retestConfirmed: true, retestLow: 96 },
  indicators: {
    ...signal("long").indicators,
    support: 96,
    resistance: 112
  }
}), {
  marketData: market("long", { levels: { support: 96, resistance: 112 } })
});
assert.equal(brokenRiskReward.passed, false);
assert.equal(brokenRiskReward.reasonCode, "repaired_stop_breaks_rr_requirement");
assert.equal(brokenRiskReward.adjustedSignal.stopRepairSucceeded, false);

const noStructure = evaluateSignalQualityGateV2(signal("long", {
  setupType: "Trend Continuation",
  marketStructure: {},
  indicators: { ...signal("long").indicators, support: null, resistance: null }
}), { marketData: noStructureMarket });
assert.equal(noStructure.reasonCode, "no_structural_stop_available");

const staleMarket = market("long", {
  marketStatus: { stale: true, code: "DELAYED" },
  candles: candleSeries("long", { stale: true })
});
const staleRepair = repairInvalidStopLoss(signal("long"), staleMarket);
assert.equal(staleRepair.stopRepairSucceeded, false);
assert.equal(staleRepair.stopRepairDiagnostics.repairFailureReason, "stale_candle_data");
assert.equal(staleRepair.stopLoss, signal("long").stopLoss, "stale data must not create a fake repaired stop");

const missingCandles = repairInvalidStopLoss(signal("short"), {
  ...market("short"),
  candles: []
});
assert.equal(missingCandles.stopRepairSucceeded, false);
assert.equal(missingCandles.stopRepairDiagnostics.repairFailureReason, "missing_candle_data");

for (const field of ["confidenceScore", "duplicateBlocked", "cooldownBlocked", "telegramStatus", "timeframe"]) {
  assert.equal(repairedLong[field], originalLong[field], `${field} must be unchanged by stop repair`);
}

const source = readFileSync("src/modules/signals/signalService.js", "utf8");
const generatedGate = readFileSync("src/modules/signals/generatedSignalQualityGate.js", "utf8");
const qualityGate = readFileSync("src/modules/signals/signalQualityGateV2Service.js", "utf8");
const adminRepository = readFileSync("src/modules/admin-signals/generatedSignalRepository.js", "utf8");
const adminUi = readFileSync("public/app.js", "utf8");
assert.match(source, /qualityGate\.adjustedSignal \|\| cappedSignal/, "promotion must use repaired stop values");
assert.match(source, /repairInvalidStopLoss\(readySignal, marketData/, "repair must run before publication validation");
assert.match(qualityGate, /repairInvalidStopLoss/);
assert.match(generatedGate, /repairUnrealisticTakeProfit\(stopAdjustedSignal/);
assert.match(adminRepository, /stopValidation/);
assert.match(adminUi, /Stop validation/);

console.log("Signal stop repair tests passed.");
