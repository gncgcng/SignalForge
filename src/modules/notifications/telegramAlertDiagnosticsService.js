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
  ["Duplicate blocked", { status: "blocked_duplicate", reason: "duplicate" }],
  ["Cooldown blocked", { status: "blocked_cooldown", reason: "cooldown" }],
  ["Correlated duplicate", { status: "blocked_duplicate", reason: "correlated duplicate" }],
  ["Quarantined timeframe", { status: "blocked_quarantined_timeframe", reason: "timeframe quarantined" }],
  ["Readiness failed", { status: "blocked_not_ready", reason: "readiness failed" }],
  ["Invalid legacy ready signal", { status: "blocked_legacy", reason: "legacy signal" }],
  ["Watching", { status: "blocked_final_decision_watching", reason: "final decision is watching" }],
  ["Strategy Misread Rejected", { status: "blocked_failed_quality_gate", reason: "strategy misread rejected" }],
  ["Weak Pattern Match", { status: "blocked_failed_quality_gate", reason: "weak pattern match" }],
  ["Weak strategy match", { status: "blocked_failed_quality_gate", reason: "weak strategy match" }],
  ["Poor entry quality", { status: "blocked_failed_quality_gate", reason: "poor entry quality" }],
  ["Invalid stop loss", { status: "blocked_failed_quality_gate", reason: "invalid stop loss" }],
  ["Unrealistic take profit", { status: "blocked_failed_quality_gate", reason: "unrealistic take profit" }],
  ["Weak risk/reward", { status: "blocked_failed_quality_gate", reason: "weak risk/reward" }],
  ["Bad market regime", { status: "blocked_failed_quality_gate", reason: "bad market regime" }],
  ["Historical underperformer", { status: "blocked_historical_underperformance", reason: "historical underperformance with enough evidence" }],
  ["Similar to past losers", { status: "blocked_failed_quality_gate", reason: "similar to past losers" }]
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
    return block("blocked_direction_preference", "Signal direction does not match Telegram preferences.");
  }
  const finalDecision = getFinalDecision(setup);
  const blockedStatus = getBlockedStatusDecision(setup);
  if (blockedStatus) return block(blockedStatus.status, `Telegram blocked: ${blockedStatus.reason}.`, { finalDecision, status: setup.status });
  if (!alertableStatuses.has(setup.status || "Active")) {
    return block(finalDecision === "admin_only" ? "blocked_final_decision_admin_only" : "blocked_not_alertable", `Telegram blocked: final decision is ${finalDecisionLabel(finalDecision)}.`, { finalDecision, status: setup.status || null });
  }
  if (["legacy_saved_signal", "legacy_unlocked_signal"].includes(setup.source || setup.generationSource)) {
    return block("blocked_legacy", "Legacy signals are excluded from Telegram ready alerts.");
  }
  if (getTimeframeQualityPolicy(setup.timeframe).status === "quarantined") {
    return block("blocked_quarantined_timeframe", `${setup.timeframe} is quarantined for ready alerts.`);
  }
  const qualityGatePassed = setup.indicators?.qualityGatePassed ?? setup.fullAnalysis?.indicators?.qualityGatePassed ?? setup.qualityGatePassed;
  const qualityGateStatus = setup.indicators?.qualityGateV2?.status || setup.fullAnalysis?.indicators?.qualityGateV2?.status || setup.qualityGateStatus;
  if (qualityGatePassed !== true || (qualityGateStatus && qualityGateStatus !== "passed")) {
    return block("blocked_failed_quality_gate", `Signal Quality Gate blocked Telegram alert: failed Quality Gate (${qualityGateStatus || "failed"}).`, {
      qualityGateStatus,
      qualityGateReason: setup.indicators?.qualityGateV2?.reasonCode || setup.qualityGateReason || null
    });
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

export function evaluateGeneratedSignalTelegramDecision(setup = {}) {
  const threshold = Number(appConfig.telegram.readyAlertMinConfidence || 75);
  if (!setup) return telegramBlock("telegram_blocked_not_alertable", "No generated setup was available for Telegram.");

  const finalDecision = getFinalDecision(setup);
  const blockedStatus = getBlockedStatusDecision(setup);
  if (blockedStatus) {
    return telegramBlock(prefixTelegramStatus(blockedStatus.status), `Telegram blocked: ${blockedStatus.reason}.`, {
      status: setup.status,
      finalDecision,
      qualityGateStatus: setup.indicators?.qualityGateV2?.status || setup.generatedQualityGate?.status || setup.qualityGateStatus || null,
      qualityGateReason: setup.indicators?.qualityGateV2?.reasonCode || setup.generatedQualityGate?.reasonCode || setup.qualityGateReason || null
    });
  }

  if (!alertableStatuses.has(setup.status || "Active")) {
    if (finalDecision === "watching_setup" && appConfig.telegram.watchingAlertsEnabled) {
      const watchingConfidence = Number(setup.confidenceScore ?? setup.confidence ?? 0);
      const watchingThreshold = Number(appConfig.telegram.watchingAlertMinConfidence || 65);
      if (Number.isFinite(watchingConfidence) && watchingConfidence >= watchingThreshold) {
        return {
          allowed: true,
          status: "telegram_watching_eligible",
          reason: "Watching setup, not a trade signal. Eligible only because TELEGRAM_WATCHING_ALERTS_ENABLED=true.",
          details: { finalDecision, threshold: watchingThreshold, confidence: watchingConfidence }
        };
      }
      return telegramBlock("telegram_blocked_low_confidence", `Telegram blocked: watching confidence ${Number.isFinite(watchingConfidence) ? Math.round(watchingConfidence) : 0} was below watching threshold ${watchingThreshold}.`, {
        finalDecision,
        confidence: watchingConfidence,
        threshold: watchingThreshold
      });
    }
    return telegramBlock(finalDecision === "admin_only" ? "telegram_blocked_final_decision_admin_only" : "telegram_blocked_not_alertable", `Telegram blocked: final decision is ${finalDecisionLabel(finalDecision)}.`, {
      status: setup.status || null,
      finalDecision
    });
  }

  if (["legacy_saved_signal", "legacy_unlocked_signal"].includes(setup.source || setup.generationSource)) {
    return telegramBlock("telegram_blocked_legacy", "Legacy signals are excluded from Telegram ready alerts.");
  }

  if (getTimeframeQualityPolicy(setup.timeframe).status === "quarantined") {
    return telegramBlock("telegram_blocked_quarantined_timeframe", `${setup.timeframe} is quarantined for ready alerts.`, {
      timeframe: setup.timeframe
    });
  }

  const qualityGatePassed = setup.indicators?.qualityGatePassed ?? setup.fullAnalysis?.indicators?.qualityGatePassed ?? setup.qualityGatePassed;
  const qualityGateStatus = setup.indicators?.qualityGateV2?.status || setup.fullAnalysis?.indicators?.qualityGateV2?.status || setup.qualityGateStatus;
  if (qualityGatePassed !== true || (qualityGateStatus && qualityGateStatus !== "passed")) {
    return telegramBlock("telegram_blocked_failed_quality_gate", `Signal Quality Gate blocked Telegram alert: failed Quality Gate (${qualityGateStatus || "failed"}).`, {
      qualityGateStatus,
      qualityGateReason: setup.indicators?.qualityGateV2?.reasonCode || setup.qualityGateReason || null
    });
  }

  const readiness = Number(setup.readinessScore ?? setup.entryReadinessScore ?? setup.indicators?.readinessScore ?? 0);
  if (!Number.isFinite(readiness) || readiness <= 0) {
    return telegramBlock("telegram_blocked_not_ready", "Readiness score is 0.", { readiness });
  }

  const confidence = Number(setup.confidenceScore ?? setup.confidence ?? 0);
  if (!Number.isFinite(confidence) || confidence < threshold) {
    return telegramBlock("telegram_blocked_low_confidence", `Calibrated confidence ${Number.isFinite(confidence) ? Math.round(confidence) : 0} was below threshold ${threshold}.`, {
      confidence,
      threshold
    });
  }

  if (!appConfig.telegram.botToken) {
    return telegramBlock("telegram_missing_bot_token", "Telegram bot token is not configured.");
  }

  return {
    allowed: true,
    status: "telegram_queued",
    reason: "Generated signal passed Telegram decision checks and is eligible to queue for matching users.",
    details: {
      threshold,
      confidence,
      finalDecision: "ready_signal",
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
  const [summary, queue, failures, scarcity] = await Promise.all([
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
    `),
    query(`
      SELECT status, COUNT(*)::integer AS count
      FROM telegram_alert_diagnostics
      WHERE created_at >= now() - interval '48 hours'
      GROUP BY status
      ORDER BY count DESC
      LIMIT 8
    `)
  ]);
  const lastSentTime = summary.last_sent_at ? new Date(summary.last_sent_at).getTime() : 0;
  const noReadyAlerts48h = !lastSentTime || Date.now() - lastSentTime > 48 * 60 * 60 * 1000;
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
    watchingAlertsSentToday: Number(summary.watching_sent_today || 0),
    noReadyAlerts48h,
    alertScarcityWarning: noReadyAlerts48h ? {
      active: true,
      message: "No ready alerts sent in the last 48 hours.",
      candidatesGenerated: Number(summary.candidates_generated_48h || 0),
      blockedByReason: scarcity.rows.map((row) => ({ status: row.status, count: Number(row.count || 0) }))
    } : { active: false },
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

function telegramBlock(status, reason, details = {}) {
  return { allowed: false, status, reason, details };
}

function getBlockedStatusDecision(setup = {}) {
  const status = setup.status || "";
  return blockedStatuses.get(status) || null;
}

export function getFinalDecision(setup = {}) {
  const status = setup.status || "Active";
  if (["Active", "Expiring Soon"].includes(status)) return "ready_signal";
  if (status === "Watching") return "watching_setup";
  if (["Hit TP", "Hit SL", "Expired", "Manually closed"].includes(status)) return "admin_only";
  if (["Strategy Misread Rejected", "Weak Pattern Match"].includes(status) || /rejected/i.test(status)) return "rejected";
  if (blockedStatuses.has(status)) return "blocked";
  if (["legacy_saved_signal", "legacy_unlocked_signal", "backtest_shadow", "admin_test"].includes(setup.source || setup.generationSource)) return "admin_only";
  return "admin_only";
}

function finalDecisionLabel(decision) {
  return {
    ready_signal: "ready signal",
    watching_setup: "watching",
    admin_only: "admin-only",
    blocked: "blocked",
    rejected: "rejected"
  }[decision] || "not alertable";
}

function prefixTelegramStatus(status) {
  const mapping = {
    blocked_low_confidence: "telegram_blocked_low_confidence",
    blocked_quarantined_timeframe: "telegram_blocked_quarantined_timeframe",
    blocked_not_alertable: "telegram_blocked_not_alertable",
    blocked_failed_quality_gate: "telegram_blocked_failed_quality_gate",
    blocked_historical_underperformance: "telegram_blocked_historical_underperformance",
    blocked_final_decision_watching: "telegram_blocked_final_decision_watching",
    blocked_final_decision_admin_only: "telegram_blocked_final_decision_admin_only",
    blocked_direction_preference: "telegram_blocked_direction_preference",
    blocked_duplicate: "telegram_blocked_duplicate",
    blocked_cooldown: "telegram_blocked_cooldown",
    blocked_legacy: "telegram_blocked_legacy",
    blocked_not_ready: "telegram_blocked_not_ready",
    queued: "telegram_queued",
    sent: "telegram_sent",
    failed: "telegram_failed",
    telegram_disabled: "telegram_disabled",
    missing_chat_id: "telegram_missing_chat_id",
    missing_bot_token: "telegram_missing_bot_token"
  };
  return mapping[status] || (String(status || "").startsWith("telegram_") ? status : `telegram_${status || "blocked_not_alertable"}`);
}
