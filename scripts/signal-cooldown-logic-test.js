import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  evaluateSignalTradeCooldown,
  getFailureCooldownMs,
  isTradeCooldownEligibleRecord
} from "../src/modules/signals/generatedSignalQualityGate.js";

const now = Date.now();

function candidate(overrides = {}) {
  return {
    id: "sig-current",
    setupKey: "BTCUSD:15m:short:current",
    symbol: "BTC-USD",
    timeframe: "15m",
    direction: "short",
    setupType: "Breakout Retest",
    entryPrice: 100,
    stopLoss: 102,
    takeProfit: 96,
    confidenceScore: 84,
    indicators: { atr14: 2, regime: "Trend Down" },
    marketStructure: { structureId: "breakdown-100", triggerLevel: 100.2 },
    patternContext: {
      pattern: "bear_flag",
      structureId: "breakdown-100",
      keyLevels: { breakoutLevel: 100.2, support: 96, resistance: 102 }
    },
    ...overrides
  };
}

function stoppedSignal(overrides = {}) {
  return {
    id: "agen-prior",
    signal_id: "sig-prior",
    setup_key: "BTCUSD:15m:short:prior",
    pair: "BTCUSD",
    timeframe: "15m",
    direction: "short",
    strategy: "Structure Breakout Retest",
    pattern: "bear_flag",
    pattern_context: {
      pattern: "bear_flag",
      structureId: "breakdown-100",
      keyLevels: { breakoutLevel: 100.1, support: 96.1, resistance: 102.1 }
    },
    entry: 100.12,
    stop_loss: 102.1,
    take_profit: 96.1,
    status: "Hit SL",
    source: "manual_scan",
    source_history: ["manual_scan"],
    quality_gate_status: "passed",
    telegram_status: null,
    resolved_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    full_analysis: {
      indicators: { atr14: 2, regime: "Trend Down" },
      marketStructure: { structureId: "breakdown-100", triggerLevel: 100.1 },
      patternContext: {
        pattern: "bear_flag",
        structureId: "breakdown-100",
        keyLevels: { breakoutLevel: 100.1 }
      }
    },
    ...overrides
  };
}

assert.equal(isTradeCooldownEligibleRecord(stoppedSignal()), true, "promoted signal hitting SL starts a cooldown");

const blocked = evaluateSignalTradeCooldown(candidate(), stoppedSignal(), {}, { now });
assert.equal(blocked.blocked, true, "same specific trade idea must be blocked during its cooldown");
assert.equal(blocked.details.previousSignalPromoted, true);
assert.equal(blocked.details.previousOutcome, "Hit SL");
assert.equal(blocked.details.structureSimilarity, "same_trade_structure");
assert.ok(blocked.details.remainingDurationMs > 0);

for (const row of [
  stoppedSignal({ status: "Rejected" }),
  stoppedSignal({ source: "auto_crypto_watcher", source_history: [], telegram_status: null }),
  stoppedSignal({ stop_loss: 99 }),
  stoppedSignal({ quality_gate_status: "failed" }),
  stoppedSignal({ source: "admin_test" }),
  stoppedSignal({ source: "telegram_alert", source_history: ["telegram_alert"], telegram_status: "failed" })
]) {
  assert.equal(isTradeCooldownEligibleRecord(row), false, `${row.status}/${row.source} must not start a trade cooldown`);
  assert.equal(evaluateSignalTradeCooldown(candidate(), row, {}, { now }).blocked, false);
}

const opposite = evaluateSignalTradeCooldown(candidate({ direction: "long", stopLoss: 98, takeProfit: 104 }), stoppedSignal(), {}, { now });
assert.equal(opposite.blocked, false, "opposite direction must not be broadly blocked");
assert.equal(opposite.releasedEarly, true);
assert.equal(opposite.reason, "direction_changed");

const differentStrategy = evaluateSignalTradeCooldown(
  candidate({ setupType: "Liquidity Sweep Reversal" }),
  stoppedSignal(),
  {},
  { now }
);
assert.equal(differentStrategy.blocked, false, "a different strategy family must not inherit the old cooldown");
assert.equal(differentStrategy.reason, "strategy_family_changed");

const newStructure = evaluateSignalTradeCooldown(
  candidate({
    setupKey: "BTCUSD:15m:short:new-structure",
    marketStructure: { structureId: "breakdown-94", triggerLevel: 94 },
    patternContext: {
      pattern: "bear_flag",
      structureId: "breakdown-94",
      keyLevels: { breakoutLevel: 94 }
    },
    entryPrice: 94,
    stopLoss: 96,
    takeProfit: 90
  }),
  stoppedSignal(),
  {},
  { now }
);
assert.equal(newStructure.blocked, false, "a confirmed materially new structure can release cooldown early");
assert.equal(newStructure.reason, "new_confirmed_structure");
assert.equal(newStructure.details.cooldown_released_early, true);

const expiredWithoutEntry = stoppedSignal({
  status: "Expired",
  result_reason: "expired_without_entry",
  resolved_at: new Date(now - 60 * 60 * 1000).toISOString()
});
assert.equal(isTradeCooldownEligibleRecord(expiredWithoutEntry), false, "expired without entry must not start cooldown");

const invalidatedBeforeEntry = stoppedSignal({
  status: "Expired",
  result_reason: "invalidated_before_entry"
});
assert.equal(isTradeCooldownEligibleRecord(invalidatedBeforeEntry), false, "invalidated before entry must not start cooldown");

const expiredAfterEntry = stoppedSignal({
  status: "Expired",
  result_reason: "expired_after_entry",
  resolved_at: new Date(now - 2 * 60 * 60 * 1000).toISOString()
});
assert.equal(isTradeCooldownEligibleRecord(expiredAfterEntry), true);
assert.equal(
  evaluateSignalTradeCooldown(candidate(), expiredAfterEntry, {}, { now }).blocked,
  true,
  "expired after entry may use the shorter cooldown"
);

assert.equal(isTradeCooldownEligibleRecord(stoppedSignal({ status: "Hit TP" })), false, "Hit TP must not trigger loss cooldown");
assert.equal(evaluateSignalTradeCooldown(candidate(), stoppedSignal({ status: "Hit TP" }), {}, { now }).blocked, false);

assert.equal(getFailureCooldownMs("5m", "Hit SL"), 4 * 60 * 60 * 1000);
assert.equal(getFailureCooldownMs("15m", "Hit SL"), 6 * 60 * 60 * 1000);
assert.equal(getFailureCooldownMs("1h", "Hit SL"), 12 * 60 * 60 * 1000);
assert.equal(getFailureCooldownMs("4h", "Hit SL"), 24 * 60 * 60 * 1000);
assert.equal(getFailureCooldownMs("15m", "Expired"), 3 * 60 * 60 * 1000);

assert.equal(
  evaluateSignalTradeCooldown(candidate(), stoppedSignal({ pair: null, direction: "short", strategy: null }), {}, { now }).blocked,
  false,
  "broad direction-only records must not block signals"
);

const before = candidate({ cooldownMarker: "unchanged" });
const snapshot = structuredClone(before);
evaluateSignalTradeCooldown(before, stoppedSignal(), {}, { now });
assert.deepEqual(before, snapshot, "cooldown evaluation must not mutate confidence, stop, TP, or any signal field");

const gateSource = readFileSync(new URL("../src/modules/signals/generatedSignalQualityGate.js", import.meta.url), "utf8");
const telegramSource = readFileSync(new URL("../src/modules/alerts/autoScanService.js", import.meta.url), "utf8");
const adminSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
assert.match(gateSource, /status IN \('Hit SL', 'Expired', 'Manually closed'\)/);
assert.match(gateSource, /isTradeCooldownEligibleRecord/);
assert.match(gateSource, /expired-after-entry/);
assert.match(gateSource, /same_pair_timeframe_direction_strategy_family_and_materially_similar_structure/);
assert.ok(
  gateSource.indexOf("evaluateSignalQualityGateV2") < gateSource.indexOf("findRecentGeneratedSignalFailure(adjustedSignal"),
  "the current setup must pass its existing Quality Gate before cooldown can classify it"
);
assert.match(telegramSource, /hasRecentDetectedAlert\(user\.id, telegramSetup, appConfig\.autoScan\.duplicateCooldownMs\)/);
assert.doesNotMatch(gateSource, /duplicateCooldownMs.*findRecentGeneratedSignalFailure/s);
assert.match(adminSource, /Cooldown details[\s\S]*Prior signal[\s\S]*Cooldown expires[\s\S]*Early release allowed/);

console.log("signal cooldown logic tests passed");
