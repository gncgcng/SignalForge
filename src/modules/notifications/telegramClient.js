import { appConfig } from "../../config/appConfig.js";

export async function sendTelegramMessage(chatId, text, options = {}) {
  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    ...options
  });
}

export async function getTelegramBotIdentity() {
  return telegramRequest("getMe");
}

export async function getTelegramUpdates(offset) {
  return telegramRequest("getUpdates", {
    offset,
    limit: 100,
    timeout: 0,
    allowed_updates: ["message"]
  });
}

async function telegramRequest(method, payload = undefined) {
  if (!appConfig.telegram.botToken) {
    const error = new Error("Telegram notifications are not configured. Set TELEGRAM_BOT_TOKEN.");
    error.code = "TELEGRAM_NOT_CONFIGURED";
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${appConfig.telegram.botToken}/${method}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {})
      }
    );
    const responseBody = await response.json();

    if (!response.ok || responseBody.ok === false) {
      throw new Error(responseBody.description || `Telegram returned ${response.status}.`);
    }

    return responseBody.result;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Telegram request timed out.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
