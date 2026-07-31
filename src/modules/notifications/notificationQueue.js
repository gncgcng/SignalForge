import { appConfig } from "../../config/appConfig.js";
import {
  claimNextTelegramNotification,
  findSuccessfulTelegramDelivery,
  getTelegramSettingsByUser,
  listWatchlistByUser,
  markTelegramNotificationBlocked,
  markTelegramNotificationFailed,
  markTelegramNotificationSent
} from "../../db/repositories.js";
import {
  formatTelegramSignalMessage,
  formatTelegramSignalReplyMarkup
} from "./notificationService.js";
import {
  evaluateTelegramAlertEligibility,
  recordTelegramAlertDiagnostic
} from "./telegramAlertDiagnosticsService.js";
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
      let eligibility = null;
      try {
        const settings = await getTelegramSettingsByUser(delivery.userId);
        const watchlist = settings?.favoriteMarketsOnly
          ? await listWatchlistByUser(delivery.userId)
          : [];
        const favoriteSymbols = new Set(watchlist.map((item) => item.symbol));
        eligibility = evaluateTelegramAlertEligibility({
          settings,
          setup: delivery.payload,
          favoriteSymbols
        });
        if (!eligibility.allowed) {
          await markTelegramNotificationBlocked(delivery.id, eligibility.reason, eligibility.status);
          await recordTelegramAlertDiagnostic({
            signal: delivery.payload,
            userId: delivery.userId,
            status: eligibility.status,
            reason: eligibility.reason,
            details: {
              ...eligibility.details,
              queueId: delivery.id,
              deliveryRevalidated: true
            }
          });
          console.info(`[telegram] blocked before delivery queue_id=${delivery.id} user=${delivery.userId} reason=${eligibility.status}`);
          continue;
        }
        if (isSignalExpired(delivery.payload)) {
          await markTelegramNotificationBlocked(
            delivery.id,
            "Signal expired before Telegram delivery.",
            "telegram_blocked_expired"
          );
          await recordTelegramAlertDiagnostic({
            signal: delivery.payload,
            userId: delivery.userId,
            status: "telegram_blocked_expired",
            reason: "Signal expired before Telegram delivery.",
            details: { queueId: delivery.id }
          });
          console.info(`[telegram] expired alert skipped queue_id=${delivery.id} user=${delivery.userId}`);
          continue;
        }
        const priorSuccessfulDelivery = await findSuccessfulTelegramDelivery(
          delivery.userId,
          delivery.signalId || delivery.payload.signalId || delivery.payload.id,
          delivery.id
        );
        if (priorSuccessfulDelivery) {
          await markTelegramNotificationBlocked(
            delivery.id,
            "This exact signal was already sent successfully to this user.",
            "telegram_blocked_already_sent"
          );
          await recordTelegramAlertDiagnostic({
            signal: delivery.payload,
            userId: delivery.userId,
            status: "telegram_blocked_already_sent",
            reason: "This exact signal was already sent successfully to this user.",
            details: {
              ...eligibility.details,
              queueId: delivery.id,
              existingQueueId: priorSuccessfulDelivery.id,
              existingTelegramMessageId: priorSuccessfulDelivery.telegram_message_id
            }
          });
          continue;
        }
        console.log(`[telegram] sending alert queue_id=${delivery.id} user=${delivery.userId} chat=${maskChatId(delivery.chatId)}`);
        const telegramResponse = await sendTelegramMessage(
          delivery.chatId,
          formatTelegramSignalMessage(delivery.payload),
          formatTelegramSignalReplyMarkup(delivery.payload)
        );
        await markTelegramNotificationSent(delivery.id, telegramResponse);
        await recordTelegramAlertDiagnostic({
          signal: delivery.payload,
          userId: delivery.userId,
          status: "telegram_sent",
          reason: "Telegram alert sent.",
          details: {
            ...eligibility.details,
            queueId: delivery.id,
            attempts: delivery.attempts,
            telegramApiResponse: {
              messageId: telegramResponse?.message_id || null,
              chatId: telegramResponse?.chat?.id || null
            }
          }
        });
        console.log(`[telegram] sent queue_id=${delivery.id} user=${delivery.userId}`);
      } catch (error) {
        const retry = delivery.attempts < appConfig.telegram.maxAttempts;
        await markTelegramNotificationFailed(
          delivery.id,
          error.message,
          retry,
          error.code || "telegram_delivery_failed"
        );
        await recordTelegramAlertDiagnostic({
          signal: delivery.payload,
          userId: delivery.userId,
          status: "telegram_failed",
          reason: error.message,
          details: {
            ...(eligibility?.details || {}),
            queueId: delivery.id,
            attempts: delivery.attempts,
            retry,
            telegramApiResponse: {
              error: error.message
            }
          }
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
