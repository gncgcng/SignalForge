import { appConfig } from "../../config/appConfig.js";
import { query } from "../../db/client.js";
import {
  getTelegramAlertDiagnosticsSummary,
  listGeneratedSignals,
  recordGeneratedSignalTelegramDiagnostic
} from "../admin-signals/generatedSignalRepository.js";
import {
  determineFinalSignalDecision,
  validateFinalSignalLevels
} from "../signals/signalDecisionService.js";
import { isSignalExpired } from "../signals/signalValidityService.js";
import { sendTelegramMessage } from "./telegramClient.js";
import { buildTelegramUnlockUrl } from "./telegramSignalPolicy.js";

export const TELEGRAM_DECISION_VERSION = "telegram_decision_v1";

export const TELEGRAM_DECISIONS = Object.freeze([
  "telegram_sent",
  "telegram_queued",
  "telegram_failed",
  "telegram_blocked_user_preference",
  "telegram_blocked_not_ready",
  "telegram_blocked_admin_only",
  "telegram_blocked_quality_gate",
  "telegram_blocked_duplicate",
  "telegram_blocked_cooldown",
  "telegram_blocked_quarantine",
  "telegram_blocked_invalid_levels",
  "telegram_blocked_expired",
  "telegram_blocked_already_sent",
  "telegram_blocked_disabled",
  "telegram_blocked_missing_connection",
  "telegram_blocked_missing_signal_id"
]);

export function resolveTelegramAlertThreshold(settings = {}) {
  const configuredGlobal = Number(appConfig.telegram.readyAlertMinConfidence);
  const globalAlertThreshold = Number.isFinite(configuredGlobal) ? configuredGlobal : 0;
  const configuredUser = Number(settings.minimumConfidence);
  const userAlertThreshold = Number.isFinite(configuredUser) ? configuredUser : 0;
  return {
    globalAlertThreshold,
    userAlertThreshold,
    effectiveAlertThreshold: Math.max(globalAlertThreshold, userAlertThreshold)
  };
}

export function resolveFinalCalibratedConfidence(setup = {}) {
  const calibration = setup.confidenceCalibration ||
    setup.indicators?.confidenceCalibration ||
    setup.fullAnalysis?.indicators?.confidenceCalibration ||
    {};
  const historical = setup.indicators?.historicalStrategyCalibration ||
    setup.fullAnalysis?.indicators?.historicalStrategyCalibration ||
    calibration.historicalStrategy ||
    {};
  const candidates = [
    setup.finalCalibratedConfidence,
    setup.finalConfidence,
    setup.calibratedConfidence,
    historical.finalCalibratedConfidence,
    historical.calibratedConfidence,
    calibration.finalCalibratedConfidence,
    calibration.calibratedConfidence,
    calibration.finalConfidence,
    setup.confidenceScore,
    setup.confidence
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function evaluateTelegramAlertEligibility({
  user = null,
  settings = null,
  setup = null,
  favoriteSymbols = new Set()
} = {}) {
  const thresholds = resolveTelegramAlertThreshold(settings || {});
  const finalCalibratedConfidence = resolveFinalCalibratedConfidence(setup || {});
  const finalSignalDecision = getFinalDecisionDetails(setup);
  const calibration = setup?.confidenceCalibration ||
    setup?.indicators?.confidenceCalibration ||
    setup?.fullAnalysis?.indicators?.confidenceCalibration ||
    {};
  const directionWarning = (calibration.groups || []).find((group) =>
    group.groupType === "direction" && group.status !== "active"
  );
  const audit = {
    signalId: getSignalId(setup),
    userId: user?.id || settings?.userId || null,
    finalSignalDecision: finalSignalDecision.finalDecision,
    primaryDecisionReason: finalSignalDecision.primaryDecisionReason,
    finalCalibratedConfidence,
    ...thresholds,
    preferenceCheckPassed: false,
    messageType: "ready_trade_signal",
    decisionVersion: TELEGRAM_DECISION_VERSION,
    deepLinkUrl: buildTelegramUnlockUrl(setup),
    directionCalibrationWarning: directionWarning
      ? `Confidence reduced because ${setup?.direction} direction is underperforming overall.`
      : null
  };

  if (!setup) {
    return block("telegram_blocked_not_ready", "No generated setup was available for Telegram.", audit);
  }

  if (finalSignalDecision.finalDecision !== "ready_signal") {
    return decisionBlock(finalSignalDecision, audit);
  }

  if (!getSignalId(setup)) {
    return block("telegram_blocked_missing_signal_id", "A stable signal ID is required before a Telegram alert can be queued.", audit);
  }

  const levels = validateFinalSignalLevels(setup);
  if (!levels.valid) {
    const status = levels.reason === "missing_signal_id"
      ? "telegram_blocked_missing_signal_id"
      : "telegram_blocked_invalid_levels";
    return block(status, `Telegram blocked because final trade levels are invalid (${levels.reason}).`, {
      ...audit,
      levelValidationReason: levels.reason
    });
  }

  if (finalSignalDecision.primaryDecisionReason === "signal_expired" || isSignalExpired(setup)) {
    return block("telegram_blocked_expired", "The signal expired before Telegram delivery.", audit);
  }

  if (!appConfig.telegram.botToken) {
    return block("telegram_blocked_missing_connection", "Telegram bot token is not configured.", {
      ...audit,
      connectionReason: "missing_bot_token"
    });
  }
  if (!settings?.chatId) {
    return block("telegram_blocked_missing_connection", "This user does not have a Telegram connection.", {
      ...audit,
      connectionReason: "missing_chat_id"
    });
  }
  if (!settings.enabled) {
    return block("telegram_blocked_disabled", "Telegram alerts are disabled for this user.", audit);
  }

  if (settings.favoriteMarketsOnly && !favoriteSymbols.has(setup.symbol)) {
    return preferenceBlock("Signal market is outside the user's Watchlist-only alert scope.", {
      ...audit,
      preferenceReason: "market_scope"
    });
  }
  if (settings.timeframes?.length && !settings.timeframes.includes(setup.timeframe)) {
    return preferenceBlock("Signal timeframe is not enabled in the user's Telegram preferences.", {
      ...audit,
      preferenceReason: "timeframe"
    });
  }
  if (settings.direction && settings.direction !== "both" &&
      String(settings.direction).toLowerCase() !== String(setup.direction).toLowerCase()) {
    return preferenceBlock("Signal direction does not match the user's Telegram preferences.", {
      ...audit,
      preferenceReason: "direction"
    });
  }

  if (!Number.isFinite(finalCalibratedConfidence) ||
      finalCalibratedConfidence < thresholds.effectiveAlertThreshold) {
    const belowGlobal = finalCalibratedConfidence < thresholds.globalAlertThreshold;
    const reason = !Number.isFinite(finalCalibratedConfidence)
      ? "Final calibrated confidence is unavailable."
      : belowGlobal
        ? `Final confidence ${Math.round(finalCalibratedConfidence)} is below the global trade-alert threshold of ${thresholds.globalAlertThreshold}.`
        : `Final confidence ${Math.round(finalCalibratedConfidence)} is below the user's alert preference of ${thresholds.userAlertThreshold}.`;
    return preferenceBlock(reason, {
      ...audit,
      preferenceReason: belowGlobal
        ? "global_confidence_threshold"
        : "user_confidence_threshold",
      primaryTelegramReason: belowGlobal
        ? "telegram_blocked_global_confidence_threshold"
        : "telegram_blocked_user_confidence_preference"
    });
  }

  if (!audit.deepLinkUrl) {
    return block("telegram_blocked_missing_signal_id", "A valid signal deep link could not be created.", audit);
  }

  return {
    allowed: true,
    status: "telegram_queued",
    reason: "Ready trade signal passed final decision and user preference checks.",
    details: {
      ...audit,
      preferenceCheckPassed: true,
      dispatchAttempted: false
    }
  };
}

export function evaluateGeneratedSignalTelegramDecision(setup = {}) {
  if (!setup) {
    return block("telegram_blocked_not_ready", "No generated setup was available for Telegram.", {
      decisionVersion: TELEGRAM_DECISION_VERSION
    });
  }
  const finalSignalDecision = getFinalDecisionDetails(setup);
  const audit = {
    signalId: getSignalId(setup),
    finalSignalDecision: finalSignalDecision.finalDecision,
    primaryDecisionReason: finalSignalDecision.primaryDecisionReason,
    finalCalibratedConfidence: resolveFinalCalibratedConfidence(setup),
    decisionVersion: TELEGRAM_DECISION_VERSION
  };
  if (finalSignalDecision.finalDecision !== "ready_signal") {
    return decisionBlock(finalSignalDecision, audit);
  }
  if (!getSignalId(setup)) {
    return block("telegram_blocked_missing_signal_id", "A stable signal ID is required before Telegram evaluation.", audit);
  }
  return block(
    "telegram_blocked_missing_connection",
    "Ready signal retained; Telegram must be evaluated against each user's saved connection and preferences.",
    audit
  );
}

export function getFinalDecision(setup = {}) {
  return getFinalDecisionDetails(setup).finalDecision;
}

export async function recordTelegramAlertDiagnostic(input) {
  try {
    await recordGeneratedSignalTelegramDiagnostic(input);
  } catch (error) {
    console.warn(`[telegram] diagnostic_write_failed reason=${error.message}`);
  }
}

export async function getTelegramAlertHealth() {
  const reconciled = await finalizeUnresolvedGeneratedTelegramDecisions();
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
      SELECT id, user_id, signal_id, setup_key, status, attempts,
        final_error_code, final_error_message, updated_at
      FROM telegram_notification_queue
      WHERE status = 'failed' OR final_error_message IS NOT NULL
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
    minimumConfidenceThreshold: Number(appConfig.telegram.readyAlertMinConfidence),
    watchingAlertsEnabled: false,
    watchingAlertMinConfidence: Number(appConfig.telegram.watchingAlertMinConfidence || 65),
    watchingAlertsSentToday: 0,
    alertableSignalCount: Number(summary.alertable_signal_count || 0),
    nonAlertedGeneratedSignalCount: Number(summary.non_alerted_generated_signal_count || 0),
    reconciled,
    finalizedUnresolvedDecisions:
      Number(reconciled.missingDecisions || 0) +
      Number(reconciled.missingQueueRecords || 0),
    noReadyAlerts48h,
    alertScarcityWarning: noReadyAlerts48h ? {
      active: true,
      message: "No ready alerts sent in the last 48 hours.",
      candidatesGenerated: Number(summary.candidates_generated_48h || 0),
      blockedByReason: scarcity.rows.map((row) => ({
        status: row.status,
        count: Number(row.count || 0)
      }))
    } : { active: false },
    failedSends: Number(queue.rows[0]?.failed_sends || 0),
    averageDeliverySeconds: queue.rows[0]?.average_delivery_seconds == null
      ? null
      : Number(queue.rows[0].average_delivery_seconds),
    retryCount: Number(queue.rows[0]?.retry_count || 0),
    latestFailures: failures.rows
  };
}

export async function finalizeUnresolvedGeneratedTelegramDecisions(limit = 50) {
  const boundedLimit = Math.min(100, Math.max(1, Number(limit || 50)));
  const unresolved = await query(`
    SELECT signal_id, setup_key
    FROM generated_signals
    WHERE final_decision = 'ready_signal'
      AND decision_version = 'signal_decision_v1'
      AND created_at >= now() - interval '48 hours'
      AND telegram_status IS NULL
    ORDER BY created_at DESC
    LIMIT $1
  `, [boundedLimit]);
  const brokenQueued = await query(`
    SELECT g.signal_id, g.setup_key
    FROM generated_signals g
    WHERE g.final_decision = 'ready_signal'
      AND g.telegram_status = 'telegram_queued'
      AND g.created_at >= now() - interval '48 hours'
      AND NOT EXISTS (
        SELECT 1 FROM telegram_notification_queue q
        WHERE q.signal_id = g.signal_id OR (g.setup_key IS NOT NULL AND q.setup_key = g.setup_key)
      )
    LIMIT $1
  `, [boundedLimit]);

  for (const signal of unresolved.rows) {
    await recordTelegramAlertDiagnostic({
      signal: { id: signal.signal_id, signalId: signal.signal_id, setupKey: signal.setup_key },
      status: "telegram_blocked_missing_connection",
      reason: "Ready signal has no per-user Telegram delivery decision.",
      details: { reconciled: true, decisionVersion: TELEGRAM_DECISION_VERSION }
    });
  }
  for (const signal of brokenQueued.rows) {
    await recordTelegramAlertDiagnostic({
      signal: { id: signal.signal_id, signalId: signal.signal_id, setupKey: signal.setup_key },
      status: "telegram_failed",
      reason: "Telegram queue state was inconsistent: queued status had no queue record.",
      details: {
        reconciled: true,
        finalErrorCode: "missing_queue_record",
        decisionVersion: TELEGRAM_DECISION_VERSION
      }
    });
  }
  return {
    missingDecisions: unresolved.rowCount,
    missingQueueRecords: brokenQueued.rowCount
  };
}

export async function simulateTelegramAlertLogic(limit = 40) {
  const { signals } = await listGeneratedSignals({
    limit,
    sort: "newest",
    performanceScope: "current"
  });
  return {
    threshold: Number(appConfig.telegram.readyAlertMinConfidence),
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
        confidence: resolveFinalCalibratedConfidence(setup),
        threshold: evaluation.details?.effectiveAlertThreshold,
        wouldSend: evaluation.allowed,
        status: evaluation.allowed ? "would_send" : evaluation.status,
        reason: evaluation.reason
      };
    })
  };
}

export async function sendTelegramAdminTestMessage(chatId) {
  if (!appConfig.telegram.botToken) {
    return {
      ok: false,
      status: "telegram_blocked_missing_connection",
      message: "Telegram bot token is not configured."
    };
  }
  const targetChatId = String(chatId || "").trim();
  if (!targetChatId) {
    return {
      ok: false,
      status: "telegram_blocked_missing_connection",
      message: "Provide a Telegram chat ID for the admin test message."
    };
  }
  await sendTelegramMessage(
    targetChatId,
    "TEST MESSAGE - not a real signal\n\nSignalForge Telegram alerts are connected."
  );
  return { ok: true, status: "telegram_sent", message: "Telegram test message sent." };
}

function getFinalDecisionDetails(setup) {
  const stored = setup?.finalDecision || setup?.final_decision;
  const derived = determineFinalSignalDecision(setup || {});
  if (["ready_signal", "admin_only", "blocked", "rejected"].includes(stored)) {
    if (derived.finalDecision !== stored) {
      return {
        ...derived,
        secondaryDecisionNotes: [
          ...(derived.secondaryDecisionNotes || []),
          `stored_decision_conflict:${stored}`
        ]
      };
    }
    return {
      finalDecision: stored,
      primaryDecisionReason: setup.primaryDecisionReason ||
        setup.primary_decision_reason ||
        "stored_final_decision"
    };
  }
  return derived;
}

function decisionBlock(finalSignalDecision, audit) {
  const reason = finalSignalDecision.primaryDecisionReason || "not_ready";
  if (/expired/.test(reason)) {
    return block(
      "telegram_blocked_expired",
      `Telegram blocked because the signal is expired (${reason}).`,
      audit
    );
  }
  if (/invalid_trade_levels|missing_signal_id/.test(reason)) {
    return block(
      reason === "missing_signal_id"
        ? "telegram_blocked_missing_signal_id"
        : "telegram_blocked_invalid_levels",
      `Telegram blocked because final trade levels are invalid (${reason}).`,
      audit
    );
  }
  if (finalSignalDecision.finalDecision === "admin_only") {
    return block(
      "telegram_blocked_admin_only",
      `Telegram blocked because the final signal decision is admin-only (${reason}).`,
      audit
    );
  }
  if (finalSignalDecision.finalDecision === "rejected") {
    return block(
      "telegram_blocked_not_ready",
      `Telegram blocked because the setup was rejected (${reason}).`,
      audit
    );
  }
  const status = telegramStatusForSignalReason(reason);
  return block(status, `Telegram blocked by final signal decision (${reason}).`, audit);
}

function telegramStatusForSignalReason(reason = "") {
  if (/duplicate/.test(reason)) return "telegram_blocked_duplicate";
  if (/cooldown/.test(reason)) return "telegram_blocked_cooldown";
  if (/quarantin/.test(reason)) return "telegram_blocked_quarantine";
  if (/quality|entry|stop|take_profit|risk_reward|market_regime|historical|strategy|loser/.test(reason)) {
    return "telegram_blocked_quality_gate";
  }
  if (/expired/.test(reason)) return "telegram_blocked_expired";
  if (/invalid_trade_levels|missing_signal_id/.test(reason)) return "telegram_blocked_invalid_levels";
  return "telegram_blocked_not_ready";
}

function preferenceBlock(reason, details) {
  return block("telegram_blocked_user_preference", reason, details);
}

function block(status, reason, details = {}) {
  return {
    allowed: false,
    status,
    reason,
    details: {
      ...details,
      preferenceCheckPassed: Boolean(details.preferenceCheckPassed),
      decisionVersion: TELEGRAM_DECISION_VERSION
    }
  };
}

function getSignalId(setup) {
  return setup?.signalId || setup?.signal_id || setup?.id || null;
}
