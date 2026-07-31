import {
  blockedGeneratedSignalStatuses,
  getTimeframeQualityPolicy
} from "./generatedSignalQualityGate.js";
import { isSignalExpired } from "./signalValidityService.js";

export const SIGNAL_DECISION_VERSION = "signal_decision_v1";
export const FINAL_SIGNAL_DECISIONS = Object.freeze([
  "ready_signal",
  "admin_only",
  "blocked",
  "rejected"
]);

const blockedStatusReasons = new Map([
  ...Object.entries(blockedGeneratedSignalStatuses).map(([reason, status]) => [status, reason]),
  ["Strategy Misread Rejected", "strategy_misread_rejected"],
  ["Weak Pattern Match", "weak_pattern_match"]
]);

const adminOnlySources = new Set([
  "legacy_saved_signal",
  "legacy_unlocked_signal",
  "backtest_shadow",
  "admin_test",
  "test",
  "debug"
]);

export function determineFinalSignalDecision(signal = {}, options = {}) {
  const createdAt = options.now
    ? new Date(options.now).toISOString()
    : new Date().toISOString();
  const status = String(signal.status || "Active");
  const source = signal.source || signal.generationSource || signal.indicators?.generationSource || "";
  const qualityGate = readQualityGate(signal);
  const notes = buildDecisionNotes(signal, qualityGate);

  if (/rejected/i.test(status) || ["Strategy Misread Rejected", "Weak Pattern Match"].includes(status)) {
    return decision("rejected", normalizeReason(status) || "structurally_invalid_setup", notes, createdAt);
  }

  if (blockedStatusReasons.has(status)) {
    return decision("blocked", blockedStatusReasons.get(status), notes, createdAt);
  }

  if (adminOnlySources.has(source)) {
    return decision("admin_only", `source_${normalizeReason(source)}`, notes, createdAt);
  }

  if (["Hit TP", "Hit SL", "Expired", "Manually closed", "Cancelled", "Invalidated"].includes(status)) {
    return decision("admin_only", normalizeReason(status), notes, createdAt);
  }

  if (["Watching", "Avoid Trade", "Watching setup"].includes(status)) {
    return decision("admin_only", normalizeReason(status), notes, createdAt);
  }

  if (qualityGate.passed !== true || (qualityGate.status && qualityGate.status !== "passed")) {
    return decision("blocked", qualityGate.reason || "failed_quality_gate", notes, createdAt);
  }

  if (getTimeframeQualityPolicy(signal.timeframe).status === "quarantined") {
    return decision("blocked", "quarantined_timeframe", notes, createdAt);
  }

  const readiness = Number(
    signal.readinessScore ??
    signal.entryReadinessScore ??
    signal.indicators?.readinessScore ??
    signal.fullAnalysis?.indicators?.readinessScore
  );
  if (!Number.isFinite(readiness) || readiness <= 0) {
    return decision("blocked", "readiness_failed", notes, createdAt);
  }

  const levels = validateFinalSignalLevels(signal);
  if (!levels.valid) {
    return decision("rejected", levels.reason, [...notes, levels.reason], createdAt);
  }

  if (isSignalExpired(signal, options.now)) {
    return decision("admin_only", "signal_expired", notes, createdAt);
  }

  if (!["Active", "Expiring Soon", "Ready", "Alerted"].includes(status)) {
    return decision("admin_only", `status_${normalizeReason(status) || "unknown"}`, notes, createdAt);
  }

  return decision("ready_signal", "all_signal_requirements_passed", notes, createdAt);
}

export function applyFinalSignalDecision(signal, options = {}) {
  if (!signal) return signal;
  const next = determineFinalSignalDecision(signal, options);
  const previous = signal.finalDecision || signal.final_decision;
  const decisionCreatedAt = previous === next.finalDecision
    ? signal.decisionCreatedAt || signal.decision_created_at || next.decisionCreatedAt
    : next.decisionCreatedAt;
  const finalDecision = {
    ...next,
    decisionCreatedAt
  };
  return {
    ...signal,
    finalDecision: finalDecision.finalDecision,
    primaryDecisionReason: finalDecision.primaryDecisionReason,
    secondaryDecisionNotes: finalDecision.secondaryDecisionNotes,
    decisionVersion: finalDecision.decisionVersion,
    decisionCreatedAt,
    indicators: {
      ...(signal.indicators || {}),
      finalSignalDecision: finalDecision
    }
  };
}

export function validateFinalSignalLevels(signal = {}) {
  const entry = Number(signal.entryPrice ?? signal.entry);
  const stop = Number(signal.stopLoss ?? signal.stop_loss);
  const target = Number(signal.takeProfit ?? signal.take_profit);
  const riskReward = Number(signal.riskRewardRatio ?? signal.riskReward ?? signal.risk_reward);
  const direction = String(signal.direction || "").toLowerCase();
  if (!signal.id && !signal.signalId && !signal.setupKey) {
    return { valid: false, reason: "missing_signal_id" };
  }
  if (![entry, stop, target, riskReward].every(Number.isFinite) || riskReward <= 0) {
    return { valid: false, reason: "invalid_trade_levels" };
  }
  if (direction === "long" && stop < entry && target > entry) {
    return { valid: true, entry, stop, target, riskReward, direction };
  }
  if (direction === "short" && stop > entry && target < entry) {
    return { valid: true, entry, stop, target, riskReward, direction };
  }
  return { valid: false, reason: "invalid_trade_levels" };
}

function readQualityGate(signal = {}) {
  const generated = signal.generatedQualityGate ||
    signal.indicators?.generatedQualityGate ||
    signal.fullAnalysis?.indicators?.generatedQualityGate ||
    {};
  const v2 = signal.indicators?.qualityGateV2 ||
    signal.fullAnalysis?.indicators?.qualityGateV2 ||
    generated.qualityGateV2 ||
    {};
  const explicitPassed = signal.qualityGatePassed ??
    signal.indicators?.qualityGatePassed ??
    signal.fullAnalysis?.indicators?.qualityGatePassed;
  const status = v2.status || generated.status || signal.qualityGateStatus || null;
  return {
    passed: (explicitPassed === true || status === "passed") &&
      generated.passed !== false &&
      v2.passed !== false,
    status,
    reason: v2.reasonCode || generated.reasonCode || signal.qualityGateReason || null
  };
}

function buildDecisionNotes(signal, qualityGate) {
  const notes = [
    `quality_gate:${qualityGate.passed ? "passed" : qualityGate.status || "failed"}`,
    signal.generatedQualityGate?.type ? `protection:${signal.generatedQualityGate.type}` : null,
    signal.indicators?.duplicateSelection ? "duplicate:selected_current" : null,
    signal.indicators?.cooldownDecision?.cooldownReleasedEarly ? `cooldown:released_${signal.indicators.cooldownDecision.cooldownReleaseReason}` : null,
    getTimeframeQualityPolicy(signal.timeframe).status === "quarantined" ? "quarantine:blocked" : "quarantine:clear"
  ];
  return [...new Set(notes.filter(Boolean))];
}

function decision(finalDecision, primaryDecisionReason, secondaryDecisionNotes, decisionCreatedAt) {
  return {
    finalDecision,
    primaryDecisionReason,
    secondaryDecisionNotes,
    decisionVersion: SIGNAL_DECISION_VERSION,
    decisionCreatedAt
  };
}

function normalizeReason(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
