import { query } from "../../db/client.js";

export const blockedGeneratedSignalStatuses = Object.freeze({
  duplicate: "Duplicate blocked",
  cooldown: "Cooldown blocked",
  correlated: "Correlated duplicate",
  timeframe: "Quarantined timeframe",
  readiness: "Readiness failed"
});

const currentEngineSourceSql = "source NOT IN ('legacy_saved_signal','legacy_unlocked_signal')";
const timeframeOrder = ["5m", "15m", "1h", "4h"];
const timeframePolicies = Object.freeze({
  "5m": { status: "quarantined", confidenceCap: 72, reason: "5m generated signals are quarantined after weak realized performance." },
  "1h": { status: "quarantined", confidenceCap: 72, reason: "1h generated signals are quarantined after weak realized performance." },
  "15m": { status: "active", confidenceCap: 88, reason: "15m can remain active, but confidence is capped below 90 until stronger evidence develops." },
  "4h": { status: "watchlist", confidenceCap: 88, reason: "4h remains watchlist/promising until enough current-engine closed outcomes exist." }
});

export async function evaluateGeneratedSignalQualityGate(signal, context = {}) {
  if (!signal) return passGate();
  const source = context.source || signal.generationSource || signal.source || signal.indicators?.generationSource || "manual_scan";
  const readiness = Number(signal.readinessScore ?? signal.entryReadinessScore ?? signal.indicators?.readinessScore ?? signal.indicators?.entryReadinessScore ?? 0);
  if (!Number.isFinite(readiness) || readiness <= 0) {
    return blockGate("readiness", "Readiness score is 0, so this setup cannot be promoted as a ready signal.", { readinessScore: readiness });
  }

  const timeframePolicy = getTimeframeQualityPolicy(signal.timeframe);
  if (timeframePolicy.status === "quarantined") {
    return blockGate("timeframe", timeframePolicy.reason, { timeframe: signal.timeframe, confidenceCap: timeframePolicy.confidenceCap });
  }
  if (timeframePolicy.status === "watchlist" && !(await hasProvenSourceStrategyTimeframe(signal, source))) {
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
    resultReason: reason,
    generatedQualityGate: gate,
    validationPassed: true,
    rejectedReasons: [
      ...(signal.rejectedReasons || []),
      { stage: gate.stage || "generated_quality", reason, timestamp: new Date().toISOString(), market: signal.symbol, strategy: signal.setupType }
    ],
    indicators: {
      ...(signal.indicators || {}),
      generatedQualityGate: gate,
      generatedQualityBlocked: true,
      generatedQualityBlockReason: reason
    }
  };
}

export function applyTimeframeConfidencePolicy(signal) {
  if (!signal) return signal;
  const policy = getTimeframeQualityPolicy(signal.timeframe);
  if (!policy.confidenceCap) return signal;
  const confidenceScore = Math.min(Number(signal.confidenceScore || 0), policy.confidenceCap);
  return {
    ...signal,
    confidenceScore,
    indicators: {
      ...(signal.indicators || {}),
      timeframeConfidenceCap: policy.confidenceCap,
      timeframeConfidenceCapReason: policy.reason
    }
  };
}

export function getTimeframeQualityPolicy(timeframe) {
  return timeframePolicies[timeframe] || { status: "active", confidenceCap: null, reason: "" };
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

async function hasProvenSourceStrategyTimeframe(signal, source) {
  const result = await query(`
    SELECT COUNT(*) FILTER (WHERE status IN ('Hit TP','Hit SL'))::integer AS closed,
      COUNT(*) FILTER (WHERE status = 'Hit TP')::integer AS hit_tp,
      COUNT(*) FILTER (WHERE status = 'Hit SL')::integer AS hit_sl,
      COALESCE(AVG(risk_reward), 0) AS average_rr
    FROM generated_signals
    WHERE source = $1
      AND strategy = $2
      AND timeframe = $3
      AND ${currentEngineSourceSql}
  `, [source, signal.setupType || signal.strategy || "Qualified setup", signal.timeframe]);
  const row = result.rows[0] || {};
  const closed = Number(row.closed || 0);
  if (closed < 20) return false;
  const hitTp = Number(row.hit_tp || 0);
  const hitSl = Number(row.hit_sl || 0);
  const winRate = closed ? hitTp / closed : 0;
  const averageRr = Number(row.average_rr || 0);
  const expectancy = winRate * averageRr - (1 - winRate);
  return expectancy > 0;
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
