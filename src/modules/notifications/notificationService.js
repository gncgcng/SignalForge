import { appConfig } from "../../config/appConfig.js";
import {
  enqueueTelegramNotification,
  getTelegramSettingsByUser,
  listWatchlistByUser,
  setTelegramNotificationsEnabled,
  upsertTelegramSettings
} from "../../db/repositories.js";
import { sendTelegramMessage } from "./telegramClient.js";
import { formatSignalValidityWindow } from "../signals/signalValidityService.js";
import {
  evaluateTelegramAlertEligibility,
  recordTelegramAlertDiagnostic
} from "./telegramAlertDiagnosticsService.js";
import {
  buildTelegramUnlockUrl,
  formatTelegramTradeLevels,
  validateTelegramTradeSignal
} from "./telegramSignalPolicy.js";

export {
  buildTelegramUnlockUrl,
  formatTelegramTradeLevels,
  validateTelegramTradeSignal
} from "./telegramSignalPolicy.js";

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
      "TEST MESSAGE — not a real signal",
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
    for (const setup of setups || []) {
      const evaluation = evaluateTelegramAlertEligibility({ user, settings, setup });
      await recordTelegramAlertDiagnostic({
        signal: setup,
        userId: user.id,
        status: evaluation.status,
        reason: evaluation.reason,
        details: evaluation.details
      });
    }
    return [];
  }

  const watchlist = settings.favoriteMarketsOnly
    ? await listWatchlistByUser(user.id)
    : [];
  const favoriteSymbols = new Set(watchlist.map((item) => item.symbol));
  const queued = [];

  for (const setup of setups) {
    const evaluation = evaluateTelegramAlertEligibility({ user, settings, setup, favoriteSymbols });
    if (!evaluation.allowed) {
      await recordTelegramAlertDiagnostic({
        signal: setup,
        userId: user.id,
        status: evaluation.status,
        reason: evaluation.reason,
        details: evaluation.details
      });
      continue;
    }

    const inserted = await enqueueTelegramNotification(user.id, settings, setup);

    if (inserted) {
      console.log(`[telegram] queued alert user=${user.id} symbol=${setup.symbol} timeframe=${setup.timeframe} queue_id=${inserted.id}`);
      await recordTelegramAlertDiagnostic({
        signal: setup,
        userId: user.id,
        status: "queued",
        reason: "Telegram alert queued for delivery.",
        details: { queueId: inserted.id, confidence: setup.confidenceScore, threshold: evaluation.details?.threshold }
      });
      queued.push(inserted.id);
    } else {
      console.log(`[telegram] duplicate alert skipped user=${user.id} symbol=${setup.symbol} timeframe=${setup.timeframe}`);
      await recordTelegramAlertDiagnostic({
        signal: setup,
        userId: user.id,
        status: "blocked_duplicate",
        reason: "A Telegram alert for this setup is already queued or sent.",
        details: { ...evaluation.details, setupKey: setup.setupKey }
      });
    }
  }

  return queued;
}

export function telegramPreferenceMatchesSetup(settings, favoriteSymbols, setup) {
  const userThreshold = Number(settings.minimumConfidence || 0);
  const finalThreshold = Math.max(
    Number(appConfig.telegram.readyAlertMinConfidence),
    Number.isFinite(userThreshold) ? userThreshold : 0
  );
  return Boolean(
    (setup?.setupKey || setup?.id) &&
    (!settings.favoriteMarketsOnly || favoriteSymbols.has(setup.symbol)) &&
    settings.timeframes.includes(setup.timeframe) &&
    (settings.direction === "both" || settings.direction === setup.direction) &&
    Number(setup.confidenceScore) >= finalThreshold
  );
}

export function formatTelegramSignalMessage(setup) {
  const validation = validateTelegramTradeSignal(setup);
  if (!validation.valid) {
    throw new Error(`Telegram signal is not sendable: ${validation.reason}`);
  }
  const confirmations = summarizeConfirmations(setup.confirmations || []);
  const passed = confirmations.filter((item) => item.passed).map((item) => item.name);
  const reason = passed.length
    ? `${passed.slice(0, 4).join(", ")} aligned with the rule set.`
    : "Rule-based confluence detected. Open SignalForge to review the full setup.";
  const provider = getProviderLabel(setup.symbol);
  const confidence = Number(setup.confidenceScore || 0);
  const levels = formatTelegramTradeLevels(setup);

  return [
    "🚨 SignalForge Setup Ready",
    "",
    `Market: ${getDisplaySymbol(setup.symbol)}`,
    `Provider: ${provider}`,
    `Timeframe: ${setup.timeframe}`,
    `Direction: ${setup.direction.toUpperCase()}`,
    `Confidence: ${confidence}%`,
    `Setup: ${setup.setupType || "Qualified setup"}`,
    `Valid for: ${formatSignalValidityWindow(setup.timeframe)}`,
    "",
    "Trade levels:",
    `Entry: ${levels.entry}`,
    `Stop loss: ${levels.stopLoss}`,
    `Take profit: ${levels.takeProfit}`,
    `Risk/reward: ${Number(setup.riskRewardRatio || 0).toFixed(2)}R`,
    "",
    "Short reason:",
    reason,
    "",
    "Open SignalForge to save, paper trade, and review the full analysis.",
    "Market conditions may change before the validity window ends.",
    "Educational tool only. Not financial advice."
  ].join("\n");
}

export function formatTelegramSignalReplyMarkup(setup) {
  const url = buildTelegramUnlockUrl(setup);
  if (!url) return {};

  return {
    reply_markup: {
      inline_keyboard: [[
        {
          text: "Unlock Signal",
          url
        }
      ]]
    }
  };
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
    favoriteMarketsOnly: input.scope === "watchlist" || input.favoriteMarketsOnly === true,
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

function getDisplaySymbol(symbol = "") {
  return symbol.includes("-") ? symbol.replace("-", "") : symbol;
}

function getProviderLabel(symbol = "") {
  if (["XAU/USD", "XAG/USD", "WTI", "BRENT", "NATGAS"].includes(symbol)) {
    return `Twelve Data · ${symbol}`;
  }

  return `Coinbase · ${symbol}`;
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
