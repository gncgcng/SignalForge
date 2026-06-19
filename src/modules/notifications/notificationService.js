import { appConfig } from "../../config/appConfig.js";
import {
  enqueueTelegramNotification,
  getTelegramSettingsByUser,
  listWatchlistByUser,
  setTelegramNotificationsEnabled,
  upsertTelegramSettings
} from "../../db/repositories.js";
import { sendTelegramMessage } from "./telegramClient.js";

const directions = new Set(["long", "short", "both"]);
const timeframes = new Set(["5m", "15m", "1h", "4h"]);

export async function getNotificationSettings(user) {
  const settings = await getTelegramSettingsByUser(user.id);
  return {
    configured: Boolean(appConfig.telegram.botToken),
    botUsername: appConfig.telegram.botUsername,
    connected: Boolean(settings),
    settings
  };
}

export async function connectTelegram(user, input) {
  assertTelegramConfigured();
  const settings = {
    ...validateSettings(input),
    enabled: false
  };
  await sendTelegramMessage(
    settings.chatId,
    "SignalForge Telegram notifications connected.\n\nEducational tool only. Not financial advice."
  );
  await upsertTelegramSettings(user.id, settings);
  return getNotificationSettings(user);
}

export async function updateTelegramSettings(user, input) {
  const current = await getTelegramSettingsByUser(user.id);

  if (!current) {
    throw validationError("Connect Telegram before saving notification preferences.");
  }

  await upsertTelegramSettings(user.id, validateSettings({
    ...input,
    chatId: current.chatId
  }));
  return getNotificationSettings(user);
}

export async function toggleTelegramNotifications(user, enabled) {
  const settings = await setTelegramNotificationsEnabled(user.id, Boolean(enabled));

  if (!settings) {
    throw validationError("Connect Telegram before enabling notifications.");
  }

  return getNotificationSettings(user);
}

export async function sendTelegramTestAlert(user) {
  const settings = await getTelegramSettingsByUser(user.id);

  if (!settings) {
    throw validationError("Connect Telegram before sending a test alert.");
  }

  assertTelegramConfigured();
  await sendTelegramMessage(
    settings.chatId,
    [
      "🚨 SignalForge Test Alert",
      "",
      "Telegram notifications are connected correctly.",
      "",
      "Educational tool only. Not financial advice."
    ].join("\n")
  );

  return { message: "Test alert sent successfully." };
}

export async function enqueueMatchingTelegramNotifications(user, setups) {
  const settings = await getTelegramSettingsByUser(user.id);

  if (!settings?.enabled || !appConfig.telegram.botToken) {
    return [];
  }

  const watchlist = await listWatchlistByUser(user.id);
  const favoriteSymbols = new Set(watchlist.map((item) => item.symbol));
  const queued = [];

  for (const setup of setups) {
    if (!telegramPreferenceMatchesSetup(settings, favoriteSymbols, setup)) {
      continue;
    }

    const inserted = await enqueueTelegramNotification(user.id, settings, setup);

    if (inserted) {
      queued.push(inserted.id);
    }
  }

  return queued;
}

export function telegramPreferenceMatchesSetup(settings, favoriteSymbols, setup) {
  return Boolean(
    setup?.setupKey &&
    favoriteSymbols.has(setup.symbol) &&
    settings.timeframes.includes(setup.timeframe) &&
    (settings.direction === "both" || settings.direction === setup.direction) &&
    Number(setup.confidenceScore) >= Number(settings.minimumConfidence)
  );
}

export function formatTelegramSignalMessage(setup) {
  const confirmations = summarizeConfirmations(setup.confirmations || []);
  const reason = confirmations
    .map((item) => `${item.name} ${item.passed ? "✓" : "✗"}`)
    .join("\n");

  return [
    "🚨 SignalForge Alert",
    "",
    `Market: ${setup.symbol}`,
    `Timeframe: ${setup.timeframe}`,
    `Direction: ${setup.direction.toUpperCase()}`,
    `Entry: ${formatPrice(setup.entryPrice)}`,
    `Stop Loss: ${formatPrice(setup.stopLoss)}`,
    `Take Profit: ${formatPrice(setup.takeProfit)}`,
    `Risk/Reward: ${setup.riskRewardRatio}:1`,
    `Confidence: ${setup.confidenceScore}%`,
    "",
    "Reason:",
    reason,
    "",
    "Educational tool only. Not financial advice."
  ].join("\n");
}

function validateSettings(input) {
  const chatId = String(input.chatId || "").trim();
  const selectedTimeframes = Array.isArray(input.timeframes)
    ? [...new Set(input.timeframes.filter((item) => timeframes.has(item)))]
    : [];
  const minimumConfidence = Number(input.minimumConfidence);

  if (!/^-?\d+$/.test(chatId)) {
    throw validationError("Enter a valid Telegram numeric chat ID.");
  }

  if (!selectedTimeframes.length) {
    throw validationError("Select at least one notification timeframe.");
  }

  if (!directions.has(input.direction)) {
    throw validationError("Notification direction must be long, short, or both.");
  }

  if (!Number.isInteger(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 100) {
    throw validationError("Minimum confidence must be between 0 and 100.");
  }

  return {
    chatId,
    enabled: input.enabled !== false,
    timeframes: selectedTimeframes,
    direction: input.direction,
    minimumConfidence
  };
}

function summarizeConfirmations(confirmations) {
  const groups = new Map();

  for (const confirmation of confirmations) {
    const name = normalizeConfirmationName(confirmation.name);
    const existing = groups.get(name);
    groups.set(name, {
      name,
      passed: existing ? existing.passed && Boolean(confirmation.passed) : Boolean(confirmation.passed)
    });
  }

  return [...groups.values()];
}

function normalizeConfirmationName(name = "") {
  const value = name.toLowerCase();
  if (value.includes("support") || value.includes("resistance")) return "Support";
  if (value.includes("ema") || value.includes("trend")) return "Trend";
  if (value.includes("rsi")) return "RSI";
  if (value.includes("atr")) return "ATR";
  if (value.includes("volume")) return "Volume";
  return name;
}

function formatPrice(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: Number(value) > 1000 ? 2 : 4 });
}

function assertTelegramConfigured() {
  if (!appConfig.telegram.botToken) {
    const error = validationError("Telegram notifications are not configured. Set TELEGRAM_BOT_TOKEN.");
    error.statusCode = 503;
    throw error;
  }
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
