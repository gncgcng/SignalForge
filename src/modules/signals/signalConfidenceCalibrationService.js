import { query } from "../../db/client.js";

const terminalStatuses = new Set(["Hit TP", "Hit SL", "Expired", "Manually closed"]);
const adminStatuses = new Set(["active", "watchlist", "reduced_confidence", "quarantined", "disabled_by_admin"]);

export function breakEvenWinRate(averageRiskReward) {
  const rr = Number(averageRiskReward || 0);
  if (!Number.isFinite(rr) || rr <= 0) return 0;
  return Number(((1 / (1 + rr)) * 100).toFixed(1));
}

export function calculateClosedWinRate(hitTp, hitSl) {
  const wins = Number(hitTp || 0);
  const losses = Number(hitSl || 0);
  const closed = wins + losses;
  return closed ? Number(((wins / closed) * 100).toFixed(1)) : 0;
}

export function calculateQualityAdjustedScore({ hitTp = 0, hitSl = 0, expired = 0 }) {
  return Number((Number(hitTp || 0) - Number(hitSl || 0) - Number(expired || 0) * 0.35).toFixed(2));
}

export function buildConfidenceBucket(confidence) {
  const score = Number(confidence || 0);
  if (score < 70) return "60-69";
  if (score < 80) return "70-79";
  if (score < 90) return "80-89";
  return "90-100";
}

export function calculateGroupStatus(metrics = {}, override = null) {
  if (override?.status && override.status !== "active") {
    return {
      status: override.status,
      suggestedStatus: override.status,
      penalty: Number(override.penaltyOverride ?? override.penalty_override ?? metrics.penalty ?? 0),
      confidenceCap: override.confidenceCapOverride ?? override.confidence_cap_override ?? metrics.confidenceCap ?? null,
      adminControlled: true
    };
  }

  const closed = Number(metrics.closedSignals || 0);
  const hitSl = Number(metrics.hitSl || 0);
  const expiredRate = Number(metrics.expiredRate || 0);
  const expectancy = Number(metrics.estimatedExpectancy || 0);
  const belowBreakEven = Number(metrics.winRate || 0) < Number(metrics.breakEvenWinRate || 0);
  const confidenceGap = Number(metrics.confidenceGap || 0);
  let status = "active";
  let penalty = 0;
  let confidenceCap = null;

  if (closed >= 10 && belowBreakEven) {
    status = "watchlist";
    penalty = -5;
  }
  if (closed >= 20 && expectancy < 0) {
    status = "reduced_confidence";
    penalty = -10;
  }
  if (closed >= 25 && expectancy < -0.2 && hitSl >= Math.max(12, Number(metrics.hitTp || 0) * 2) && confidenceGap >= 20) {
    status = "quarantined";
    penalty = -15;
    confidenceCap = 72;
  }
  if (expiredRate >= 35 && Number(metrics.totalSignals || 0) >= 10) {
    penalty = Math.min(penalty, -5);
    confidenceCap = Math.min(confidenceCap ?? 99, 78);
  }

  return { status, suggestedStatus: status, penalty, confidenceCap, adminControlled: false };
}

export function calculateGroupMetrics(row = {}) {
  const totalSignals = Number(row.total_signals || 0);
  const hitTp = Number(row.hit_tp || 0);
  const hitSl = Number(row.hit_sl || 0);
  const expired = Number(row.expired || 0);
  const closedSignals = hitTp + hitSl;
  const resolved = closedSignals + expired;
  const averageRiskReward = Number(Number(row.average_rr || 0).toFixed(2));
  const winRate = calculateClosedWinRate(hitTp, hitSl);
  const breakEven = breakEvenWinRate(averageRiskReward);
  const expiredRate = resolved ? Number(((expired / resolved) * 100).toFixed(1)) : 0;
  const averageRealizedR = Number(Number(row.average_realized_r || 0).toFixed(2));
  const estimatedExpectancy = Number((((winRate / 100) * averageRiskReward) - (1 - winRate / 100) - (expiredRate / 100) * 0.35).toFixed(2));
  const averageConfidence = Number(Number(row.average_confidence || 0).toFixed(1));
  const confidenceGap = Number((averageConfidence - winRate).toFixed(1));
  const qualityAdjustedScore = calculateQualityAdjustedScore({ hitTp, hitSl, expired });

  return {
    totalSignals,
    active: Number(row.active || 0),
    hitTp,
    hitSl,
    expired,
    closedSignals,
    winRate,
    expiredRate,
    averageRiskReward,
    averageRealizedR,
    estimatedExpectancy,
    breakEvenWinRate: breakEven,
    belowBreakEven: closedSignals >= 10 && winRate < breakEven,
    averageConfidence,
    confidenceGap,
    qualityAdjustedScore,
    last7Days: Number(row.last_7_days || 0),
    last30Days: Number(row.last_30_days || 0)
  };
}

export async function applyConfidenceCalibration(signal) {
  if (!signal) return signal;
  const context = await getSignalCalibrationContext(signal);
  return applyCalibrationContext(signal, context);
}

export function isSignalBlockedByCalibration(signal) {
  const status = signal?.indicators?.confidenceCalibration?.status;
  return ["quarantined", "disabled_by_admin"].includes(status);
}

export function applyCalibrationContext(signal, context = {}) {
  const originalConfidence = Number(signal.confidenceScore || 0);
  let confidenceCap = 99;
  let penalty = 0;
  const caps = [];
  const penalties = [];

  const addCap = (cap, reason) => {
    if (cap < confidenceCap) confidenceCap = cap;
    caps.push({ cap, reason });
  };
  const addPenalty = (points, reason, group = null) => {
    if (!points) return;
    penalty += Number(points);
    penalties.push({ points: Number(points), reason, group });
  };

  if (context.noHistory) addCap(85, "No generated-signal history yet for this strategy or pair/timeframe.");
  if (hasMissingHigherTimeframe(signal)) addCap(82, "Missing or partial higher-timeframe confirmation.");
  if (hasWeakVolume(signal)) addCap(80, "Weak volume confirmation.");
  if (isChoppy(signal)) addCap(72, "Choppy or ranging market conditions.");
  if (entryReadinessBelowExcellent(signal)) addCap(84, "Entry readiness is below excellent.");
  if (Number(signal.riskRewardRatio || 0) < 2) addCap(82, "Risk/reward is below 2R.");

  const poorGroups = (context.groups || []).filter((group) =>
    group.closedSignals >= 10 &&
    (group.belowBreakEven || Number(group.winRate || 0) < Number(group.breakEvenWinRate || 0))
  );
  const severeStrategy = poorGroups.find((group) => group.groupType === "strategy" && group.closedSignals >= 20 && group.estimatedExpectancy < 0);
  const severePairTimeframe = poorGroups.find((group) => group.groupType === "pair_timeframe" && group.closedSignals >= 20 && group.estimatedExpectancy < 0);
  const quarantined = (context.groups || []).find((group) => ["quarantined", "disabled_by_admin"].includes(group.status));
  const recentPoor = (context.groups || []).find((group) => group.groupType === "recent_strategy" && group.closedSignals >= 5 && group.winRate < group.breakEvenWinRate);
  const expiredHeavy = (context.groups || []).find((group) => group.expiredRate >= 35 && group.totalSignals >= 10);

  for (const group of context.groups || []) {
    if (group.penalty < 0) {
      addPenalty(group.penalty, `${titleCase(group.groupType)} underperformance: ${group.status}.`, group.groupKey);
    }
    if (group.confidenceCap) {
      addCap(group.confidenceCap, `${titleCase(group.groupType)} confidence cap from generated-signal performance.`);
    }
  }
  if (recentPoor) addCap(78, "Recent generated outcomes are below break-even.");
  if (expiredHeavy) addCap(78, "This group has an elevated expired-signal rate.");
  if (severeStrategy) addCap(75, "Strategy has negative generated-signal expectancy.");
  if (severePairTimeframe) addCap(75, "Pair/timeframe has negative generated-signal expectancy.");
  if (severeStrategy && severePairTimeframe) addCap(68, "Strategy and pair/timeframe are both underperforming.");
  if (quarantined) addCap(68, `${titleCase(quarantined.groupType)} is ${quarantined.status}.`);

  const finalConfidence = Math.max(50, Math.min(confidenceCap, originalConfidence + penalty));
  const status = quarantined?.status || (severeStrategy || severePairTimeframe ? "reduced_confidence" : poorGroups.length ? "watchlist" : "active");
  const message = status === "active"
    ? "Confidence reflects rule alignment and historical calibration. It is not a guaranteed win rate."
    : "Confidence was reduced because generated-signal outcomes for similar setups are below calibration thresholds.";

  return {
    ...signal,
    confidenceScore: Math.round(finalConfidence),
    confidenceCalibration: {
      originalConfidence,
      finalConfidence: Math.round(finalConfidence),
      confidenceCap,
      totalPenalty: penalty,
      caps,
      penalties,
      status,
      blocked: ["quarantined", "disabled_by_admin"].includes(status),
      message,
      groups: (context.groups || []).map(summarizeGroupForSignal)
    },
    indicators: {
      ...(signal.indicators || {}),
      confidenceCalibration: {
        originalConfidence,
        finalConfidence: Math.round(finalConfidence),
        confidenceCap,
        totalPenalty: penalty,
        caps,
        penalties,
        status,
        blocked: ["quarantined", "disabled_by_admin"].includes(status),
        message
      },
      confidenceCalibrationMessage: message,
      confidenceCalibrationApplied: true
    }
  };
}

export async function getSignalCalibrationContext(signal) {
  const definitions = buildSignalGroupDefinitions(signal);
  const groups = [];
  for (const definition of definitions) {
    const group = await loadSignalGroup(definition);
    if (group) groups.push(group);
  }
  const hasStrategyHistory = groups.some((group) => group.groupType === "strategy" && group.closedSignals >= 3);
  const hasPairTimeframeHistory = groups.some((group) => group.groupType === "pair_timeframe" && group.closedSignals >= 3);
  return {
    groups,
    noHistory: !hasStrategyHistory || !hasPairTimeframeHistory
  };
}

export async function getAdminSignalQualityBreakdown() {
  const groups = [
    ...(await aggregatePerformanceGroups("strategy", "strategy", "strategy IS NOT NULL")),
    ...(await aggregatePerformanceGroups("pair", "pair", "pair IS NOT NULL")),
    ...(await aggregatePerformanceGroups("timeframe", "timeframe", "timeframe IS NOT NULL")),
    ...(await aggregatePerformanceGroups("direction", "direction", "direction IS NOT NULL")),
    ...(await aggregatePerformanceGroups("pattern", "COALESCE(pattern, 'No pattern')", "true")),
    ...(await aggregatePerformanceGroups("source", "source", "source IS NOT NULL")),
    ...(await aggregatePerformanceGroups("market_regime", "COALESCE(full_analysis->'indicators'->>'regime', 'Unknown')", "true")),
    ...(await aggregatePerformanceGroups("confidence_bucket", confidenceBucketSql(), "true")),
    ...(await aggregatePerformanceGroups("pair_timeframe", "pair || ':' || timeframe", "pair IS NOT NULL AND timeframe IS NOT NULL"))
  ];
  await upsertPerformanceGroups(groups);
  const stats = await getOverallQualityWarning();
  return {
    warning: stats,
    groups,
    worstStrategies: worstGroups(groups, "strategy"),
    worstPairs: worstGroups(groups, "pair"),
    worstTimeframes: worstGroups(groups, "timeframe"),
    worstPairTimeframes: worstGroups(groups, "pair_timeframe"),
    worstDirections: worstGroups(groups, "direction"),
    mostExpiredStrategies: groups.filter((group) => group.groupType === "strategy" && group.totalSignals >= 10).sort((a, b) => b.expiredRate - a.expiredRate).slice(0, 5),
    mostOverconfidentStrategies: groups.filter((group) => group.groupType === "strategy" && group.closedSignals >= 10).sort((a, b) => b.confidenceGap - a.confidenceGap).slice(0, 5),
    confidenceBuckets: groups.filter((group) => group.groupType === "confidence_bucket").sort((a, b) => a.groupValue.localeCompare(b.groupValue))
  };
}

export async function updateSignalGroupStatus({ groupKey, status, adminNote = "", userId = "admin", penaltyOverride = null, confidenceCapOverride = null }) {
  const cleanStatus = adminStatuses.has(status) ? status : "active";
  const [groupType, ...valueParts] = String(groupKey || "").split(":");
  const groupValue = valueParts.join(":") || "unknown";
  const result = await query(`
    INSERT INTO signal_strategy_statuses (
      group_key, group_type, group_value, status, admin_note, penalty_override,
      confidence_cap_override, updated_by, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (group_key) DO UPDATE SET
      status = EXCLUDED.status,
      admin_note = EXCLUDED.admin_note,
      penalty_override = EXCLUDED.penalty_override,
      confidence_cap_override = EXCLUDED.confidence_cap_override,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
    RETURNING *
  `, [
    groupKey,
    groupType || "unknown",
    groupValue,
    cleanStatus,
    String(adminNote || "").slice(0, 500),
    finiteOrNull(penaltyOverride),
    finiteOrNull(confidenceCapOverride),
    userId || "admin"
  ]);
  return result.rows[0];
}

async function loadSignalGroup(definition) {
  const stats = await query(groupStatsSql(definition.where), definition.params);
  const metrics = calculateGroupMetrics(stats.rows[0] || {});
  const groupKey = buildGroupKey(definition.groupType, definition.groupValue);
  const override = await loadStatusOverride(groupKey);
  const status = calculateGroupStatus(metrics, override);
  return {
    groupKey,
    groupType: definition.groupType,
    groupValue: definition.groupValue,
    ...metrics,
    ...status
  };
}

async function aggregatePerformanceGroups(groupType, groupExpression, where = "true") {
  const result = await query(`
    SELECT ${groupExpression} AS group_value,
      COUNT(*)::integer AS total_signals,
      COUNT(*) FILTER (WHERE status = 'Active')::integer AS active,
      COUNT(*) FILTER (WHERE status = 'Hit TP')::integer AS hit_tp,
      COUNT(*) FILTER (WHERE status = 'Hit SL')::integer AS hit_sl,
      COUNT(*) FILTER (WHERE status = 'Expired')::integer AS expired,
      COALESCE(AVG(risk_reward), 0) AS average_rr,
      COALESCE(AVG(confidence), 0) AS average_confidence,
      COALESCE(AVG(CASE WHEN status = 'Hit TP' THEN risk_reward WHEN status = 'Hit SL' THEN -1 WHEN status = 'Expired' THEN -0.35 END), 0) AS average_realized_r,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::integer AS last_7_days,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::integer AS last_30_days
    FROM generated_signals
    WHERE ${where}
    GROUP BY group_value
  `);
  const overrides = await loadStatusOverrides();
  return result.rows
    .filter((row) => String(row.group_value || "").trim())
    .map((row) => {
      const groupValue = String(row.group_value);
      const groupKey = buildGroupKey(groupType, groupValue);
      const metrics = calculateGroupMetrics(row);
      const status = calculateGroupStatus(metrics, overrides.get(groupKey));
      return { groupKey, groupType, groupValue, ...metrics, ...status };
    });
}

async function upsertPerformanceGroups(groups = []) {
  for (const group of groups) {
    await query(`
      INSERT INTO signal_performance_groups (
        id, group_key, group_type, group_value, total_signals, active, hit_tp, hit_sl,
        expired, closed_signals, win_rate, expired_rate, average_rr, average_realized_r,
        estimated_expectancy, average_confidence, confidence_gap, break_even_win_rate,
        quality_adjusted_score, status, suggested_status, penalty, confidence_cap, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,now())
      ON CONFLICT (group_key) DO UPDATE SET
        total_signals = EXCLUDED.total_signals,
        active = EXCLUDED.active,
        hit_tp = EXCLUDED.hit_tp,
        hit_sl = EXCLUDED.hit_sl,
        expired = EXCLUDED.expired,
        closed_signals = EXCLUDED.closed_signals,
        win_rate = EXCLUDED.win_rate,
        expired_rate = EXCLUDED.expired_rate,
        average_rr = EXCLUDED.average_rr,
        average_realized_r = EXCLUDED.average_realized_r,
        estimated_expectancy = EXCLUDED.estimated_expectancy,
        average_confidence = EXCLUDED.average_confidence,
        confidence_gap = EXCLUDED.confidence_gap,
        break_even_win_rate = EXCLUDED.break_even_win_rate,
        quality_adjusted_score = EXCLUDED.quality_adjusted_score,
        status = EXCLUDED.status,
        suggested_status = EXCLUDED.suggested_status,
        penalty = EXCLUDED.penalty,
        confidence_cap = EXCLUDED.confidence_cap,
        updated_at = now()
    `, [
      `sgp_${hash(group.groupKey)}`,
      group.groupKey,
      group.groupType,
      group.groupValue,
      group.totalSignals,
      group.active,
      group.hitTp,
      group.hitSl,
      group.expired,
      group.closedSignals,
      group.winRate,
      group.expiredRate,
      group.averageRiskReward,
      group.averageRealizedR,
      group.estimatedExpectancy,
      group.averageConfidence,
      group.confidenceGap,
      group.breakEvenWinRate,
      group.qualityAdjustedScore,
      group.status,
      group.suggestedStatus,
      group.penalty,
      group.confidenceCap
    ]);
  }
}

async function getOverallQualityWarning() {
  const result = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'Hit TP')::integer AS hit_tp,
      COUNT(*) FILTER (WHERE status = 'Hit SL')::integer AS hit_sl,
      COUNT(*) FILTER (WHERE status = 'Expired')::integer AS expired,
      COALESCE(AVG(risk_reward), 0) AS average_rr,
      COALESCE(AVG(confidence), 0) AS average_confidence
    FROM generated_signals
    WHERE status IN ('Hit TP', 'Hit SL', 'Expired')
  `);
  const metrics = calculateGroupMetrics({ ...result.rows[0], total_signals: Number(result.rows[0]?.hit_tp || 0) + Number(result.rows[0]?.hit_sl || 0) + Number(result.rows[0]?.expired || 0) });
  const warning = metrics.averageConfidence > 85 && metrics.closedSignals >= 20 && metrics.winRate < metrics.breakEvenWinRate;
  return {
    active: warning,
    message: warning
      ? "Signal quality warning: average confidence is high, but realized performance is below break-even. Review strategy calibration before promoting these signals."
      : "",
    ...metrics
  };
}

async function loadStatusOverride(groupKey) {
  const result = await query("SELECT * FROM signal_strategy_statuses WHERE group_key = $1 LIMIT 1", [groupKey]);
  return result.rows[0] || null;
}

async function loadStatusOverrides() {
  const result = await query("SELECT * FROM signal_strategy_statuses");
  return new Map(result.rows.map((row) => [row.group_key, row]));
}

function buildSignalGroupDefinitions(signal) {
  const strategy = signal.setupType || "Unknown strategy";
  const pair = signal.symbol || signal.pair || "unknown";
  const timeframe = signal.timeframe || "unknown";
  const direction = signal.direction || "unknown";
  const pattern = signal.patternContext?.pattern || signal.indicators?.patternContext?.pattern || "";
  return [
    { groupType: "strategy", groupValue: strategy, where: "strategy = $1", params: [strategy] },
    { groupType: "pair_timeframe", groupValue: `${pair}:${timeframe}`, where: "pair = $1 AND timeframe = $2", params: [pair, timeframe] },
    { groupType: "pair", groupValue: pair, where: "pair = $1", params: [pair] },
    { groupType: "timeframe", groupValue: timeframe, where: "timeframe = $1", params: [timeframe] },
    { groupType: "direction", groupValue: direction, where: "direction = $1", params: [direction] },
    { groupType: "recent_strategy", groupValue: strategy, where: "strategy = $1 AND created_at >= now() - interval '7 days'", params: [strategy] },
    ...(pattern ? [{ groupType: "pattern", groupValue: pattern, where: "pattern = $1", params: [pattern] }] : [])
  ];
}

function groupStatsSql(where) {
  return `
    SELECT COUNT(*)::integer AS total_signals,
      COUNT(*) FILTER (WHERE status = 'Active')::integer AS active,
      COUNT(*) FILTER (WHERE status = 'Hit TP')::integer AS hit_tp,
      COUNT(*) FILTER (WHERE status = 'Hit SL')::integer AS hit_sl,
      COUNT(*) FILTER (WHERE status = 'Expired')::integer AS expired,
      COALESCE(AVG(risk_reward), 0) AS average_rr,
      COALESCE(AVG(confidence), 0) AS average_confidence,
      COALESCE(AVG(CASE WHEN status = 'Hit TP' THEN risk_reward WHEN status = 'Hit SL' THEN -1 WHEN status = 'Expired' THEN -0.35 END), 0) AS average_realized_r,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::integer AS last_7_days,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::integer AS last_30_days
    FROM generated_signals
    WHERE ${where}
  `;
}

function confidenceBucketSql() {
  return "CASE WHEN confidence < 70 THEN '60-69' WHEN confidence < 80 THEN '70-79' WHEN confidence < 90 THEN '80-89' ELSE '90-100' END";
}

function worstGroups(groups, type) {
  return groups
    .filter((group) => group.groupType === type && group.closedSignals >= 10)
    .sort((a, b) => a.estimatedExpectancy - b.estimatedExpectancy || a.winRate - b.winRate || b.hitSl - a.hitSl)
    .slice(0, 5);
}

function summarizeGroupForSignal(group) {
  return {
    groupKey: group.groupKey,
    groupType: group.groupType,
    groupValue: group.groupValue,
    closedSignals: group.closedSignals,
    winRate: group.winRate,
    breakEvenWinRate: group.breakEvenWinRate,
    estimatedExpectancy: group.estimatedExpectancy,
    expiredRate: group.expiredRate,
    status: group.status,
    penalty: group.penalty,
    confidenceCap: group.confidenceCap
  };
}

function hasMissingHigherTimeframe(signal) {
  const badge = String(signal.alignmentBadge || signal.indicators?.alignmentBadge || "");
  const score = Number(signal.confluenceScore ?? signal.indicators?.confluenceScore ?? 0);
  return badge !== "Full Alignment" || score < 70;
}

function hasWeakVolume(signal) {
  const volume = (signal.confirmations || []).find((item) => String(item.name || "").toLowerCase().includes("volume"));
  if (!volume) return false;
  return !volume.passed;
}

function isChoppy(signal) {
  const regime = String(signal.regime || signal.indicators?.regime || "").toLowerCase();
  return regime.includes("range") || regime.includes("choppy") || signal.indicators?.choppy === true;
}

function entryReadinessBelowExcellent(signal) {
  const quality = String(signal.entryQuality || signal.indicators?.entryQuality || "").toLowerCase();
  const readiness = Number(signal.readinessScore ?? signal.indicators?.readinessScore ?? 0);
  return quality !== "excellent" || (Number.isFinite(readiness) && readiness > 0 && readiness < 90);
}

function buildGroupKey(type, value) {
  return `${type}:${String(value || "unknown").toLowerCase().replace(/[^a-z0-9:_-]+/g, "-")}`;
}

function titleCase(value) {
  return String(value || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hash(value) {
  let result = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    result = ((result << 5) - result + text.charCodeAt(index)) | 0;
  }
  return Math.abs(result).toString(16);
}
