import { appConfig } from "../../config/appConfig.js";
import { query } from "../../db/client.js";
import { createId } from "../../shared/ids.js";

export async function recordSignalQualityGateResult(signal, gate = {}, context = {}) {
  if (!signal || !gate?.version) return null;
  const pair = signal.symbol || signal.pair || "unknown";
  const timeframe = signal.timeframe || "unknown";
  const direction = signal.direction || "unknown";
  const strategy = gate.attemptedStrategy || signal.setupType || signal.strategy || "Unknown strategy";
  const reason = gate.reasonCode || gate.status || "unknown";

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

  await query(`
    INSERT INTO signal_quality_gate_results (
      id, signal_id, candidate_id, pair, timeframe, direction, attempted_strategy,
      gate_status, rejection_reason, explanation, user_explanation, raw_score,
      calibrated_confidence, details, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
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
    JSON.stringify(gate)
  ]);
  await enforceSignalQualityGateRetention();
  return gate;
}

export async function getSignalQualityGateDashboard() {
  const [summary, reasons, recent] = await Promise.all([
    query(`
      SELECT
        COUNT(*)::integer AS total_checked,
        COUNT(*) FILTER (WHERE gate_status = 'passed')::integer AS passed,
        COUNT(*) FILTER (WHERE gate_status <> 'passed')::integer AS failed,
        COUNT(*) FILTER (WHERE gate_status = 'weak_strategy_match')::integer AS weak_strategy_match,
        COUNT(*) FILTER (WHERE gate_status = 'poor_entry_quality')::integer AS poor_entry_quality,
        COUNT(*) FILTER (WHERE gate_status = 'invalid_stop_loss')::integer AS invalid_stop_loss,
        COUNT(*) FILTER (WHERE gate_status = 'unrealistic_take_profit')::integer AS unrealistic_take_profit,
        COUNT(*) FILTER (WHERE gate_status = 'weak_risk_reward')::integer AS weak_risk_reward,
        COUNT(*) FILTER (WHERE gate_status = 'bad_market_regime')::integer AS bad_market_regime,
        COUNT(*) FILTER (WHERE gate_status = 'historical_underperformer')::integer AS historical_underperformer,
        COUNT(*) FILTER (WHERE gate_status = 'similar_to_past_losers')::integer AS similar_to_past_losers
      FROM signal_quality_gate_results
      WHERE created_at >= now() - interval '30 days'
    `),
    query(`
      SELECT reason, strategy, timeframe, pair, count, last_seen_at
      FROM quality_gate_reason_stats
      ORDER BY count DESC, last_seen_at DESC
      LIMIT 20
    `),
    query(`
      SELECT pair, timeframe, direction, attempted_strategy, gate_status,
        rejection_reason, explanation, user_explanation, raw_score,
        calibrated_confidence, details, created_at
      FROM signal_quality_gate_results
      WHERE gate_status <> 'passed'
      ORDER BY created_at DESC
      LIMIT 25
    `)
  ]);
  const row = summary.rows[0] || {};
  return {
    totalSetupsChecked: Number(row.total_checked || 0),
    passedQualityGate: Number(row.passed || 0),
    failedQualityGate: Number(row.failed || 0),
    passRate: Number(row.total_checked || 0) ? Number(((Number(row.passed || 0) / Number(row.total_checked || 1)) * 100).toFixed(1)) : 0,
    failedByReason: {
      weakStrategyMatch: Number(row.weak_strategy_match || 0),
      poorEntryQuality: Number(row.poor_entry_quality || 0),
      invalidStopLoss: Number(row.invalid_stop_loss || 0),
      unrealisticTakeProfit: Number(row.unrealistic_take_profit || 0),
      weakRiskReward: Number(row.weak_risk_reward || 0),
      badMarketRegime: Number(row.bad_market_regime || 0),
      historicalUnderperformer: Number(row.historical_underperformer || 0),
      similarToPastLosers: Number(row.similar_to_past_losers || 0)
    },
    topReasons: reasons.rows.map((item) => ({
      reason: item.reason,
      strategy: item.strategy,
      timeframe: item.timeframe,
      pair: item.pair,
      count: Number(item.count || 0),
      lastSeenAt: item.last_seen_at
    })),
    recentRejected: recent.rows.map((item) => ({
      pair: item.pair,
      timeframe: item.timeframe,
      direction: item.direction,
      attemptedStrategy: item.attempted_strategy,
      gateStatus: item.gate_status,
      rejectionReason: item.rejection_reason,
      explanation: item.explanation,
      userExplanation: item.user_explanation,
      rawScore: item.raw_score == null ? null : Number(item.raw_score),
      calibratedConfidence: item.calibrated_confidence == null ? null : Number(item.calibrated_confidence),
      whatWouldImprove: item.details?.checks?.filter?.((check) => check.passed === false).map((check) => check.explanation) || [],
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
