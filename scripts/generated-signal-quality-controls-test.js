import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyGeneratedSignalQualityBlock,
  applyTimeframeConfidencePolicy,
  getFailureCooldownMs,
  getTimeframeQualityPolicy,
  isNearbyTimeframe,
  isSimilarEntryPrice,
  isSimilarStrategyOrPattern
} from "../src/modules/signals/generatedSignalQualityGate.js";

const signalService = readFileSync("src/modules/signals/signalService.js", "utf8");
const gateService = readFileSync("src/modules/signals/generatedSignalQualityGate.js", "utf8");
const calibrationService = readFileSync("src/modules/signals/signalConfidenceCalibrationService.js", "utf8");
const generatedRepository = readFileSync("src/modules/admin-signals/generatedSignalRepository.js", "utf8");
const generatedService = readFileSync("src/modules/admin-signals/generatedSignalService.js", "utf8");
const generatedController = readFileSync("src/modules/admin-signals/generatedSignalController.js", "utf8");
const app = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");
const migration = readFileSync("migrations/052_generated_signal_quality_controls.sql", "utf8");

assert.equal(getTimeframeQualityPolicy("1h").status, "quarantined", "1h should be quarantined for ready promotion");
assert.equal(getTimeframeQualityPolicy("5m").status, "quarantined", "5m should be quarantined for ready promotion");
assert.equal(getTimeframeQualityPolicy("15m").confidenceCap, 88, "15m confidence should be capped below 90");
assert.equal(getFailureCooldownMs("5m", "Hit SL"), 4 * 60 * 60 * 1000, "5m SL cooldown should be 4 hours");
assert.equal(getFailureCooldownMs("15m", "Hit SL"), 6 * 60 * 60 * 1000, "15m SL cooldown should be 6 hours");
assert.equal(getFailureCooldownMs("1h", "Hit SL"), 24 * 60 * 60 * 1000, "1h SL cooldown should be 24 hours");
assert.equal(getFailureCooldownMs("4h", "Hit SL"), 48 * 60 * 60 * 1000, "4h SL cooldown should be 48 hours");
assert.equal(getFailureCooldownMs("15m", "Expired"), 3 * 60 * 60 * 1000, "Expired cooldown should be half the SL cooldown");
assert.equal(isNearbyTimeframe("15m", "1h"), true, "nearby timeframes should be correlated");
assert.equal(isNearbyTimeframe("5m", "4h"), false, "distant timeframes should not be correlated");
assert.equal(isSimilarEntryPrice(100, 100.2), true, "similar entries should be treated as duplicates");
assert.equal(isSimilarEntryPrice(100, 101), false, "distant entries should not be treated as duplicates");
assert.equal(isSimilarStrategyOrPattern({ setupType: "Breakout Retest" }, { strategy: "Breakout Retest" }), true);
assert.equal(isSimilarStrategyOrPattern({ patternContext: { pattern: "bull_flag" } }, { pattern: "bull_flag" }), true);

const capped = applyTimeframeConfidencePolicy({ timeframe: "1h", confidenceScore: 94, indicators: {} });
assert.equal(capped.confidenceScore, 72, "quarantined timeframe confidence should be capped to 72");

const blocked = applyGeneratedSignalQualityBlock({
  symbol: "BTC-USD",
  timeframe: "15m",
  direction: "long",
  setupType: "Breakout Retest",
  confidenceScore: 88,
  indicators: {}
}, {
  passed: false,
  status: "Cooldown blocked",
  stage: "generated_quality_cooldown",
  reason: "Blocked by cooldown because the last similar signal hit SL."
});
assert.equal(blocked.status, "Cooldown blocked");
assert.equal(blocked.validationPassed, true, "blocked generated records remain admin diagnostics, not validation failures");
assert.match(blocked.resultReason, /last similar signal hit SL/);

assert.match(gateService, /findRecentGeneratedSignalDuplicate/);
assert.match(gateService, /findRecentGeneratedSignalFailure/);
assert.match(gateService, /status IN \('Hit SL', 'Expired'\)/);
assert.match(gateService, /source NOT IN \('legacy_saved_signal','legacy_unlocked_signal'\)/);
assert.match(gateService, /Readiness score is 0/);
assert.match(gateService, /Correlated duplicate/);

assert.match(signalService, /evaluateGeneratedSignalQualityGate/);
assert.match(signalService, /qualityBlocked/);
assert.match(signalService, /publishable \? signal : null/);
assert.match(signalService, /saveGeneratedSignal\(blockedSignal/);
assert.match(signalService, /valid: publishable/);

assert.match(calibrationService, /statsScopeSql\("current"\)/);
assert.match(calibrationService, /source NOT IN \('legacy_saved_signal','legacy_unlocked_signal'\)/);
assert.match(calibrationService, /15m confidence is capped below 90/);
assert.match(calibrationService, /timeframe === "5m" \|\| timeframe === "1h"/);
assert.match(calibrationService, /generated signals are quarantined and capped at 72/);

assert.match(generatedRepository, /Duplicate blocked/);
assert.match(generatedRepository, /Cooldown blocked/);
assert.match(generatedRepository, /Correlated duplicate/);
assert.match(generatedRepository, /Quarantined timeframe/);
assert.match(generatedRepository, /Readiness failed/);
assert.match(generatedRepository, /Invalid legacy ready signal/);
assert.match(generatedRepository, /result_reason = COALESCE\(EXCLUDED\.result_reason, generated_signals\.result_reason\)/);

assert.match(generatedService, /performanceScope \|\| "current"/);
assert.match(generatedController, /performanceScope/);
assert.match(html, /Current engine only/);
assert.match(html, /Legacy only/);
assert.match(html, /Duplicate blocked/);
assert.match(html, /Cooldown blocked/);
assert.match(html, /Correlated duplicate/);
assert.match(html, /Quarantined timeframe/);
assert.match(html, /Readiness failed/);
assert.match(app, /Duplicate blocked/);
assert.match(app, /Admin Signal Quality defaults to current-engine records/);

assert.match(migration, /idx_generated_signals_recent_active_quality/);
assert.match(migration, /idx_generated_signals_recent_failure_quality/);
assert.match(migration, /idx_generated_signals_source_strategy_timeframe_quality/);
assert.match(migration, /Invalid legacy ready signal/);
assert.match(signalService, /const quantity = result\.publicResult\.valid \? 1 : 0/);
assert.match(signalService, /fullSetup: publishable \? signal : null/);

console.log("Generated signal duplicate, cooldown, timeframe quarantine, legacy separation, and blocked diagnostic tests passed.");
