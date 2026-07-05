process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_BOT_USERNAME = "signalforge_test_bot";

import { readFileSync } from "node:fs";

const { extractTelegramConnectionCode } = await import(
  "../src/modules/notifications/telegramConnectionService.js"
);

const migration = readFileSync(
  new URL("../migrations/006_telegram_connection_codes.sql", import.meta.url),
  "utf8"
);
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const service = readFileSync(
  new URL("../src/modules/notifications/telegramConnectionService.js", import.meta.url),
  "utf8"
);
const controller = readFileSync(
  new URL("../src/modules/notifications/notificationController.js", import.meta.url),
  "utf8"
);
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const result = {
  connectionCodesPersisted: migration.includes("telegram_connection_codes") &&
    migration.includes("expires_at") &&
    migration.includes("status text"),
  pollerStatePersisted: migration.includes("telegram_bot_state") &&
    migration.includes("last_update_id") &&
    migration.includes("poll_lease_until"),
  startCommandParsed: extractTelegramConnectionCode("/start ABCD2345") === "ABCD2345",
  addressedStartParsed: extractTelegramConnectionCode("/start@signalforge_bot xyz987") === "XYZ987",
  unrelatedMessageIgnored: extractTelegramConnectionCode("hello") === null,
  connectionStartsDisabled: repositories.includes("VALUES ($1,$2,false,false") &&
    service.includes("Return to the app to enable Telegram alerts"),
  uniqueCodeAndBotLink: service.includes("randomBytes") &&
    service.includes("https://t.me/") &&
    service.includes("?start="),
  automaticVerificationRoutes: controller.includes("/connect/start") &&
    controller.includes("/connect/status"),
  automaticStatusPolling: app.includes("startTelegramConnectionStatusPolling") &&
    app.includes("setInterval(checkStatus, 2000)"),
  connectStaysInApp: !app.includes('window.open("about:blank"') &&
    app.includes("telegramOpenBotLink.href = connection.botUrl"),
  botLinkIncludesCode: service.includes("https://t.me/") &&
    service.includes("?start=${encodeURIComponent(code)}"),
  statusMessagesPresent: [
    "Telegram bot not configured",
    "Waiting for Telegram confirmation",
    "Connected successfully",
    "Invalid code",
    "Connection failed"
  ].every((message) => app.includes(message) || service.includes(message)),
  testAlertButtonPresent: html.includes("telegram-test-button") &&
    controller.includes("/telegram/test"),
  copyCommandFallbackPresent: html.includes("telegram-copy-command") &&
    app.includes("copyText(command)") &&
    app.includes("Copy /start CODE"),
  manualIdIsAdvancedOnly: html.includes("Advanced setup") &&
    html.includes("advanced-fallback"),
  mainFlowHasNoChatIdField: html.indexOf("telegram-chat-id") >
    html.indexOf("Advanced setup"),
  pollerUsesRailwayToken: service.includes("getTelegramUpdates") &&
    repositories.includes("acquireTelegramBotPollLease")
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}
