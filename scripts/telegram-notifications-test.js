process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_BOT_USERNAME = "signalforge_test_bot";

import { readFileSync } from "node:fs";

const {
  formatTelegramSignalMessage,
  telegramPreferenceMatchesSetup
} = await import("../src/modules/notifications/notificationService.js");
const { sendTelegramMessage } = await import("../src/modules/notifications/telegramClient.js");

const migration = readFileSync(new URL("../migrations/005_telegram_notifications.sql", import.meta.url), "utf8");
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const signalController = readFileSync(new URL("../src/modules/signals/signalController.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const autoScan = readFileSync(new URL("../src/modules/alerts/autoScanService.js", import.meta.url), "utf8");
const queue = readFileSync(new URL("../src/modules/notifications/notificationQueue.js", import.meta.url), "utf8");

const settings = {
  enabled: true,
  timeframes: ["1h", "4h"],
  direction: "both",
  minimumConfidence: 80
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
  confirmations: [
    { name: "Trend", passed: true },
    { name: "RSI", passed: true },
    { name: "ATR", passed: true },
    { name: "Support", passed: true },
    { name: "Volume", passed: true }
  ]
};
const message = formatTelegramSignalMessage(setup);
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

await sendTelegramMessage("123456789", message);

const result = {
  settingsAndQueuePersisted: migration.includes("telegram_notification_settings") &&
    migration.includes("telegram_notification_queue"),
  duplicateQueueConstraint: migration.includes("UNIQUE (user_id, setup_key)") &&
    repositories.includes("ON CONFLICT (user_id, setup_key) DO NOTHING"),
  queueIsUserScoped: repositories.includes("user_id text NOT NULL") === false &&
    repositories.includes("const setupKey = setup.setupKey || setup.id") &&
    repositories.includes("userId,\n    setupKey"),
  favoriteMarketMatches: telegramPreferenceMatchesSetup(settings, favorites, setup),
  nonFavoriteRejected: !telegramPreferenceMatchesSetup(settings, new Set(["XAU/USD"]), setup),
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
  messageContainsTradeLevels: ["Market: BTC-USD", "Timeframe: 1h", "Direction: LONG",
    "Entry:", "Stop Loss:", "Take Profit:", "Risk/Reward:", "Confidence:"]
    .every((value) => message.includes(value)),
  messageContainsReasonAndDisclaimer: message.includes("Reason:") &&
    message.includes("Trend ✓") &&
    message.includes("Educational tool only. Not financial advice."),
  telegramApiCalledSafely: telegramRequest.url.includes("/bottest-token/sendMessage") &&
    telegramRequest.body.chat_id === "123456789" &&
    telegramRequest.body.text === message,
  telegramPipelineLogs:
    autoScan.includes("[auto-scan] matched alert") &&
    queue.includes("[telegram] sending alert") &&
    queue.includes("[telegram] sent") &&
    queue.includes("[telegram] failed"),
  scanQueuesPrivately: signalController.includes("scanMarketSetupDetailed") &&
    signalController.includes("enqueueMatchingTelegramNotifications") &&
    !signalController.includes("entryPrice: result.fullSetup"),
  notificationsPagePresent: html.includes('data-view="notifications"') &&
    html.includes("telegram-connect-form") &&
    html.includes("telegram-preferences-form") &&
    html.includes("Favorite markets"),
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
