import assert from "node:assert/strict";
import { appConfig } from "../src/config/appConfig.js";
import { evaluateTelegramAlertEligibility } from "../src/modules/notifications/telegramAlertDiagnosticsService.js";

const originalToken = appConfig.telegram.botToken;
const originalThreshold = appConfig.telegram.readyAlertMinConfidence;
appConfig.telegram.botToken = "test-token";
appConfig.telegram.readyAlertMinConfidence = 75;

const settings = {
  enabled: true,
  chatId: "12345",
  favoriteMarketsOnly: false,
  timeframes: ["5m", "15m", "1h", "4h"],
  direction: "both",
  minimumConfidence: 75
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
  setupType: "Breakout retest",
  source: "manual_scan",
  indicators: {
    qualityGatePassed: true,
    qualityGateV2: { status: "passed" }
  }
};

assert.equal(evaluateTelegramAlertEligibility({ settings, setup: readySignal }).allowed, true);
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, confidenceScore: 62 } }).status, "blocked_low_confidence");
assert.match(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, confidenceScore: 62 } }).reason, /below threshold 75/);
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, timeframe: "1h" } }).status, "blocked_quarantined_timeframe");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, status: "Cooldown blocked" } }).status, "blocked_cooldown");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, status: "Duplicate blocked" } }).status, "blocked_duplicate");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, readinessScore: 0 } }).status, "blocked_not_ready");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, source: "legacy_unlocked_signal" } }).status, "blocked_legacy");
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, indicators: { qualityGatePassed: false, qualityGateV2: { status: "poor_entry_quality" } } } }).status, "blocked_not_alertable");
assert.match(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, indicators: { qualityGatePassed: false, qualityGateV2: { status: "poor_entry_quality" } } } }).reason, /Signal Quality Gate blocked/);
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: { ...readySignal, indicators: {} } }).status, "blocked_not_alertable");
assert.equal(evaluateTelegramAlertEligibility({ settings: { ...settings, enabled: false }, setup: readySignal }).status, "telegram_disabled");
appConfig.telegram.botToken = "";
assert.equal(evaluateTelegramAlertEligibility({ settings, setup: readySignal }).status, "missing_bot_token");

appConfig.telegram.botToken = originalToken;
appConfig.telegram.readyAlertMinConfidence = originalThreshold;

console.log("telegram alert diagnostics tests passed");
