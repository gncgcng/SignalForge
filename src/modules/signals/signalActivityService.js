import { appConfig } from "../../config/appConfig.js";
import { query } from "../../db/client.js";
import { listGeneratedSignals } from "../admin-signals/generatedSignalRepository.js";
import { getLatestDailyMarketBrief } from "./dailyMarketBriefService.js";
import { listSetupCandidates } from "./setupCandidateService.js";

const BLOCKED_STATUSES = [
  "Duplicate blocked",
  "Cooldown blocked",
  "Correlated duplicate",
  "Quarantined timeframe",
  "Readiness failed",
  "Weak strategy match",
  "Poor entry quality",
  "Invalid stop loss",
  "Unrealistic take profit",
  "Weak risk/reward",
  "Bad market regime",
  "Historical underperformer",
  "Similar to past losers",
  "Invalid legacy ready signal",
  "Strategy Misread Rejected",
  "Weak Pattern Match",
  "Quality Gate Blocked"
];

export async function getSignalActivityFeed(user = {}) {
  const [ready, watching, candidates, marketBrief] = await Promise.all([
    listGeneratedSignals({ status: "Active", limit: 10, page: 1, sort: "newest" }).catch(emptyListing),
    listGeneratedSignals({ status: "Watching", limit: user?.isAdmin ? 50 : 10, page: 1, sort: "confidence" }).catch(emptyListing),
    listSetupCandidates().catch(() => []),
    getLatestDailyMarketBrief().catch(() => null)
  ]);

  return {
    activity: buildSignalActivityResponse({
      user,
      readySignals: ready.signals || [],
      watchingSignals: watching.signals || [],
      candidates,
      marketBrief
    })
  };
}

export function buildSignalActivityResponse({
  user = {},
  readySignals = [],
  watchingSignals = [],
  candidates = [],
  marketBrief = null,
  now = new Date()
} = {}) {
  const userWatchingLimit = user?.isAdmin ? 20 : 5;
  const safeReadySignals = readySignals.slice(0, 5).map(toSafeReadyPreview);
  const watchingSetups = rankWatchingSetups([
    ...watchingSignals.map(toWatchingFromGenerated),
    ...candidates.map(toWatchingFromCandidate)
  ]).slice(0, userWatchingLimit);
  const avoidTrades = buildAvoidTradeInsights(marketBrief).slice(0, 3);
  const marketInsights = buildMarketInsights(marketBrief);
  const whyNoSignal = buildWhyNoSignal({
    readyCount: safeReadySignals.length,
    watchingSetups,
    avoidTrades,
    marketBrief
  });

  return {
    generatedAt: now.toISOString(),
    summary: {
      readySignals: safeReadySignals.length,
      watchingSetups: watchingSetups.length,
      avoidTrades: avoidTrades.length,
      marketInsights: marketInsights.length,
      message: safeReadySignals.length
        ? "Ready signals passed the strict quality gate."
        : "No ready signals right now. SignalForge is tracking these setups."
    },
    readySignals: safeReadySignals,
    watchingSetups,
    avoidTrades,
    marketInsights,
    marketBrief,
    whyNoSignal,
    copy: {
      selective: "SignalForge is selective. Not every setup becomes a trade signal.",
      watching: "Watching setups are not trade signals.",
      avoid: "Avoid Trade means SignalForge sees risk and is choosing not to force a trade.",
      confidence: "Confidence reflects rule alignment and setup quality. It is not a win probability."
    },
    credits: {
      watchingSetup: 0,
      avoidTrade: 0,
      marketBrief: 0
    },
    telegram: {
      readyAlertMinConfidence: appConfig.telegram.readyAlertMinConfidence,
      watchingAlertsEnabled: appConfig.telegram.watchingAlertsEnabled,
      watchingAlertMinConfidence: appConfig.telegram.watchingAlertMinConfidence,
      dailyBriefEnabled: appConfig.telegram.dailyBriefEnabled
    }
  };
}

export async function getAdminSignalSupplyDashboard() {
  const [generated, telegram, blockReasons] = await Promise.all([
    query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::integer AS candidates_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND status = 'Active')::integer AS ready_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND COALESCE(quality_gate_status, '') = 'passed')::integer AS quality_gate_passed_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND status = 'Active' AND COALESCE(quality_gate_status, '') = 'passed')::integer AS valid_ready_candidates_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND status = 'Watching')::integer AS watching_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND (
          status = ANY($1::text[]) OR COALESCE(quality_gate_status, '') NOT IN ('', 'passed')
        ))::integer AS blocked_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND (
          status ILIKE '%rejected%' OR status IN ('Weak Pattern Match','Strategy Misread Rejected')
        ))::integer AS rejected_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND source IN ('admin_test','backtest_shadow','legacy_saved_signal','legacy_unlocked_signal'))::integer AS admin_only_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '48 hours' AND status = 'Active')::integer AS ready_48h,
        (SELECT COUNT(*)::integer FROM avoid_trade_learning_events WHERE created_at >= now() - interval '24 hours') AS avoid_24h
      FROM generated_signals
    `, [BLOCKED_STATUSES]),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND status IN ('sent','queued','telegram_queued'))::integer AS ready_alerts_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND status = 'telegram_watching_eligible')::integer AS watching_alerts_24h,
        COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours' AND (
          status LIKE 'blocked_%' OR status LIKE 'telegram_blocked_%' OR status IN ('telegram_disabled','missing_chat_id','missing_bot_token','telegram_missing_bot_token')
        ))::integer AS telegram_blocked_24h,
        MAX(attempted_at) AS last_attempt_at,
        MAX(attempted_at) FILTER (WHERE status IN ('sent','queued','telegram_queued')) AS last_sent_at
      FROM telegram_alert_diagnostics
    `),
    query(`
      SELECT reason, status, COUNT(*)::integer AS count
      FROM telegram_alert_diagnostics
      WHERE created_at >= now() - interval '24 hours'
        AND (status LIKE 'blocked_%' OR status LIKE 'telegram_blocked_%' OR status IN ('telegram_disabled','missing_chat_id','missing_bot_token','telegram_missing_bot_token','telegram_watching_eligible'))
      GROUP BY reason, status
      ORDER BY count DESC
      LIMIT 8
    `)
  ]);

  return {
    supply: buildAdminSignalSupplySummary({
      generated: generated.rows[0] || {},
      telegram: telegram.rows[0] || {},
      blockReasons: blockReasons.rows || []
    })
  };
}

export function buildAdminSignalSupplySummary({ generated = {}, telegram = {}, blockReasons = [] } = {}) {
  const ready48h = Number(generated.ready_48h || 0);
  return {
    generatedAt: new Date().toISOString(),
    window: "24h",
    counts: {
      candidates: Number(generated.candidates_24h || 0),
      qualityGatePassed: Number(generated.quality_gate_passed_24h || 0),
      validReadyCandidates: Number(generated.valid_ready_candidates_24h || 0),
      promotedReadySignals: Number(generated.ready_24h || 0),
      ready: Number(generated.ready_24h || 0),
      watching: Number(generated.watching_24h || 0),
      avoidTrade: Number(generated.avoid_24h || 0),
      adminOnly: Number(generated.admin_only_24h || 0),
      rejected: Number(generated.rejected_24h || 0),
      blocked: Number(generated.blocked_24h || 0),
      ready48h
    },
    telegram: {
      readyAlerts: Number(telegram.ready_alerts_24h || 0),
      watchingAlerts: Number(telegram.watching_alerts_24h || 0),
      blocked: Number(telegram.telegram_blocked_24h || 0),
      lastAttemptAt: telegram.last_attempt_at || null,
      lastSentAt: telegram.last_sent_at || null,
      readyThreshold: appConfig.telegram.readyAlertMinConfidence,
      watchingEnabled: appConfig.telegram.watchingAlertsEnabled,
      watchingThreshold: appConfig.telegram.watchingAlertMinConfidence,
      dailyBriefEnabled: appConfig.telegram.dailyBriefEnabled
    },
    warning: ready48h === 0
      ? "No ready signals in 48 hours. Review watching volume and top block reasons before changing thresholds."
      : null,
    topReasonReadySignalsNotProduced: topSupplyBlocker(blockReasons),
    topBlockReasons: blockReasons.map((row) => ({
      reason: row.reason || row.status || "Not specified",
      status: row.status || "unknown",
      count: Number(row.count || 0)
    }))
  };
}

function topSupplyBlocker(blockReasons = []) {
  const top = [...blockReasons].sort((left, right) => Number(right.count || 0) - Number(left.count || 0))[0];
  if (!top) return "No dominant blocker in the last 24 hours.";
  const status = String(top.status || "");
  if (status.includes("quarantined_timeframe")) {
    return "Too many candidates are blocked by timeframe quarantine.";
  }
  if (status.includes("low_confidence")) {
    return "Ready candidates are below the Telegram confidence threshold.";
  }
  if (status.includes("failed_quality_gate")) {
    return "Quality Gate is rejecting the strongest candidates.";
  }
  if (status.includes("duplicate") || status.includes("cooldown")) {
    return "Duplicate or cooldown protection is blocking repeated setups.";
  }
  return top.reason || status || "No dominant blocker in the last 24 hours.";
}

export function toSafeReadyPreview(signal = {}) {
  return {
    tier: "ready_signal",
    id: signal.id,
    signalId: signal.signalId || signal.id,
    setupKey: signal.setupKey || null,
    pair: signal.pair || signal.symbol,
    displaySymbol: signal.displayPair || displaySymbol(signal.pair || signal.symbol),
    provider: signal.provider || signal.marketSource || "unknown",
    timeframe: signal.timeframe,
    direction: signal.direction,
    strategy: signal.strategy || signal.setupType || "Qualified setup",
    pattern: signal.pattern || signal.patternContext?.label || null,
    confidence: Math.round(Number(signal.calibratedConfidence ?? signal.confidence ?? signal.confidenceScore ?? 0)),
    confidenceBand: confidenceBand(signal.calibratedConfidence ?? signal.confidence ?? signal.confidenceScore),
    riskReward: Number(signal.riskReward || signal.riskRewardRatio || 0),
    status: signal.status || "Active",
    validUntil: signal.validUntil || signal.valid_until || null,
    unlockEligible: true,
    creditCost: 1,
    lockedLevels: true
  };
}

function toWatchingFromGenerated(signal = {}) {
  return {
    tier: "watching_setup",
    id: signal.id,
    pair: signal.pair || signal.symbol,
    displaySymbol: signal.displayPair || displaySymbol(signal.pair || signal.symbol),
    timeframe: signal.timeframe,
    direction: signal.direction,
    strategy: signal.strategy || signal.setupType || "Setup forming",
    pattern: signal.pattern || signal.patternContext?.label || null,
    setupScore: Number(signal.setupQualityScore || signal.qualityScore || signal.confidence || 0),
    readinessScore: Number(signal.entryReadinessScore || signal.readinessScore || 0),
    confidenceEstimate: Math.round(Number(signal.calibratedConfidence ?? signal.confidence ?? 0)),
    whatPassed: firstItems(signal.qualityBreakdown?.passed || signal.validationSummary?.passedChecks || [], 3),
    missingConfirmations: firstItems(signal.candidateOrigin?.missingConfirmations || signal.warningReasons || [], 4),
    reason: userReason(signal.resultReason || signal.calibrationReason || signal.qualityGateReason, "Setup is forming, but it has not passed the final ready-signal checks."),
    nextCondition: nextConditionFrom(signal),
    creditCost: 0,
    telegramWatchingEligible: appConfig.telegram.watchingAlertsEnabled &&
      Number(signal.calibratedConfidence ?? signal.confidence ?? 0) >= appConfig.telegram.watchingAlertMinConfidence
  };
}

function toWatchingFromCandidate(candidate = {}) {
  return {
    tier: "watching_setup",
    id: candidate.id,
    pair: candidate.symbol || candidate.pair,
    displaySymbol: candidate.displayPair || displaySymbol(candidate.symbol || candidate.pair),
    timeframe: candidate.timeframe,
    direction: candidate.direction,
    strategy: candidate.setupType || candidate.strategy || "Setup forming",
    pattern: candidate.metadata?.patternContext?.label || candidate.metadata?.patternContext?.pattern || null,
    setupScore: Number(candidate.setupQualityScore || candidate.candidateScore || 0),
    readinessScore: Number(candidate.entryReadinessScore || candidate.readinessScore || 0),
    confidenceEstimate: Math.round(Number(candidate.confidenceEstimate || 0)),
    whatPassed: firstItems(candidate.reasonsForWatching, 3),
    missingConfirmations: firstItems(candidate.missingConfirmations, 4),
    reason: userReason((candidate.reasonsForWatching || [])[0], "SignalForge is waiting for better confirmation."),
    nextCondition: firstItems(candidate.nextConditions, 1)[0] || "Waiting for the remaining rule confirmations to align.",
    creditCost: 0,
    telegramWatchingEligible: appConfig.telegram.watchingAlertsEnabled &&
      Number(candidate.confidenceEstimate || 0) >= appConfig.telegram.watchingAlertMinConfidence
  };
}

function rankWatchingSetups(items = []) {
  const seen = new Set();
  return items
    .filter((item) => item.pair && item.timeframe)
    .sort((a, b) =>
      (b.readinessScore + b.setupScore + b.confidenceEstimate) -
      (a.readinessScore + a.setupScore + a.confidenceEstimate)
    )
    .filter((item) => {
      const key = [item.pair, item.timeframe, item.direction, item.strategy].join(":").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildAvoidTradeInsights(brief = null) {
  const weakest = brief?.weakestPairs || [];
  return weakest.map((item) => ({
    tier: "avoid_trade",
    pair: item.symbol,
    displaySymbol: displaySymbol(item.symbol),
    timeframe: item.timeframe || "mixed",
    reason: userReason(item.reason || item.summary, "SignalForge does not see a clean setup right now."),
    avoidBecause: firstItems(item.reasons || item.blockers || brief?.mainReasons || [], 4),
    whatWouldImprove: firstItems(item.nextConditions || [
      "Cleaner trend confirmation",
      "Better risk/reward",
      "Stronger candle and volume confirmation"
    ], 3),
    creditCost: 0
  }));
}

function buildMarketInsights(brief = null) {
  if (!brief) return [];
  return [
    ...(brief.strongestPairs || []).slice(0, 3).map((item) => ({
      tier: "market_insight",
      type: "strong",
      pair: item.symbol,
      displaySymbol: displaySymbol(item.symbol),
      summary: item.summary || item.reason || "Relative scanner strength is improving."
    })),
    ...(brief.weakestPairs || []).slice(0, 3).map((item) => ({
      tier: "market_insight",
      type: "weak",
      pair: item.symbol,
      displaySymbol: displaySymbol(item.symbol),
      summary: item.summary || item.reason || "Scanner conditions are weak or choppy."
    }))
  ];
}

function buildWhyNoSignal({ readyCount, watchingSetups, avoidTrades, marketBrief }) {
  if (readyCount > 0) {
    return {
      title: "Ready signals available",
      summary: "At least one setup passed the strict quality gate.",
      reasons: []
    };
  }
  const reasons = [
    ...(marketBrief?.mainReasons || []),
    ...watchingSetups.flatMap((item) => item.missingConfirmations || []),
    ...avoidTrades.flatMap((item) => item.avoidBecause || [])
  ];
  return {
    title: "No ready signals right now.",
    summary: watchingSetups.length
      ? "SignalForge is tracking forming setups and waiting for cleaner confirmation before promoting a trade signal."
      : "SignalForge scanned the market but did not find a setup clean enough for a ready signal.",
    reasons: [...new Set(reasons.map((item) => userReason(item)).filter(Boolean))].slice(0, 5)
  };
}

function nextConditionFrom(signal = {}) {
  const condition = signal.candidateOrigin?.missingConfirmations?.[0] || signal.warningReasons?.[0] || signal.qualityGateReason;
  if (!condition) return "Waiting for the final confirmation rules to align.";
  return userReason(condition);
}

function userReason(value, fallback = "") {
  const text = String(value || fallback || "").trim();
  if (!text) return "";
  return text
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bRr\b/g, "R/R")
    .replace(/\bTp\b/g, "TP")
    .replace(/\bSl\b/g, "SL");
}

function firstItems(value, limit) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((item) => userReason(item)).filter(Boolean).slice(0, limit);
}

function displaySymbol(symbol) {
  return String(symbol || "").toUpperCase().replace(/[-/]/g, "");
}

function confidenceBand(confidence) {
  const value = Number(confidence || 0);
  if (value >= 95) return "Elite";
  if (value >= 90) return "Excellent";
  if (value >= 80) return "Strong";
  if (value >= 70) return "Good";
  return "Below ready";
}

function emptyListing() {
  return { signals: [], total: 0, page: 1, totalPages: 1 };
}
