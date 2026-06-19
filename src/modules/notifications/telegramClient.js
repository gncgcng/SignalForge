import { appConfig } from "../../config/appConfig.js";

export async function sendTelegramMessage(chatId, text) {
  if (!appConfig.telegram.botToken) {
    const error = new Error("Telegram notifications are not configured. Set TELEGRAM_BOT_TOKEN.");
    error.code = "TELEGRAM_NOT_CONFIGURED";
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${appConfig.telegram.botToken}/sendMessage`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text
        })
      }
    );
    const body = await response.json();

    if (!response.ok || body.ok === false) {
      throw new Error(body.description || `Telegram returned ${response.status}.`);
    }

    return body.result;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Telegram request timed out.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
