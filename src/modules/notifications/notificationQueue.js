import { appConfig } from "../../config/appConfig.js";
import {
  claimNextTelegramNotification,
  markTelegramNotificationFailed,
  markTelegramNotificationSent
} from "../../db/repositories.js";
import {
  formatTelegramSignalMessage,
  formatTelegramSignalReplyMarkup
} from "./notificationService.js";
import { recordTelegramAlertDiagnostic } from "./telegramAlertDiagnosticsService.js";
import { sendTelegramMessage } from "./telegramClient.js";
import { isSignalExpired } from "../signals/signalValidityService.js";

let queueTimer = null;
let processing = false;

export function startTelegramNotificationQueue() {
  if (queueTimer || !appConfig.telegram.botToken) {
    return;
  }

  queueTimer = setInterval(processTelegramQueue, appConfig.telegram.queueIntervalMs);
  processTelegramQueue();
}

export async function processTelegramQueue() {
  if (processing) {
    return;
  }

  processing = true;

  try {
    let delivery;

    while ((delivery = await claimNextTelegramNotification())) {
      try {
        if (isSignalExpired(delivery.payload)) {
          await markTelegramNotificationFailed(delivery.id, "Signal expired before Telegram delivery.", false);
          await recordTelegramAlertDiagnostic({
            signal: delivery.payload,
            userId: delivery.userId,
            status: "blocked_not_alertable",
            reason: "Signal expired before Telegram delivery.",
            details: { queueId: delivery.id }
          });
          console.info(`[telegram] expired alert skipped queue_id=${delivery.id} user=${delivery.userId}`);
          continue;
        }
        console.log(`[telegram] sending alert queue_id=${delivery.id} user=${delivery.userId} chat=${maskChatId(delivery.chatId)}`);
        await sendTelegramMessage(
          delivery.chatId,
          formatTelegramSignalMessage(delivery.payload),
          formatTelegramSignalReplyMarkup(delivery.payload)
        );
        await markTelegramNotificationSent(delivery.id);
        await recordTelegramAlertDiagnostic({
          signal: delivery.payload,
          userId: delivery.userId,
          status: "sent",
          reason: "Telegram alert sent.",
          details: { queueId: delivery.id, attempts: delivery.attempts }
        });
        console.log(`[telegram] sent queue_id=${delivery.id} user=${delivery.userId}`);
      } catch (error) {
        const retry = delivery.attempts < appConfig.telegram.maxAttempts;
        await markTelegramNotificationFailed(delivery.id, error.message, retry);
        await recordTelegramAlertDiagnostic({
          signal: delivery.payload,
          userId: delivery.userId,
          status: "failed",
          reason: error.message,
          details: { queueId: delivery.id, attempts: delivery.attempts, retry }
        });
        console.warn(`[telegram] failed queue_id=${delivery.id} user=${delivery.userId} retry=${retry} error=${error.message}`);

        if (!retry) {
          console.warn(`[telegram] Delivery ${delivery.id} failed permanently: ${error.message}`);
        }
      }
    }
  } catch (error) {
    console.warn(`[telegram] Queue cycle skipped: ${error.message}`);
  } finally {
    processing = false;
  }
}

function maskChatId(chatId = "") {
  const value = String(chatId);
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}
