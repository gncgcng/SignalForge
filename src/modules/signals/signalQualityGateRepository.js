import { appConfig } from "../../config/appConfig.js";
import { query } from "../../db/client.js";
import { createId } from "../../shared/ids.js";

export async function recordSignalQualityGateResult(signal, gate = {}, context = {}) {
  if (!signal || !gate?.version) return null;
  const pair = signal.symbol || signal.pair || "unknown";
  const timeframe = signal.timeframe || "unknown";
  const direction = signal.direction || "unknown";
  const strategy = gate.attemptedStrategy || signal.setupType || signal.strategy || "Unknown strategy";
  const source = context.source || signal.generationSource || signal.source || signal.indicators?.generationSource || "manual_scan";
  const reason = normalizeQualityGateReasonCode(gate.reasonCode || gate.status || "unknown", gate);

  await query(`
    INSERT INTO quality_gate_reason_stats (
      reason, strategy, timeframe, pair, count, last_seen_at, updated_at
    ) VALUES ($1,$2,$3,$4,1,now(),now())
    ON CONFLICT (reason, strategy, timeframe, pair) DO UPDATE SET
      count = quality_gate_reason_stats.count + 1,
      last_seen_at = now(),
      updated_at = now()
  `, [reason, strategy, timeframe, pair]);

  const shouldStoreDetail = gate.passed === false || context.storePassedDetail === true;
  if (!shouldStoreDetail) return gate;
  const dedupeKey = buildQualityGateDedupeKey({
    pair,
    timeframe,
    direction,
    strategy,
    reason,
    source,
    date: context.createdAt || gate.checkedAt || new Date()
  });

  await query(`
    INSERT INTO signal_quality_gate_results (
      id, signal_id, candidate_id, pair, timeframe, direction, attempted_strategy,
      gate_status, rejection_reason, explanation, user_explanation, raw_score,
      calibrated_confidence, details, dedupe_key, source, event_count,
      first_seen_at, last_seen_at, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,now(),now(),now())
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
      event_count = signal_quality_gate_results.event_count + 1,
      last_seen_at = now(),
      explanation = EXCLUDED.explanation,
      user_explanation = EXCLUDED.user_explanation,
      raw_score = EXCLUDED.raw_score,
      calibrated_confidence = EXCLUDED.calibrated_confidence,
      details = EXCLUDED.details
  `, [
    createId("qgate"),
    signal.id || signal.signalId || null,
    context.candidateId || signal.promotedFromCandidateId || null,
    pair,
    timeframe,
    direction,
    strategy,
    gate.status || (gate.passed ? "passed" : "rejected"),
    reason,
    gate.explanation || "",
    gate.userExplanation || "",
    finiteOrNull(signal.rawSetupScore ?? signal.qualityScore ?? signal.confidenceScore),
    finiteOrNull(signal.calibratedConfidence ?? signal.confidenceScore),
    JSON.stringify(gate),
    dedupeKey,
    source
  ]);
  await enforceSignalQualityGateRetention();
  return gate;
}

export async function getSignalQualityGateDashboard() {
  const [stats, recent] = await Promise.all([
    query(`
      SELECT reason, strategy, timeframe, pair, count, last_seen_at
      FROM quality_gate_reason_stats
      ORDER BY count DESC, last_seen_at DESC
      LIMIT 500
    `),
    query(`
      SELECT pair, timeframe, direction, attempted_strategy, gate_status,
        rejection_reason, explanation, user_explanation, raw_score,
        calibrated_confidence, details, source,
        COALESCE(event_count, 1) AS event_count,
        COALESCE(first_seen_at, created_at) AS first_seen_at,
        COALESCE(last_seen_at, created_at) AS last_seen_at,
        created_at
      FROM signal_quality_gate_results
      WHERE gate_status <> 'passed'
      ORDER BY COALESCE(last_seen_at, created_at) DESC
      LIMIT 25
    `)
  ]);
  const aggregated = aggregateReasonStats(stats.rows || []);
  const totalChecked = Object.values(aggregated.failedByReason).reduce((sum, count) => sum + count, 0) + aggregated.passed;
  return {
    totalSetupsChecked: totalChecked,
    passedQualityGate: aggregated.passed,
    failedQualityGate: totalChecked - aggregated.passed,
    blockedBeforeUsers: totalChecked - aggregated.passed,
    passRate: totalChecked ? Number(((aggregated.passed / totalChecked) * 100).toFixed(1)) : 0,
    failedByReason: aggregated.failedByReason,
    topReasons: aggregated.topReasons.slice(0, 20).map((item) => ({
      reason: item.reason,
      label: labelQualityGateReason(item.reason),
      strategy: item.strategy,
      timeframe: item.timeframe,
      pair: item.pair,
      count: item.count,
      lastSeenAt: item.last_seen_at
    })),
    recentRejected: recent.rows.map((item) => ({
      pair: item.pair,
      timeframe: item.timeframe,
      direction: item.direction,
      attemptedStrategy: item.attempted_strategy,
      gateStatus: normalizeQualityGateReasonCode(item.rejection_reason || item.gate_status, item.details || {}),
      gateLabel: labelQualityGateReason(item.rejection_reason || item.gate_status),
      rejectionReason: normalizeQualityGateReasonCode(item.rejection_reason || item.gate_status, item.details || {}),
      rejectionLabel: labelQualityGateReason(item.rejection_reason || item.gate_status),
      explanation: item.explanation,
      userExplanation: item.user_explanation,
      rawScore: item.raw_score == null ? null : Number(item.raw_score),
      calibratedConfidence: item.calibrated_confidence == null ? null : Number(item.calibrated_confidence),
      whatWouldImprove: item.details?.checks?.filter?.((check) => check.passed === false).map((check) => check.explanation) || [],
      source: item.source,
      count: Number(item.event_count || 1),
      firstSeenAt: item.first_seen_at,
      lastSeenAt: item.last_seen_at,
      createdAt: item.created_at
    }))
  };
}

export async function enforceSignalQualityGateRetention() {
  const maxRows = Math.max(1000, Number(appConfig.signalQualityGate?.maxDetailRows || 25000));
  const retentionDays = Math.max(1, Number(appConfig.signalQualityGate?.detailRetentionDays || 30));
  await query("DELETE FROM signal_quality_gate_results WHERE created_at < now() - ($1::text || ' days')::interval", [String(retentionDays)]);
  await query(`
    DELETE FROM signal_quality_gate_results
    WHERE id IN (
      SELECT id FROM signal_quality_gate_results
      ORDER BY created_at DESC
      OFFSET $1
    )
  `, [maxRows]);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildQualityGateDedupeKey({ pair, timeframe, direction, strategy, reason, source, date }) {
  const timestamp = new Date(date).getTime();
  const hourBucket = Number.isFinite(timestamp) ? Math.floor(timestamp / 3_600_000) : Math.floor(Date.now() / 3_600_000);
  return [
    pair,
    timeframe,
    direction,
    strategy,
    reason,
    source,
    hourBucket
  ].map((value) => normalizeDedupePart(value)).join(":");
}

function normalizeDedupePart(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function aggregateReasonStats(rows) {
  const reasonGroups = new Map();
  const failedByReason = {
    quarantinedTimeframe: 0,
    lowConfidence: 0,
    duplicateBlocked: 0,
    cooldownBlocked: 0,
    weakStrategyMatch: 0,
    poorEntryQuality: 0,
    invalidStopLoss: 0,
    unrealisticTakeProfit: 0,
    weakRiskReward: 0,
    badMarketRegime: 0,
    historicalUnderperformer: 0,
    similarToPastLosers: 0,
    readinessFailed: 0,
    failedQualityGate: 0
  };
  let passed = 0;

  for (const row of rows) {
    const reason = normalizeQualityGateReasonCode(row.reason);
    const count = Number(row.count || 0);
    if (reason === "quality_gate_passed") {
      passed += count;
      continue;
    }

    const key = `${reason}:${row.strategy || ""}:${row.timeframe || ""}:${row.pair || ""}`;
    const existing = reasonGroups.get(key) || {
      reason,
      strategy: row.strategy,
      timeframe: row.timeframe,
      pair: row.pair,
      count: 0,
      last_seen_at: row.last_seen_at
    };
    existing.count += count;
    if (new Date(row.last_seen_at).getTime() > new Date(existing.last_seen_at).getTime()) {
      existing.last_seen_at = row.last_seen_at;
    }
    reasonGroups.set(key, existing);
    const bucket = reasonToFailedBucket(reason);
    failedByReason[bucket] = Number(failedByReason[bucket] || 0) + count;
  }

  return {
    passed,
    failedByReason,
    topReasons: [...reasonGroups.values()].sort((left, right) =>
      right.count - left.count || new Date(right.last_seen_at).getTime() - new Date(left.last_seen_at).getTime()
    )
  };
}

function reasonToFailedBucket(reason) {
  const mapping = {
    quarantined_timeframe: "quarantinedTimeframe",
    low_confidence: "lowConfidence",
    duplicate_blocked: "duplicateBlocked",
    cooldown_blocked: "cooldownBlocked",
    correlated_duplicate: "duplicateBlocked",
    weak_strategy_match: "weakStrategyMatch",
    breakout_without_retest: "weakStrategyMatch",
    weak_pattern_match: "weakStrategyMatch",
    poor_entry_quality: "poorEntryQuality",
    late_entry: "poorEntryQuality",
    chasing_entry: "poorEntryQuality",
    invalid_stop_loss: "invalidStopLoss",
    unrealistic_take_profit: "unrealisticTakeProfit",
    weak_risk_reward: "weakRiskReward",
    bad_market_regime: "badMarketRegime",
    historical_underperformer: "historicalUnderperformer",
    similar_to_past_losers: "similarToPastLosers",
    readiness_failed: "readinessFailed"
  };
  return mapping[reason] || "failedQualityGate";
}

function normalizeQualityGateReasonCode(reason, gate = {}) {
  const value = normalizeDedupePart(reason);
  if (value === "timeframe" && String(gate.status || "").toLowerCase().includes("quarantined")) return "quarantined_timeframe";
  if (value === "timeframe") return "quarantined_timeframe";
  if (value === "duplicate") return "duplicate_blocked";
  if (value === "cooldown") return "cooldown_blocked";
  if (value === "correlated") return "correlated_duplicate";
  if (value === "readiness") return "readiness_failed";
  if (value === "quarantined-timeframe") return "quarantined_timeframe";
  if (value === "duplicate-blocked") return "duplicate_blocked";
  if (value === "cooldown-blocked") return "cooldown_blocked";
  if (value === "correlated-duplicate") return "correlated_duplicate";
  if (value === "quality-gate-passed") return "quality_gate_passed";
  return value.replace(/-/g, "_");
}

function labelQualityGateReason(reason) {
  const labels = {
    quality_gate_passed: "Quality gate passed",
    quarantined_timeframe: "Quarantined timeframe",
    low_confidence: "Low confidence",
    duplicate_blocked: "Duplicate blocked",
    cooldown_blocked: "Cooldown blocked",
    correlated_duplicate: "Correlated duplicate",
    weak_strategy_match: "Weak strategy match",
    poor_entry_quality: "Poor entry quality",
    invalid_stop_loss: "Invalid stop loss",
    unrealistic_take_profit: "Unrealistic take profit",
    weak_risk_reward: "Weak risk/reward",
    bad_market_regime: "Bad market regime",
    historical_underperformer: "Historical underperformer",
    similar_to_past_losers: "Similar to past losers",
    readiness_failed: "Readiness failed",
    breakout_without_retest: "Breakout without retest",
    late_entry: "Late entry",
    tp_too_far_for_timeframe: "Take profit too far for timeframe",
    tp_blocked_by_resistance: "Take profit blocked by resistance",
    tp_blocked_by_support: "Take profit blocked by support",
    price_already_near_target: "Price already near target",
    no_realistic_target_available: "No realistic target available",
    repaired_take_profit_breaks_rr_requirement: "Repaired target below minimum risk/reward",
    higher_timeframe_conflict: "Higher timeframe conflict",
    repeated_mistake_pattern: "Repeated mistake pattern"
  };
  const normalized = normalizeQualityGateReasonCode(reason);
  return labels[normalized] || normalized.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
