import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  evaluateDuplicateSignalMatch,
  getEntryZoneSimilarity,
  isDuplicateBlockingRecord
} from "../src/modules/signals/generatedSignalQualityGate.js";

const now = Date.now();

function candidate(overrides = {}) {
  return {
    id: "sig-new",
    setupKey: "BTC-USD:15m:long:new",
    symbol: "BTC-USD",
    timeframe: "15m",
    direction: "long",
    setupType: "Breakout Retest",
    entryPrice: 100,
    stopLoss: 97,
    takeProfit: 106,
    confidenceScore: 84,
    qualityScore: 90,
    readinessScore: 94,
    riskRewardRatio: 2,
    entryQuality: "good",
    indicators: { atr14: 2, qualityGatePassed: true },
    patternContext: {
      pattern: "bull_flag",
      keyLevels: { breakoutLevel: 99.8, support: 97, resistance: 106 }
    },
    ...overrides
  };
}

function activeRecord(overrides = {}) {
  return {
    id: "agen-old",
    signal_id: "sig-old",
    setup_key: "BTC-USD:15m:long:old",
    pair: "BTCUSD",
    timeframe: "15m",
    direction: "long",
    strategy: "Structure Breakout Retest",
    pattern: "bull_flag",
    pattern_context: {
      pattern: "bull_flag",
      keyLevels: { breakoutLevel: 99.9, support: 97.1, resistance: 105.9 }
    },
    entry: 100.15,
    stop_loss: 97.1,
    take_profit: 105.9,
    confidence: 82,
    calibrated_confidence: 82,
    setup_quality_score: 88,
    entry_readiness_score: 91,
    risk_reward: 1.93,
    status: "Active",
    source: "manual_scan",
    source_history: ["manual_scan"],
    quality_gate_status: "passed",
    telegram_status: null,
    valid_until: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
    created_at: new Date(now - 38 * 60 * 1000).toISOString(),
    full_analysis: { indicators: { atr14: 2, entryQuality: "good" } },
    ...overrides
  };
}

const direct = evaluateDuplicateSignalMatch(candidate(), activeRecord(), { now });
assert.equal(direct.matched, true);
assert.equal(direct.blocked, true, "same active trade idea should be blocked");
assert.equal(direct.matchType, "direct_duplicate");
assert.equal(direct.details.matchedSignalId, "sig-old");
assert.ok(direct.details.entryDistancePercent < 0.35);
assert.equal(direct.details.duplicate_match_method.includes("entry_"), true);

assert.equal(
  evaluateDuplicateSignalMatch(candidate({ entryPrice: 104, stopLoss: 100, takeProfit: 111 }), activeRecord(), { now }).matched,
  false,
  "materially different entry zone must not be blocked"
);
assert.equal(
  evaluateDuplicateSignalMatch(candidate({ setupType: "Liquidity Sweep Reversal" }), activeRecord(), { now }).matched,
  false,
  "different strategy family must not be merged"
);
assert.equal(
  evaluateDuplicateSignalMatch(
    candidate({ patternContext: { pattern: "bull_flag", keyLevels: { breakoutLevel: 102.5 } } }),
    activeRecord({ stop_loss: 96, take_profit: 109 }),
    { now }
  ).matched,
  false,
  "different trigger and trade structure must not be treated as the same setup"
);

for (const row of [
  activeRecord({ status: "Weak strategy match" }),
  activeRecord({ status: "Rejected" }),
  activeRecord({ source: "admin_test" }),
  activeRecord({ source: "auto_crypto_watcher", source_history: [], telegram_status: null }),
  activeRecord({ quality_gate_status: "failed" }),
  activeRecord({ status: "Hit TP" }),
  activeRecord({ status: "Hit SL" }),
  activeRecord({ status: "Expired" }),
  activeRecord({ status: "Manually closed" }),
  activeRecord({ status: "Cancelled" }),
  activeRecord({ valid_until: new Date(now - 1000).toISOString() })
]) {
  assert.equal(isDuplicateBlockingRecord(row, now), false, `${row.status}/${row.source} must not occupy the duplicate slot`);
  assert.equal(evaluateDuplicateSignalMatch(candidate(), row, { now }).matched, false);
}

const crossStrongerExisting = evaluateDuplicateSignalMatch(
  candidate({ timeframe: "15m", confidenceScore: 78, qualityScore: 82, readinessScore: 86 }),
  activeRecord({ timeframe: "1h", confidence: 88, calibrated_confidence: 88, setup_quality_score: 94, entry_readiness_score: 95 }),
  { now }
);
assert.equal(crossStrongerExisting.matchType, "correlated_duplicate");
assert.equal(crossStrongerExisting.blocked, true, "stronger existing correlated setup should win");

const crossStrongerCandidate = evaluateDuplicateSignalMatch(
  candidate({ timeframe: "15m", confidenceScore: 90, qualityScore: 96, readinessScore: 98, riskRewardRatio: 2.5 }),
  activeRecord({ timeframe: "1h", confidence: 68, calibrated_confidence: 68, setup_quality_score: 72, entry_readiness_score: 76, risk_reward: 1.6 }),
  { now }
);
assert.equal(crossStrongerCandidate.selectedCurrent, true, "strongest validated correlated candidate should be selected");
assert.equal(crossStrongerCandidate.details.selectedSignalId, "sig-new");

const alreadyAlerted = evaluateDuplicateSignalMatch(
  candidate({ confidenceScore: 99, qualityScore: 100, readinessScore: 100 }),
  activeRecord({ timeframe: "1h", telegram_status: "sent", confidence: 65, calibrated_confidence: 65 }),
  { now }
);
assert.equal(alreadyAlerted.blocked, true, "an already-alerted overlapping trade idea should remain authoritative");

assert.equal(
  evaluateDuplicateSignalMatch(candidate({ timeframe: "15m" }), activeRecord({ timeframe: "4h" }), { now }).matched,
  false,
  "distant timeframes must not be correlated automatically"
);

const lowPrice = getEntryZoneSimilarity(0.0000100, 0.00001002, 0.00000008);
assert.equal(lowPrice.matched, true, "low-priced assets should use percentage/ATR distance");
assert.ok(lowPrice.distancePercent > 0);
assert.ok(lowPrice.distanceAtr <= 0.5);

const gateSource = readFileSync(new URL("../src/modules/signals/generatedSignalQualityGate.js", import.meta.url), "utf8");
const repositorySource = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/059_signal_duplicate_precision.sql", import.meta.url), "utf8");
const adminClientSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
assert.ok(
  gateSource.indexOf("findRecentGeneratedSignalFailure") < gateSource.indexOf("findRecentGeneratedSignalDuplicate(cooldownAdjustedSignal)"),
  "cooldown must remain a separate earlier rule"
);
assert.match(gateSource, /status IN \('Active', 'Expiring Soon', 'Pending', 'Ready', 'Alerted'\)/);
assert.match(gateSource, /quality_gate_status = 'passed'/);
assert.match(gateSource, /source NOT IN \('legacy_saved_signal','legacy_unlocked_signal','backtest_shadow','admin_test'\)/);
assert.match(gateSource, /duplicate_entry_distance_percent/);
assert.match(gateSource, /duplicate_entry_distance_atr/);
assert.match(gateSource, /duplicate_match_method/);
assert.match(repositorySource, /ON CONFLICT DO NOTHING/);
assert.match(repositorySource, /signal_id/);
assert.match(migration, /UNIQUE INDEX[\s\S]*user_id, chat_id, setup_key, alert_type/i);
assert.match(adminClientSource, /Duplicate decision[\s\S]*Matched signal[\s\S]*Entry difference[\s\S]*Time difference/, "admin details should expose duplicate evidence");

const oldPairNewSignal = {
  first: { userId: "u1", chatId: "chat1", setupKey: "BTC-USD:15m:long:100", alertType: "ready_trade_signal" },
  second: { userId: "u1", chatId: "chat1", setupKey: "BTC-USD:15m:long:101", alertType: "ready_trade_signal" }
};
assert.notEqual(oldPairNewSignal.first.setupKey, oldPairNewSignal.second.setupKey, "a new valid setup on the same pair must have a distinct message key");

for (const field of ["confidenceScore", "stopLoss", "takeProfit", "cooldownStatus"]) {
  const original = candidate({ cooldownStatus: "clear" });
  evaluateDuplicateSignalMatch(original, activeRecord(), { now });
  assert.equal(original[field], candidate({ cooldownStatus: "clear" })[field], `${field} must not be modified by duplicate matching`);
}

console.log("signal duplicate detection tests passed");
