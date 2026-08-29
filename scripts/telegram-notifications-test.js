process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_BOT_USERNAME = "signalforge_test_bot";

import { readFileSync } from "node:fs";

const {
  evaluateTelegramSignalEligibility,
  formatTelegramSignalReplyMarkup,
  formatTelegramSignalMessage,
  telegramPreferenceMatchesSetup
} = await import("../src/modules/notifications/notificationService.js");
const { sendTelegramMessage } = await import("../src/modules/notifications/telegramClient.js");

const migration = readFileSync(new URL("../migrations/005_telegram_notifications.sql", import.meta.url), "utf8");
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const signalCreditLedger = readFileSync(new URL("../src/modules/credits/signalCreditLedgerRepository.js", import.meta.url), "utf8");
const unlockRepository = repositories.slice(
  repositories.indexOf("export async function saveUnlockedSignal"),
  repositories.indexOf("export async function findActiveDuplicateSignal")
);
const signalController = readFileSync(new URL("../src/modules/signals/signalController.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const autoScan = readFileSync(new URL("../src/modules/alerts/autoScanService.js", import.meta.url), "utf8");
const queue = readFileSync(new URL("../src/modules/notifications/notificationQueue.js", import.meta.url), "utf8");

const settings = {
  enabled: true,
  favoriteMarketsOnly: false,
  timeframes: ["1h", "4h"],
  direction: "both",
  minimumConfidence: 80
};
const watchlistSettings = {
  ...settings,
  favoriteMarketsOnly: true
};
const favorites = new Set(["BTC-USD", "XAU/USD"]);
const setup = {
  id: "sig_test",
  setupKey: "BTC-USD:1h:long:1770000000",
  symbol: "BTC-USD",
  timeframe: "1h",
  direction: "long",
  entryPrice: 68000,
  stopLoss: 67000,
  takeProfit: 70000,
  riskRewardRatio: 2,
  confidenceScore: 86,
  resultType: "ready_signal",
  validationPassed: true,
  status: "Active",
  generatedQualityBlocked: false,
  confidenceCalibration: { blocked: false, technicalError: false },
  validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  setupType: "Pullback bounce",
  confirmations: [
    { name: "Trend", passed: true },
    { name: "RSI", passed: true },
    { name: "ATR", passed: true },
    { name: "Support", passed: true },
    { name: "Volume", passed: true }
  ]
};
const message = formatTelegramSignalMessage(setup);
const replyMarkup = formatTelegramSignalReplyMarkup(setup);
let telegramRequest;

globalThis.fetch = async (url, options) => {
  telegramRequest = {
    url,
    body: JSON.parse(options.body)
  };
  return new Response(JSON.stringify({
    ok: true,
    result: { message_id: 1 }
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

await sendTelegramMessage("123456789", message, replyMarkup);

const result = {
  settingsAndQueuePersisted: migration.includes("telegram_notification_settings") &&
    migration.includes("telegram_notification_queue"),
  duplicateQueueConstraint: migration.includes("UNIQUE (user_id, setup_key)") &&
    repositories.includes("ON CONFLICT DO NOTHING"),
  queueIsUserScoped: /export async function enqueueTelegramNotification\(userId,/.test(repositories) &&
    /INSERT INTO telegram_notification_queue\s*\([\s\S]*?user_id, setup_key/.test(repositories) &&
    /ON CONFLICT DO NOTHING/.test(repositories) &&
    !/ON CONFLICT \(user_id, setup_key\) DO NOTHING/.test(repositories) &&
    repositories.includes("const setupKey = setup.setupKey || setup.id"),
  allCryptoMatchesWithoutFavorite: telegramPreferenceMatchesSetup(settings, new Set(), setup),
  favoriteMarketMatches: telegramPreferenceMatchesSetup(watchlistSettings, favorites, setup),
  nonFavoriteRejected: !telegramPreferenceMatchesSetup(watchlistSettings, new Set(["XAU/USD"]), setup),
  timeframeRejected: !telegramPreferenceMatchesSetup(settings, favorites, { ...setup, timeframe: "15m" }),
  directionRejected: !telegramPreferenceMatchesSetup(
    { ...settings, direction: "short" },
    favorites,
    setup
  ),
  confidenceRejected: !telegramPreferenceMatchesSetup(settings, favorites, {
    ...setup,
    confidenceScore: 79
  }),
  nonReadyRejected: evaluateTelegramSignalEligibility(settings, favorites, {
    ...setup,
    resultType: "watching_setup"
  }).reason === "non_ready_result",
  failedValidationRejected: evaluateTelegramSignalEligibility(settings, favorites, {
    ...setup,
    validationPassed: false
  }).reason === "validation_failed",
  inactiveRejected: evaluateTelegramSignalEligibility(settings, favorites, {
    ...setup,
    status: "Blocked"
  }).reason === "inactive_status",
  expiredStatusRejected: evaluateTelegramSignalEligibility(settings, favorites, {
    ...setup,
    status: "Expired"
  }).reason === "expired",
  qualityGateRejected: evaluateTelegramSignalEligibility(settings, favorites, {
    ...setup,
    indicators: { generatedQualityBlocked: true }
  }).reason === "quality_gate_blocked",
  calibrationErrorRejected: evaluateTelegramSignalEligibility(settings, favorites, {
    ...setup,
    confidenceCalibration: { blocked: false, technicalError: true }
  }).reason === "calibration_error",
  expiredRejected: evaluateTelegramSignalEligibility(settings, favorites, {
    ...setup,
    validUntil: new Date(Date.now() - 60 * 1000).toISOString()
  }).reason === "expired",
  invalidExpirationRejected: evaluateTelegramSignalEligibility(settings, favorites, {
    ...setup,
    validUntil: "not-a-date"
  }).reason === "invalid_expiration",
  messageIsPreviewOnly: ["Market: BTCUSD", "Provider: Coinbase · BTC-USD", "Timeframe: 1h",
    "Direction: LONG", "Confidence: 86% (Strong)", "Setup: Pullback bounce",
    "Preview only. Unlock to view full levels."]
    .every((value) => message.includes(value)),
  messageDoesNotLeakPaidLevels: !["Entry:", "Stop Loss:", "Take Profit:", "Risk/Reward:"]
    .some((value) => message.includes(value)),
  messageContainsReasonAndDisclaimer: message.includes("Preview reason:") &&
    message.includes("Trend") &&
    message.includes("Educational tool only. Not financial advice."),
  telegramReplyMarkupUnlocksExactSetup: replyMarkup.reply_markup.inline_keyboard[0][0].text === "Unlock Signal" &&
    replyMarkup.reply_markup.inline_keyboard[0][0].url.includes("telegramUnlock=BTC-USD%3A1h%3Along%3A1770000000"),
  telegramApiCalledSafely: telegramRequest.url.includes("/bottest-token/sendMessage") &&
    telegramRequest.body.chat_id === "123456789" &&
    telegramRequest.body.text === message &&
    telegramRequest.body.reply_markup.inline_keyboard[0][0].text === "Unlock Signal",
  telegramPipelineLogs:
    autoScan.includes("[auto-scan] matched alert") &&
    queue.includes("[telegram] sending alert") &&
    queue.includes("[telegram] sent") &&
    queue.includes("[telegram] failed"),
  autoScanLogsQueueNotDelivery:
    (autoScan.match(/telegram alert queued/g) || []).length === 2 &&
    !autoScan.includes("telegram alert sent") &&
    queue.includes("[telegram] sent"),
  scanQueuesPrivately: signalController.includes("scanMarketSetupDetailed") &&
    signalController.includes("enqueueMatchingTelegramNotifications") &&
    !signalController.includes("entryPrice: result.fullSetup"),
  telegramUnlockRoutePresent: signalController.includes('/api/signals/telegram-unlock') &&
    signalController.includes("unlockTelegramSignal") &&
    repositories.includes("findTelegramNotificationPayload") &&
    repositories.includes("saveUnlockedSignal"),
  telegramUnlockChargesOneCreditThroughIdempotentSave:
    unlockRepository.indexOf("if (existing.rows[0])") < unlockRepository.indexOf("consumeSignalUnlockCredit") &&
    unlockRepository.includes("SELECT pg_advisory_xact_lock") &&
    unlockRepository.includes("mapped.alreadyUnlocked = true") &&
    signalCreditLedger.includes("unlock_credits_balance = c.unlock_credits_balance - 1") &&
    signalCreditLedger.includes("ON CONFLICT (idempotency_key) DO NOTHING"),
  duplicateTelegramUnlockDoesNotDoubleCharge:
    repositories.includes("WHERE s.user_id = $1 AND s.setup_key = $2 LIMIT 1") &&
    repositories.includes("return mapped;") &&
    signalController.includes("result.alreadyUnlocked") &&
    app.includes("Already unlocked. No additional credit was used."),
  telegramUnlockCreatesSavedSignal:
    repositories.includes("INSERT INTO saved_signals") &&
    repositories.includes("INSERT INTO unlocked_signals") &&
    repositories.includes("INSERT INTO signal_outcomes") &&
    app.includes("navigateTo(\"signals\"") &&
    app.includes("state.unlockedRevealSignalId = unlockedSignal.id") &&
    app.includes("if (key) highlightSignalKey(key)"),
  telegramUnlockFrontendPresent: app.includes("telegramUnlock") &&
    app.includes("/api/signals/telegram-unlock") &&
    app.includes("Sign in to unlock this Telegram signal preview."),
  notificationsPagePresent: html.includes('data-view="notifications"') &&
    html.includes("telegram-connect-form") &&
    html.includes("telegram-preferences-form") &&
    html.includes("All crypto markets") &&
    html.includes("Watchlist only"),
  notificationsCanBeDisabled: app.includes("/api/notifications/telegram/enabled"),
  disablingCancelsPendingQueue: repositories.includes("Notifications disabled by user.") &&
    repositories.includes("WHERE user_id = $1 AND status IN ('queued', 'failed')"),
  creditsRemainUnlockOnly: !signalController.slice(
    signalController.indexOf('pathname === "/api/signals/scan"'),
    signalController.indexOf('pathname === "/api/signals/generate"')
  ).includes("recordSignalUsage")
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}
