import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appConfig } from "../src/config/appConfig.js";
import {
  TELEGRAM_DECISIONS,
  evaluateGeneratedSignalTelegramDecision,
  evaluateTelegramAlertEligibility,
  getFinalDecision,
  resolveTelegramAlertThreshold
} from "../src/modules/notifications/telegramAlertDiagnosticsService.js";
import {
  buildTelegramUnlockUrl,
  formatTelegramSignalMessage
} from "../src/modules/notifications/notificationService.js";
import {
  FINAL_SIGNAL_DECISIONS,
  determineFinalSignalDecision
} from "../src/modules/signals/signalDecisionService.js";

const originalToken = appConfig.telegram.botToken;
const originalThreshold = appConfig.telegram.readyAlertMinConfidence;
appConfig.telegram.botToken = "test-token";
appConfig.telegram.readyAlertMinConfidence = 65;

const readySignal = {
  id: "sig_ready_90",
  signalId: "sig_ready_90",
  setupKey: "BTC-USD:15m:long:ready-90",
  symbol: "BTC-USD",
  timeframe: "15m",
  direction: "long",
  status: "Active",
  confidenceScore: 90,
  finalCalibratedConfidence: 90,
  readinessScore: 100,
  entryPrice: 100,
  stopLoss: 98,
  takeProfit: 104,
  riskRewardRatio: 2,
  setupType: "Breakout retest",
  validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  indicators: {
    qualityGatePassed: true,
    qualityGateV2: { status: "passed" }
  }
};

const settings90 = {
  enabled: true,
  chatId: "12345",
  favoriteMarketsOnly: false,
  timeframes: ["15m"],
  direction: "both",
  minimumConfidence: 90
};

assert.deepEqual(FINAL_SIGNAL_DECISIONS, [
  "ready_signal",
  "admin_only",
  "blocked",
  "rejected"
]);
assert.equal(determineFinalSignalDecision(readySignal).finalDecision, "ready_signal");
assert.equal(getFinalDecision(readySignal), "ready_signal");

const confidence89 = evaluateTelegramAlertEligibility({
  settings: settings90,
  setup: { ...readySignal, confidenceScore: 89, finalCalibratedConfidence: 89 }
});
assert.equal(confidence89.allowed, false);
assert.equal(confidence89.status, "telegram_blocked_user_preference");
assert.equal(confidence89.details.globalAlertThreshold, 65);
assert.equal(confidence89.details.userAlertThreshold, 90);
assert.equal(confidence89.details.effectiveAlertThreshold, 90);
assert.equal(confidence89.details.preferenceCheckPassed, false);
assert.match(confidence89.reason, /Final confidence 89 is below the user's alert preference of 90/);

const confidence90 = evaluateTelegramAlertEligibility({
  settings: settings90,
  setup: readySignal
});
assert.equal(confidence90.allowed, true);
assert.equal(confidence90.status, "telegram_queued");
assert.equal(confidence90.details.preferenceCheckPassed, true);
assert.equal(resolveTelegramAlertThreshold(settings90).effectiveAlertThreshold, 90);

for (const [finalDecision, expectedStatus] of [
  ["admin_only", "telegram_blocked_admin_only"],
  ["blocked", "telegram_blocked_quality_gate"],
  ["rejected", "telegram_blocked_not_ready"]
]) {
  const result = evaluateTelegramAlertEligibility({
    settings: settings90,
    setup: {
      ...readySignal,
      finalDecision,
      primaryDecisionReason: finalDecision === "blocked"
        ? "failed_quality_gate"
        : `${finalDecision}_test`,
      status: finalDecision === "admin_only"
        ? "Watching"
        : finalDecision === "blocked"
          ? "Poor entry quality"
          : "Strategy Misread Rejected"
    }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, expectedStatus);
}

const contradiction = evaluateTelegramAlertEligibility({
  settings: settings90,
  setup: {
    ...readySignal,
    finalDecision: "ready_signal",
    status: "Duplicate blocked",
    primaryDecisionReason: "all_signal_requirements_passed"
  }
});
assert.equal(contradiction.status, "telegram_blocked_duplicate");

const generatedReady = evaluateGeneratedSignalTelegramDecision(readySignal);
assert.equal(generatedReady.status, "telegram_blocked_missing_connection");
assert.notEqual(generatedReady.status, "telegram_queued");

const message = formatTelegramSignalMessage(readySignal);
assert.match(message, /^SignalForge Trade Signal/);
assert.match(message, /Confidence: 90%/);
assert.doesNotMatch(message, /No alert|Not alertable|Admin-only|Blocked/i);

const deepLink = buildTelegramUnlockUrl(readySignal);
assert.match(deepLink, /#signals\?/);
assert.match(deepLink, /signalId=sig_ready_90/);
assert.match(deepLink, /unlock=BTC-USD%3A15m%3Along%3Aready-90/);

for (const status of TELEGRAM_DECISIONS) {
  assert.match(status, /^telegram_(sent|queued|failed|blocked_)/);
}
assert.ok(!TELEGRAM_DECISIONS.some((status) => /not_checked|not_alertable|unknown/.test(status)));

const migration = readFileSync(
  new URL("../migrations/060_final_signal_and_telegram_decisions.sql", import.meta.url),
  "utf8"
);
const repository = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const queue = readFileSync(
  new URL("../src/modules/notifications/notificationQueue.js", import.meta.url),
  "utf8"
);
const watcher = readFileSync(new URL("../src/modules/alerts/autoScanService.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

assert.match(migration, /final_decision IN \('ready_signal', 'admin_only', 'blocked', 'rejected'\)/);
assert.match(migration, /user_id, signal_id, alert_type/);
assert.match(migration, /telegram_message_id/);
assert.match(migration, /'blocked'/);
assert.match(repository, /preference_snapshot/);
assert.match(repository, /ON CONFLICT DO NOTHING/);
assert.match(repository, /findSuccessfulTelegramDelivery/);
assert.match(queue, /markTelegramNotificationSent\(delivery\.id, telegramResponse\)/);
assert.match(queue, /telegram_blocked_already_sent/);
assert.equal((watcher.match(/enqueueMatchingTelegramNotifications\(/g) || []).length, 1);
assert.doesNotMatch(watcher, /calibrateTelegramAlertSetup|generationSource:\s*"telegram_alert"/);
assert.match(app, /sessionStorage\.setItem\(TELEGRAM_UNLOCK_KEY/);
assert.match(app, /processPendingTelegramUnlock\(\)/);
assert.match(app, /Signal unavailable/);

appConfig.telegram.botToken = originalToken;
appConfig.telegram.readyAlertMinConfidence = originalThreshold;

console.log("final signal and Telegram decision tests passed");
