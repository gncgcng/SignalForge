import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getTakeProfitAtrLimit,
  inspectTakeProfit,
  repairUnrealisticTakeProfit
} from "../src/modules/signals/signalTakeProfitRepairService.js";
import { evaluateSignalQualityGateV2 } from "../src/modules/signals/signalQualityGateV2Service.js";

function candles({ close = 100, count = 12 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const drift = (index - count + 1) * 0.04;
    const value = close + drift;
    return {
      time: Date.now() - (count - index) * 60_000,
      open: value - 0.1,
      high: value + 0.8,
      low: value - 0.8,
      close: value,
      volume: 1200 + index * 10
    };
  });
}

function market(overrides = {}) {
  return {
    volumeAvailable: true,
    currentPrice: 100.2,
    marketStatus: { stale: false },
    candles: candles(),
    regime: { label: "trending up", metrics: { atr14: 2 } },
    levels: { support: 92, resistance: 108 },
    ...overrides
  };
}

function signal(overrides = {}) {
  return {
    id: "tp-repair-signal",
    symbol: "LTC-USD",
    timeframe: "15m",
    direction: "long",
    setupType: "Breakout Retest",
    entryPrice: 100,
    stopLoss: 97,
    takeProfit: 130,
    riskRewardRatio: 10,
    confidenceScore: 84,
    qualityScore: 91,
    readinessScore: 94,
    entryQuality: "good",
    alignmentBadge: "Full Alignment",
    duplicateStatus: "clear",
    cooldownStatus: "clear",
    telegramStatus: "not_evaluated",
    marketStructure: { retestConfirmed: true, stopStructural: true },
    indicators: {
      atr14: 2,
      volumeConfirmed: true,
      regime: "trending up",
      support: 92,
      resistance: 108,
      qualityGatePassed: true
    },
    confirmations: [
      { name: "Retest", passed: true, detail: "Broken level retested and held." },
      { name: "Volume", passed: true, detail: "Volume expanded on confirmation." },
      { name: "Structure", passed: true, detail: "Breakout structure is clear." }
    ],
    ...overrides
  };
}

assert.equal(inspectTakeProfit(signal({ takeProfit: 99 }), market()).reasonCode, "target_wrong_side_of_entry", "LONG target must be above entry");
assert.equal(
  inspectTakeProfit(signal({ direction: "short", stopLoss: 103, takeProfit: 101 }), market({ levels: { support: 92, resistance: 108 } })).reasonCode,
  "target_wrong_side_of_entry",
  "SHORT target must be below entry"
);

const repairedLong = repairUnrealisticTakeProfit(signal(), market());
assert.equal(repairedLong.takeProfitRepairAttempted, true, "unrealistic target should attempt repair");
assert.equal(repairedLong.takeProfitRepairSucceeded, true);
assert.equal(repairedLong.takeProfitRepairSource, "nearest_resistance");
assert.ok(repairedLong.takeProfit < 108 && repairedLong.takeProfit > 100, "LONG repair should sit before nearest resistance");
assert.equal(repairedLong.riskRewardRatio, Number(((repairedLong.takeProfit - 100) / 3).toFixed(2)), "R/R must be recomputed after repair");

const repairedShort = repairUnrealisticTakeProfit(signal({
  direction: "short",
  stopLoss: 103,
  takeProfit: 70,
  riskRewardRatio: 10,
  indicators: {
    ...signal().indicators,
    support: 92,
    resistance: 108,
    regime: "trending down"
  }
}), market({
  currentPrice: 99.8,
  regime: { label: "trending down", metrics: { atr14: 2 } },
  levels: { support: 92, resistance: 108 }
}));
assert.equal(repairedShort.takeProfitRepairSource, "nearest_support");
assert.ok(repairedShort.takeProfit > 92 && repairedShort.takeProfit < 100, "SHORT repair should sit before nearest support");

const strategyTarget = repairUnrealisticTakeProfit(signal({
  timeframe: "4h",
  setupType: "Double Bottom",
  takeProfit: 140,
  patternContext: {
    pattern: "double_bottom",
    keyLevels: { support: 96, neckline: 105 }
  },
  indicators: {
    ...signal().indicators,
    resistance: null,
    patternContext: {
      pattern: "double_bottom",
      keyLevels: { support: 96, neckline: 105 }
    }
  }
}), market({ levels: {} }));
assert.equal(strategyTarget.takeProfitRepairSource, "pattern_measured_move", "strategy target should be preferred when realistic");
assert.equal(strategyTarget.takeProfit, 114);

assert.ok(getTakeProfitAtrLimit("5m") < getTakeProfitAtrLimit("15m"));
assert.ok(getTakeProfitAtrLimit("15m") < getTakeProfitAtrLimit("1h"));
assert.ok(getTakeProfitAtrLimit("1h") < getTakeProfitAtrLimit("4h"), "timeframe volatility limits should increase conservatively");

const finalStopRepair = repairUnrealisticTakeProfit(signal({
  stopLoss: 96,
  takeProfit: 130,
  riskRewardRatio: 7.5,
  stopRepairSucceeded: true
}), market());
assert.equal(
  finalStopRepair.riskRewardRatio,
  Number(((finalStopRepair.takeProfit - 100) / 4).toFixed(2)),
  "target repair must calculate R/R from the final repaired stop"
);

assert.equal(
  evaluateSignalQualityGateV2(repairedLong, { marketData: market() }).passed,
  true,
  "a realistic repaired target should continue through Quality Gate"
);

const insufficientRoom = repairUnrealisticTakeProfit(signal({
  stopLoss: 95,
  takeProfit: 130,
  riskRewardRatio: 6,
  indicators: { ...signal().indicators, resistance: 106 }
}), market({ levels: { support: 92, resistance: 106 } }));
assert.equal(insufficientRoom.takeProfit, 130, "failed repair must not silently replace the original target");
assert.equal(insufficientRoom.takeProfitRepairSucceeded, false);
assert.equal(insufficientRoom.targetValidationReason, "repaired_take_profit_breaks_rr_requirement");
assert.equal(
  evaluateSignalQualityGateV2(insufficientRoom, { marketData: market({ levels: { support: 92, resistance: 106 } }) }).reasonCode,
  "repaired_take_profit_breaks_rr_requirement"
);

const nearTarget = repairUnrealisticTakeProfit(signal({ takeProfit: 110 }), market({ currentPrice: 109 }));
assert.equal(nearTarget.takeProfit, 110);
assert.equal(nearTarget.targetValidationReason, "price_already_near_target", "price already near target must remain blocked");

const stale = repairUnrealisticTakeProfit(signal(), market({ marketStatus: { stale: true } }));
assert.equal(stale.takeProfit, 130);
assert.equal(stale.targetValidationReason, "stale_candle_data", "stale data must not create a fake target");
const missing = repairUnrealisticTakeProfit(signal(), market({ candles: [], marketStatus: {} }));
assert.equal(missing.takeProfit, 130);
assert.equal(missing.targetValidationReason, "missing_candle_data", "missing candle data must not create a fake target");

for (const field of ["confidenceScore", "duplicateStatus", "cooldownStatus", "telegramStatus"]) {
  assert.equal(repairedLong[field], signal()[field], `${field} must remain unchanged by target repair`);
}

const generatedGateSource = readFileSync(new URL("../src/modules/signals/generatedSignalQualityGate.js", import.meta.url), "utf8");
assert.match(generatedGateSource, /stopFailed[\s\S]*repairUnrealisticTakeProfit\(stopAdjustedSignal/, "stop validation/repair must remain before target repair");
assert.doesNotMatch(generatedGateSource, /TELEGRAM_READY_ALERT_MIN_CONFIDENCE|duplicate.*=.*false|cooldown.*=.*false/i, "target repair must not alter unrelated promotion controls");
const adminRepositorySource = readFileSync(new URL("../src/modules/admin-signals/generatedSignalRepository.js", import.meta.url), "utf8");
const adminClientSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
assert.match(adminRepositorySource, /takeProfitValidation:\s*signal\.takeProfitRepairDiagnostics/, "admin signal storage should retain target diagnostics");
assert.match(adminClientSource, /Take-profit validation[\s\S]*Original target[\s\S]*Repaired R\/R/, "admin details should explain target validation and repair");

console.log("signal take-profit repair tests passed");
