import { query } from "../../db/client.js";
import { calculateGroupStatus } from "./signalConfidenceCalibrationService.js";

export const blockedGeneratedSignalStatuses = Object.freeze({
  duplicate: "Duplicate blocked",
  cooldown: "Cooldown blocked",
  correlated: "Correlated duplicate",
  timeframe: "Quarantined timeframe",
  readiness: "Readiness failed"
});

const currentEngineSourceSql = "source NOT IN ('legacy_saved_signal','legacy_unlocked_signal')";
const timeframeOrder = ["5m", "15m", "1h", "4h"];
const defaultTimeframePolicy = Object.freeze({ status: "active", confidenceCap: null, reason: "" });

export async function evaluateGeneratedSignalQualityGate(signal, context = {}) {
  if (!signal) return passGate();
  const readiness = Number(signal.readinessScore ?? signal.entryReadinessScore ?? signal.indicators?.readinessScore ?? signal.indicators?.entryReadinessScore ?? 0);
  if (!Number.isFinite(readiness) || readiness <= 0) {
    return blockGate("readiness", "Readiness score is 0, so this setup cannot be promoted as a ready signal.", { readinessScore: readiness });
  }

  const timeframePolicy = await getEffectiveTimeframeQualityPolicy(signal.timeframe);
  if (["quarantined", "disabled_by_admin", "watchlist"].includes(timeframePolicy.status)) {
    return blockGate("timeframe", timeframePolicy.reason, { timeframe: signal.timeframe, confidenceCap: timeframePolicy.confidenceCap });
  }

  const cooldown = await findRecentGeneratedSignalFailure(signal);
  if (cooldown) {
    return blockGate("cooldown", `Blocked by cooldown because the last similar signal ${cooldown.status === "Hit SL" ? "hit SL" : "expired"}.`, cooldown);
  }

  const duplicate = await findRecentGeneratedSignalDuplicate(signal);
  if (duplicate) {
    return blockGate(
      duplicate.timeframe === signal.timeframe ? "duplicate" : "correlated",
      duplicate.timeframe === signal.timeframe
        ? "A recent similar ready signal already exists for this pair, direction, timeframe, and strategy."
        : "A recent correlated signal already exists for this pair and direction on a nearby timeframe.",
      duplicate
    );
  }

  return passGate();
}

export function applyGeneratedSignalQualityBlock(signal, gate) {
  if (!signal || gate?.passed !== false) return signal;
  const status = gate.status || blockedGeneratedSignalStatuses.duplicate;
  const reason = gate.reason || "Generated signal blocked by quality gate.";
  return {
    ...signal,
    status,
    resultType: "blocked_signal",
    resultReason: reason,
    generatedQualityGate: gate,
    structuralValidationPassed: signal.validationPassed !== false,
    generatedQualityGatePassed: false,
    generatedQualityBlocked: true,
    validationPassed: false,
    rejectedReasons: [
      ...(signal.rejectedReasons || []),
      { stage: gate.stage || "generated_quality", reason, timestamp: new Date().toISOString(), market: signal.symbol, strategy: signal.setupType }
    ],
    indicators: {
      ...(signal.indicators || {}),
      generatedQualityGate: gate,
      structuralValidationPassed: signal.validationPassed !== false,
      generatedQualityGatePassed: false,
      generatedQualityBlocked: true,
      generatedQualityBlockReason: reason
    }
  };
}

export function applyTimeframeConfidencePolicy(signal) {
  return signal;
}

export function getTimeframeQualityPolicy() {
  return { ...defaultTimeframePolicy };
}

export function getFailureCooldownMs(timeframe, status = "Hit SL") {
  const hours = { "5m": 4, "15m": 6, "1h": 24, "4h": 48 }[timeframe] || 6;
  const multiplier = status === "Expired" ? 0.5 : 1;
  return hours * multiplier * 60 * 60 * 1000;
}

export function isNearbyTimeframe(timeframe, otherTimeframe) {
  if (timeframe === otherTimeframe) return true;
  const index = timeframeOrder.indexOf(timeframe);
  const otherIndex = timeframeOrder.indexOf(otherTimeframe);
  return index >= 0 && otherIndex >= 0 && Math.abs(index - otherIndex) <= 1;
}

export function isSimilarEntryPrice(entry, otherEntry) {
  const left = Number(entry);
  const right = Number(otherEntry);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return false;
  return Math.abs(left - right) / Math.max(left, right) <= 0.0025;
}

export function isSimilarStrategyOrPattern(signal, row) {
  const strategy = normalizeText(signal.setupType || signal.strategy);
  const otherStrategy = normalizeText(row.strategy);
  const pattern = normalizeText(signal.patternContext?.pattern || signal.indicators?.patternContext?.pattern);
  const otherPattern = normalizeText(row.pattern);
  return Boolean(strategy && otherStrategy && strategy === otherStrategy) || Boolean(pattern && otherPattern && pattern === otherPattern);
}

async function findRecentGeneratedSignalDuplicate(signal) {
  const result = await query(`
    SELECT id, pair, timeframe, direction, strategy, pattern, entry, confidence,
      risk_reward, setup_quality_score, entry_readiness_score, status, created_at
    FROM generated_signals
    WHERE pair = $1
      AND direction = $2
      AND status = 'Active'
      AND ${currentEngineSourceSql}
      AND created_at >= now() - interval '6 hours'
    ORDER BY created_at DESC
    LIMIT 25
  `, [signal.symbol || signal.pair, signal.direction]);

  return result.rows.find((row) =>
    isNearbyTimeframe(signal.timeframe, row.timeframe) &&
    isSimilarEntryPrice(signal.entryPrice ?? signal.entry, row.entry) &&
    isSimilarStrategyOrPattern(signal, row)
  ) || null;
}

async function findRecentGeneratedSignalFailure(signal) {
  const maxCooldownMs = getFailureCooldownMs("4h", "Hit SL");
  const result = await query(`
    SELECT id, pair, timeframe, direction, strategy, pattern, entry, status,
      COALESCE(hit_sl_at, expired_at, updated_at, created_at) AS resolved_at
    FROM generated_signals
    WHERE pair = $1
      AND timeframe = $2
      AND direction = $3
      AND status IN ('Hit SL', 'Expired')
      AND ${currentEngineSourceSql}
      AND COALESCE(hit_sl_at, expired_at, updated_at, created_at) >= now() - ($4::text || ' milliseconds')::interval
    ORDER BY COALESCE(hit_sl_at, expired_at, updated_at, created_at) DESC
    LIMIT 10
  `, [signal.symbol || signal.pair, signal.timeframe, signal.direction, String(maxCooldownMs)]);

  const now = Date.now();
  return result.rows.find((row) => {
    if (!isSimilarStrategyOrPattern(signal, row)) return false;
    const resolvedAt = new Date(row.resolved_at).getTime();
    return Number.isFinite(resolvedAt) && now - resolvedAt <= getFailureCooldownMs(signal.timeframe, row.status);
  }) || null;
}

async function getEffectiveTimeframeQualityPolicy(timeframe) {
  const result = await query(
    "SELECT * FROM signal_strategy_statuses WHERE group_key = $1 LIMIT 1",
    [`timeframe:${String(timeframe || "unknown").toLowerCase()}`]
  );
  const override = result.rows[0] || null;
  if (!override) return getTimeframeQualityPolicy(timeframe);
  const policy = calculateGroupStatus({}, override);
  return {
    status: policy.status,
    confidenceCap: policy.confidenceCap,
    reason: override.admin_note || `The ${timeframe} timeframe is ${policy.status.replaceAll("_", " ")} by explicit admin setting.`,
    adminControlled: policy.adminControlled
  };
}

function passGate() {
  return { passed: true, status: "passed", reasons: [] };
}

function blockGate(type, reason, details = {}) {
  return {
    passed: false,
    type,
    stage: `generated_quality_${type}`,
    status: blockedGeneratedSignalStatuses[type] || blockedGeneratedSignalStatuses.duplicate,
    reason,
    details,
    checkedAt: new Date().toISOString()
  };
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
