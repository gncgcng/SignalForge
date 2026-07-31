import assert from "node:assert/strict";
import { appConfig } from "../src/config/appConfig.js";
import {
  evaluateGeneratedSignalTelegramDecision,
  evaluateTelegramAlertEligibility,
  getFinalDecision
} from "../src/modules/notifications/telegramAlertDiagnosticsService.js";

const originalToken = appConfig.telegram.botToken;
const originalThreshold = appConfig.telegram.readyAlertMinConfidence;
appConfig.telegram.botToken = "test-token";
appConfig.telegram.readyAlertMinConfidence = 65;

const settings = {
  enabled: true,
  chatId: "12345",
  favoriteMarketsOnly: false,
  timeframes: ["5m", "15m", "1h", "4h"],
  direction: "both",
  minimumConfidence: 68
};

const readySignal = {
  id: "sig_1",
  setupKey: "BTC-USD:15m:long:test",
  symbol: "BTC-USD",
  timeframe: "15m",
  direction: "long",
  status: "Active",
  confidenceScore: 78,
  readinessScore: 84,
  entryPrice: 100,
  stopLoss: 97,
  takeProfit: 106,
  riskRewardRatio: 2,
  setupType: "Breakout retest",
  source: "manual_scan",
  indicators: {
    qualityGatePassed: true,
    qualityGateV2: { status: "passed" }
  }
};

assert.equal(evaluateTelegramAlertEligibility({ settings, setup: readySignal }).allowed, true);
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, confidenceScore: 62 } }).status, "blocked_low_confidence");
assert.match(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, confidenceScore: 62 } }).reason, /below global threshold 65/);
const preferenceBlocked = evaluateTelegramAlertEligibility({
  settings: { ...settings, minimumConfidence: 90 },
  setup: { ...readySignal, confidenceScore: 68 }
});
assert.equal(preferenceBlocked.status, "telegram_blocked_user_preference");
assert.match(preferenceBlocked.reason, /Confidence 68 below your Telegram preference 90/);
assert.equal(preferenceBlocked.details.globalThreshold, 65);
assert.equal(preferenceBlocked.details.userThreshold, 90);
assert.equal(preferenceBlocked.details.finalThreshold, 90);
assert.equal(evaluateTelegramAlertEligibility({
  settings: { ...settings, minimumConfidence: 90 },
  setup: { ...readySignal, confidenceScore: 92 }
}).allowed, true);
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, timeframe: "1h" } }).allowed, true);
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, timeframe: "4h" } }).allowed, true);
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, timeframe: "5m" } }).status, "blocked_quarantined_timeframe");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, status: "Cooldown blocked" } }).status, "blocked_cooldown");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, status: "Duplicate blocked" } }).status, "blocked_duplicate");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, readinessScore: 0 } }).status, "blocked_not_ready");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, source: "legacy_unlocked_signal" } }).status, "blocked_legacy");
const broadDirectionCalibration = {
  status: "quarantined",
  blockingEvidence: {
    groupType: "direction",
    groupValue: "long",
    hardBlockEligible: true
  },
  groups: [{
    groupType: "direction",
    groupValue: "long",
    status: "diagnostic_only",
    diagnosticOnly: true,
    hardBlockEligible: false
  }]
};
const directionWeakSignal = {
  ...readySignal,
  indicators: {
    ...readySignal.indicators,
    confidenceCalibration: broadDirectionCalibration
  }
};
const directionWeakEligibility = evaluateTelegramAlertEligibility({ settings, setup: directionWeakSignal });
assert.equal(directionWeakEligibility.allowed, true, "broad long/short performance must not block Telegram");
assert.match(directionWeakEligibility.details.directionCalibrationWarning, /underperforming overall/);
assert.notEqual(evaluateGeneratedSignalTelegramDecision(directionWeakSignal).status, "telegram_blocked_historical_underperformance");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, indicators: { qualityGatePassed: false, qualityGateV2: { status: "poor_entry_quality" } } } }).status, "blocked_failed_quality_gate");
assert.match(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, indicators: { qualityGatePassed: false, qualityGateV2: { status: "poor_entry_quality" } } } }).reason, /failed Quality Gate/);
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, indicators: {} } }).status, "blocked_failed_quality_gate");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, stopLoss: 101 } }).status, "telegram_blocked_invalid_trade_levels");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, status: "Watching" } }).status, "blocked_final_decision_watching");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, status: "Historical underperformer" } }).status, "blocked_historical_underperformance");
assert.equal(evaluateGeneratedSignalTelegramDecision({ ...readySignal, status: "Watching" }).status, "telegram_blocked_final_decision_watching");
assert.equal(evaluateGeneratedSignalTelegramDecision({ ...readySignal, status: "Poor entry quality" }).status, "telegram_blocked_failed_quality_gate");
assert.equal(evaluateGeneratedSignalTelegramDecision({ ...readySignal, status: "Expired" }).status, "telegram_blocked_final_decision_admin_only");
assert.notEqual(evaluateGeneratedSignalTelegramDecision({ ...readySignal, status: "Expired" }).status, "telegram_blocked_not_alertable");
assert.equal(evaluateGeneratedSignalTelegramDecision(null).status, "telegram_blocked_no_generated_setup");
assert.notEqual(evaluateGeneratedSignalTelegramDecision(null).status, "telegram_blocked_not_alertable");
assert.ok(["telegram_queued", "telegram_blocked_low_confidence", "telegram_blocked_failed_quality_gate", "telegram_blocked_quarantined_timeframe", "telegram_missing_bot_token"].includes(
  evaluateGeneratedSignalTelegramDecision(readySignal).status
), "ready signal decision should always end in a concrete Telegram state");
assert.equal(getFinalDecision(readySignal), "ready_signal");
assert.equal(getFinalDecision({ ...readySignal, status: "Watching" }), "watching_setup");
assert.equal(getFinalDecision({ ...readySignal, status: "Hit SL" }), "admin_only");
assert.equal(evaluateTelegramAlertEligibility({ settings: { ...settings, enabled: false }, setup: readySignal }).status, "telegram_disabled");
appConfig.telegram.botToken = "";
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: readySignal }).status, "missing_bot_token");

appConfig.telegram.botToken = originalToken;
appConfig.telegram.readyAlertMinConfidence = originalThreshold;

console.log("telegram alert diagnostics tests passed");
