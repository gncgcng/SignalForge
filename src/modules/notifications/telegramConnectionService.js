import { randomBytes, randomUUID } from "node:crypto";
import { appConfig } from "../../config/appConfig.js";
import {
  confirmTelegramConnectionCode,
  createTelegramConnectionCode,
  acquireTelegramBotPollLease,
  getTelegramBotOffset,
  getTelegramConnectionCodeByUser,
  releaseTelegramBotPollLease,
  saveTelegramBotOffset
} from "../../db/repositories.js";
import {
  getTelegramBotIdentity,
  getTelegramUpdates,
  sendTelegramMessage
} from "./telegramClient.js";

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let pollTimer = null;
let polling = false;
const pollLeaseOwner = `telegram-poller-${randomUUID()}`;

export async function startTelegramConnection(user) {
  assertTelegramConfigured();
  const botUsername = await resolveBotUsername();
  const code = createConnectionCode();
  const expiresAt = new Date(
    Date.now() + appConfig.telegram.connectionCodeTtlMinutes * 60 * 1000
  );

  await createTelegramConnectionCode(user.id, code, expiresAt);

  return {
    status: "waiting",
    message: "Waiting for Telegram confirmation",
    code,
    expiresAt: expiresAt.toISOString(),
    botUrl: `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`
  };
}

export async function getTelegramConnectionStatus(user) {
  const connection = await getTelegramConnectionCodeByUser(user.id);

  if (!connection) {
    return {
      status: "idle",
      message: "Telegram is not connected."
    };
  }

  if (connection.status === "pending" && new Date(connection.expires_at).getTime() <= Date.now()) {
    return {
      status: "expired",
      message: "Connection code expired. Generate a new code."
    };
  }

  const statuses = {
    pending: ["waiting", "Waiting for Telegram confirmation"],
    connected: ["connected", "Connected successfully"],
    invalid: ["invalid", "Invalid code"],
    expired: ["expired", "Connection code expired. Generate a new code."]
  };
  const [status, message] = statuses[connection.status] || ["failed", "Connection failed"];

  const response = {
    status,
    message,
    code: status === "waiting" ? connection.code : undefined,
    expiresAt: connection.expires_at
  };

  if (status === "waiting") {
    try {
      const botUsername = await resolveBotUsername();
      response.botUrl = `https://t.me/${botUsername}?start=${encodeURIComponent(connection.code)}`;
    } catch {
      // The waiting status remains useful even if Telegram identity lookup is temporarily unavailable.
    }
  }

  return response;
}

export function startTelegramConnectionPoller() {
  if (pollTimer || !appConfig.telegram.botToken) {
    return;
  }

  pollTimer = setInterval(
    pollTelegramConnections,
    appConfig.telegram.updatePollIntervalMs
  );
  pollTelegramConnections();
}

export async function pollTelegramConnections() {
  if (polling) {
    return;
  }

  polling = true;
  let leaseAcquired = false;

  try {
    leaseAcquired = await acquireTelegramBotPollLease(pollLeaseOwner);

    if (!leaseAcquired) {
      return;
    }

    const offset = await getTelegramBotOffset();
    const updates = await getTelegramUpdates(offset + 1);

    for (const update of updates) {
      await processTelegramUpdate(update);
      await saveTelegramBotOffset(update.update_id);
    }
  } catch (error) {
    console.warn(`[telegram] Connection poll skipped: ${error.message}`);
  } finally {
    if (leaseAcquired) {
      await releaseTelegramBotPollLease(pollLeaseOwner).catch(() => {});
    }
    polling = false;
  }
}

export async function processTelegramUpdate(update) {
  const text = update.message?.text?.trim() || "";
  const chatId = update.message?.chat?.id;
  const code = extractTelegramConnectionCode(text);

  if (code === null || !chatId) {
    return false;
  }

  if (!code) {
    await sendTelegramMessage(
      String(chatId),
      "Open SignalForge Notifications and generate a connection code first."
    );
    return true;
  }

  const result = await confirmTelegramConnectionCode(code, String(chatId));

  if (result.status === "connected") {
    await sendTelegramMessage(
      String(chatId),
      "SignalForge connected successfully. Return to the app to enable Telegram alerts.\n\nEducational tool only. Not financial advice."
    );
    return true;
  }

  await sendTelegramMessage(
    String(chatId),
    result.status === "expired"
      ? "This SignalForge connection code expired. Generate a new code in the app."
      : "Invalid SignalForge connection code. Generate a new code in the app and try again."
  );
  return true;
}

export function extractTelegramConnectionCode(text) {
  const match = String(text || "").trim().match(/^\/start(?:@\w+)?(?:\s+([A-Z0-9]+))?$/i);
  return match ? (match[1] || "").toUpperCase() : null;
}

async function resolveBotUsername() {
  if (appConfig.telegram.botUsername) {
    return appConfig.telegram.botUsername.replace(/^@/, "");
  }

  const bot = await getTelegramBotIdentity();

  if (!bot?.username) {
    const error = new Error("Connection failed: Telegram bot username is unavailable.");
    error.statusCode = 502;
    throw error;
  }

  return bot.username;
}

function createConnectionCode() {
  const bytes = randomBytes(8);
  return [...bytes]
    .map((value) => codeAlphabet[value % codeAlphabet.length])
    .join("");
}

function assertTelegramConfigured() {
  if (!appConfig.telegram.botToken) {
    const error = new Error("Telegram bot not configured");
    error.statusCode = 503;
    throw error;
  }
}
