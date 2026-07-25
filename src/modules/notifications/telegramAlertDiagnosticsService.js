import { appConfig } from "../../config/appConfig.js";
import { query } from "../../db/client.js";
import {
  getTelegramAlertDiagnosticsSummary,
  listGeneratedSignals,
  recordGeneratedSignalTelegramDiagnostic
} from "../admin-signals/generatedSignalRepository.js";
import { getTimeframeQualityPolicy } from "../signals/generatedSignalQualityGate.js";
import { sendTelegramMessage } from "./telegramClient.js";

const alertableStatuses = new Set(["Active", "Expiring Soon"]);
const blockedStatuses = new Map([
  ["Duplicate blocked", "blocked_duplicate"],
  ["Cooldown blocked", "blocked_cooldown"],
  ["Correlated duplicate", "blocked_duplicate"],
  ["Quarantined timeframe", "blocked_quarantined_timeframe"],
  ["Readiness failed", "blocked_not_ready"],
  ["Invalid legacy ready signal", "blocked_legacy"],
  ["Strategy Misread Rejected", "blocked_not_alertable"],
  ["Weak Pattern Match", "blocked_not_alertable"]
]);

export function evaluateTelegramAlertEligibility({ user = null, settings = null, setup = null, favoriteSymbols = new Set() } = {}) {
  const threshold = Math.max(
    Number(appConfig.telegram.readyAlertMinConfidence || 75),
    Number(settings?.minimumConfidence || 0)
  );
  if (!setup) return block("blocked_not_alertable", "No generated setup was available for Telegram.");
  if (!appConfig.telegram.botToken) return block("missing_bot_token", "Telegram bot token is not configured.");
  if (!settings?.enabled) return block("telegram_disabled", "Telegram alerts are disabled for this user.");
  if (!settings?.chatId) return block("missing_chat_id", "Telegram chat ID is missing.");
  if (settings.favoriteMarketsOnly && !favoriteSymbols.has(setup.symbol)) {
    return block("blocked_not_alertable", "User alert scope is Watchlist only and this market is not on the watchlist.");
  }
  if (settings.timeframes?.length && !settings.timeframes.includes(setup.timeframe)) {
    return block("blocked_not_alertable", "Signal timeframe is not enabled in Telegram preferences.");
  }
  if (settings.direction && settings.direction !== "both" && settings.direction !== setup.direction) {
    return block("blocked_not_alertable", "Signal direction does not match Telegram preferences.");
  }
  const blockedStatus = blockedStatuses.get(setup.status);
  if (blockedStatus) return block(blockedStatus, `Generated signal status is ${setup.status}.`);
  if (!alertableStatuses.has(setup.status || "Active")) {
    return block("blocked_not_alertable", `Generated signal status is ${setup.status || "unknown"}.`);
  }
  if (["legacy_saved_signal", "legacy_unlocked_signal"].includes(setup.source || setup.generationSource)) {
    return block("blocked_legacy", "Legacy signals are excluded from Telegram ready alerts.");
  }
  if (getTimeframeQualityPolicy(setup.timeframe).status === "quarantined") {
    return block("blocked_quarantined_timeframe", `${setup.timeframe} is quarantined for ready alerts.`);
  }
  const readiness = Number(setup.readinessScore ?? setup.entryReadinessScore ?? setup.indicators?.readinessScore ?? 0);
  if (!Number.isFinite(readiness) || readiness <= 0) {
    return block("blocked_not_ready", "Readiness score is 0.");
  }
  const confidence = Number(setup.confidenceScore ?? setup.confidence ?? 0);
  if (!Number.isFinite(confidence) || confidence < threshold) {
    return block("blocked_low_confidence", `Calibrated confidence ${Number.isFinite(confidence) ? Math.round(confidence) : 0} was below threshold ${threshold}.`, { confidence, threshold });
  }
  const calibrationStatus = setup.indicators?.confidenceCalibration?.status || setup.confidenceCalibration?.status;
  if (["quarantined", "disabled_by_admin"].includes(calibrationStatus)) {
    return block("blocked_quarantined_timeframe", `Calibration status is ${calibrationStatus}.`);
  }

  return {
    allowed: true,
    status: "queued",
    reason: "Ready alert passed Telegram eligibility checks.",
    details: {
      threshold,
      confidence,
      userId: user?.id || null,
      timeframe: setup.timeframe,
      direction: setup.direction
    }
  };
}

export async function recordTelegramAlertDiagnostic(input) {
  try {
    await recordGeneratedSignalTelegramDiagnostic(input);
  } catch (error) {
    console.warn(`[telegram] diagnostic_write_failed reason=${error.message}`);
  }
}

export async function getTelegramAlertHealth() {
  const [summary, queue, failures] = await Promise.all([
    getTelegramAlertDiagnosticsSummary(),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('queued','sending'))::integer AS queue_size,
        COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed_sends,
        AVG(EXTRACT(EPOCH FROM (sent_at - created_at))) FILTER (WHERE sent_at IS NOT NULL) AS average_delivery_seconds,
        COALESCE(SUM(attempts), 0)::integer AS retry_count
      FROM telegram_notification_queue
      WHERE created_at >= now() - interval '7 days'
    `),
    query(`
      SELECT id, user_id, setup_key, status, attempts, last_error, updated_at
      FROM telegram_notification_queue
      WHERE status = 'failed' OR last_error IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 8
    `)
  ]);
  return {
    enabled: Boolean(appConfig.telegram.botToken),
    botTokenConfigured: Boolean(appConfig.telegram.botToken),
    chatIdConfigured: "per_user",
    lastAlertSentAt: summary.last_sent_at || null,
    lastAlertAttemptAt: summary.last_attempt_at || null,
    lastAlertFailure: summary.latestFailure || null,
    queueSize: Number(queue.rows[0]?.queue_size || 0),
    alertsBlockedToday: Number(summary.blocked_today || 0),
    alertsSentToday: Number(summary.sent_or_queued_today || 0),
    minimumConfidenceThreshold: Number(appConfig.telegram.readyAlertMinConfidence || 75),
    watchingAlertsEnabled: appConfig.telegram.watchingAlertsEnabled,
    watchingAlertMinConfidence: Number(appConfig.telegram.watchingAlertMinConfidence || 65),
    alertableSignalCount: Number(summary.alertable_signal_count || 0),
    nonAlertedGeneratedSignalCount: Number(summary.non_alerted_generated_signal_count || 0),
    failedSends: Number(queue.rows[0]?.failed_sends || 0),
    averageDeliverySeconds: queue.rows[0]?.average_delivery_seconds == null ? null : Number(queue.rows[0].average_delivery_seconds),
    retryCount: Number(queue.rows[0]?.retry_count || 0),
    latestFailures: failures.rows
  };
}

export async function simulateTelegramAlertLogic(limit = 40) {
  const { signals } = await listGeneratedSignals({ limit, sort: "newest", performanceScope: "current" });
  return {
    threshold: Number(appConfig.telegram.readyAlertMinConfidence || 75),
    results: signals.map((setup) => {
      const evaluation = evaluateTelegramAlertEligibility({
        settings: {
          enabled: true,
          chatId: "diagnostic",
          favoriteMarketsOnly: false,
          timeframes: ["5m", "15m", "1h", "4h"],
          direction: "both",
          minimumConfidence: appConfig.telegram.readyAlertMinConfidence
        },
        setup
      });
      return {
        signalId: setup.signalId,
        pair: setup.displayPair || setup.pair,
        timeframe: setup.timeframe,
        direction: setup.direction,
        confidence: setup.confidence,
        threshold: appConfig.telegram.readyAlertMinConfidence,
        wouldSend: evaluation.allowed,
        status: evaluation.allowed ? "would_send" : evaluation.status,
        reason: evaluation.reason
      };
    })
  };
}

export async function sendTelegramAdminTestMessage(chatId) {
  if (!appConfig.telegram.botToken) {
    return { ok: false, status: "missing_bot_token", message: "Telegram bot token is not configured." };
  }
  const targetChatId = String(chatId || "").trim();
  if (!targetChatId) {
    return { ok: false, status: "missing_chat_id", message: "Provide a Telegram chat ID for the admin test message." };
  }
  await sendTelegramMessage(targetChatId, "SignalForge Telegram alerts are connected.");
  return { ok: true, status: "sent", message: "Telegram test message sent." };
}

function block(status, reason, details = {}) {
  return { allowed: false, status, reason, details };
}
