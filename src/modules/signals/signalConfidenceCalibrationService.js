import { query } from "../../db/client.js";

const terminalStatuses = new Set(["Hit TP", "Hit SL", "Expired", "Manually closed"]);
const adminStatuses = new Set(["active", "watchlist", "reduced_confidence", "quarantined", "disabled_by_admin"]);
const HIGH_CONFIDENCE_EXPECTANCY_CAP = 88;
const EXACT_SOURCE_STRATEGY_TIMEFRAME_MIN_CLOSED = 20;
const CONFIDENCE_CALIBRATION_VERSION = "calibration_v2";
const SAMPLE_SMALL = "Small sample size. Do not trust this result yet.";
const SAMPLE_EARLY = "Early data. Calibration may change.";
const CONFIDENCE_COPY = "Confidence reflects setup alignment after historical calibration. It is not a guaranteed win rate.";
const CONFIDENCE_WARNING_COPY = "Confidence calibration warning: higher confidence buckets are not outperforming lower buckets. Confidence should be tightened before promotion.";

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
  if (
    override?.status &&
    (override.status !== "active" ||
      override.penaltyOverride !== undefined ||
      override.penalty_override !== null ||
      override.confidenceCapOverride !== undefined ||
      override.confidence_cap_override !== null)
  ) {
    return {
      status: override.status,
      suggestedStatus: override.status,
      penalty: Number(override.penaltyOverride ?? override.penalty_override ?? metrics.penalty ?? 0),
      confidenceCap: override.confidenceCapOverride ?? override.confidence_cap_override ?? metrics.confidenceCap ?? null,
      confidenceCapLift: 0,
      performanceLabel: override.status === "active" ? "Above break-even" : titleCase(override.status),
      recommendedAction: override.status === "active" ? "Keep active" : "Admin override",
      adminControlled: true
    };
  }

  const closed = Number(metrics.closedSignals || 0);
  const hitSl = Number(metrics.hitSl || 0);
  const expiredRate = Number(metrics.expiredRate || 0);
  const expectancy = Number(metrics.estimatedExpectancy || 0);
  const belowBreakEven = Number(metrics.winRate || 0) < Number(metrics.breakEvenWinRate || 0);
  const confidenceGap = Number(metrics.confidenceGap || 0);
  const aboveBreakEven = Number(metrics.winRate || 0) >= Number(metrics.breakEvenWinRate || 0);
  let status = "active";
  let penalty = 0;
  let confidenceCap = null;
  let performanceLabel = closed < 5 ? "Needs more data" : "Above break-even";
  let recommendedAction = closed < 5 ? "Watchlist" : "Keep active";
  let confidenceCapLift = 0;

  if (closed >= 10 && belowBreakEven) {
    status = "watchlist";
    penalty = -5;
    confidenceCap = Math.min(confidenceCap ?? 99, 82);
    performanceLabel = "Underperforming";
    recommendedAction = "Watchlist";
  }
  if (closed >= 20 && expectancy < 0) {
    status = "reduced_confidence";
    penalty = -10;
    confidenceCap = Math.min(confidenceCap ?? 99, 75);
    performanceLabel = "Reduced confidence";
    recommendedAction = "Reduce confidence";
  }
  if (closed >= 20 && expectancy <= -0.5) {
    confidenceCap = Math.min(confidenceCap ?? 99, 68);
  }
  if (closed >= 25 && expectancy < -0.2 && hitSl >= Math.max(12, Number(metrics.hitTp || 0) * 2) && confidenceGap >= 20) {
    status = "quarantined";
    penalty = -15;
    confidenceCap = Math.min(confidenceCap ?? 99, 68);
    performanceLabel = "Quarantined";
    recommendedAction = "Quarantine";
  }
  if (expiredRate > 25 && Number(metrics.totalSignals || 0) >= 10) {
    penalty = Math.min(penalty, -5);
    confidenceCap = Math.min(confidenceCap ?? 99, 78);
    if (status === "active") {
      performanceLabel = "Expired-heavy";
      recommendedAction = "Watchlist";
    }
  }
  if (status === "active" && closed >= 5 && aboveBreakEven && expectancy > 0) {
    performanceLabel = closed >= 10 ? "Strong performer" : "Promising";
    recommendedAction = closed >= 20
      ? "Trust more"
      : "Keep active";
    confidenceCapLift = closed >= 30 && expectancy >= 0.25 ? 5 : closed >= 20 ? 3 : 0;
  }
  if (status === "active" && closed >= 10 && aboveBreakEven && expectancy > 0 && Number(metrics.averageConfidence || 0) <= 80) {
    recommendedAction = "Increase confidence carefully";
  }

  return {
    status,
    suggestedStatus: status,
    penalty,
    confidenceCap,
    confidenceCapLift,
    performanceLabel,
    recommendedAction,
    adminControlled: false
  };
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
  const rawSetupScore = originalConfidence;
  let ruleCap = 99;
  let historicalCap = context.noHistory ? 85 : 99;
  let expectancyCap = HIGH_CONFIDENCE_EXPECTANCY_CAP;
  let penalty = 0;
  const caps = [];
  const penalties = [];
  const capRecovery = [];

  const addCap = (cap, reason, type = "rule") => {
    if (type === "historical") {
      if (cap < historicalCap) historicalCap = cap;
    } else if (cap < ruleCap) {
      ruleCap = cap;
    }
    caps.push({ cap, reason, type });
  };
  const addPenalty = (points, reason, group = null) => {
    if (!points) return;
    penalty += Number(points);
    penalties.push({ points: Number(points), reason, group });
  };

  if (context.noHistory) caps.push({ cap: 85, reason: "No generated-signal history yet for this strategy or pair/timeframe.", type: "historical" });
  const timeframePolicy = getStaticTimeframePolicy(signal.timeframe);
  if (timeframePolicy.confidenceCap) addCap(timeframePolicy.confidenceCap, timeframePolicy.reason, "historical");
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
  const positiveGroups = (context.groups || []).filter((group) =>
    group.closedSignals >= 20 &&
    Number(group.estimatedExpectancy || 0) > 0 &&
    Number(group.winRate || 0) >= Number(group.breakEvenWinRate || 0)
  );
  const exactPositiveGroup = findProvenExactSourceStrategyTimeframe(context.groups || []);
  const eliteConfidenceAllowed = canAllowEliteConfidence(signal, context.groups || [], exactPositiveGroup);

  if (exactPositiveGroup && eliteConfidenceAllowed) {
    expectancyCap = 99;
    capRecovery.push({
      cap: 99,
      reason: `Exact source, strategy, and timeframe has positive expectancy over ${exactPositiveGroup.closedSignals} closed signals.`
    });
  } else {
    caps.push({
      cap: HIGH_CONFIDENCE_EXPECTANCY_CAP,
      reason: `Confidence above ${HIGH_CONFIDENCE_EXPECTANCY_CAP}% requires monotonic high-confidence bucket performance, positive expectancy from at least ${EXACT_SOURCE_STRATEGY_TIMEFRAME_MIN_CLOSED} exact source/strategy/timeframe closed signals, and no quarantine or red flags.`,
      type: "historical"
    });
  }

  for (const group of context.groups || []) {
    if (group.penalty < 0) {
      addPenalty(group.penalty, `${titleCase(group.groupType)} underperformance: ${group.status}.`, group.groupKey);
    }
    if (group.confidenceCap) {
      addCap(group.confidenceCap, `${titleCase(group.groupType)} confidence cap from generated-signal performance.`, "historical");
    }
    if (Number(group.closedSignals || 0) >= 10 && Number(group.winRate || 0) < Number(group.breakEvenWinRate || 0)) {
      addCap(82, `${titleCase(group.groupType)} is below break-even with enough closed signals.`, "historical");
    }
    if (Number(group.closedSignals || 0) >= 20 && Number(group.estimatedExpectancy || 0) < 0) {
      addCap(75, `${titleCase(group.groupType)} has negative expectancy over 20+ closed signals.`, "historical");
    }
    if (Number(group.closedSignals || 0) >= 20 && Number(group.estimatedExpectancy || 0) <= -0.5) {
      addCap(68, `${titleCase(group.groupType)} has very negative expectancy.`, "historical");
    }
    if (Number(group.expiredRate || 0) > 25 && Number(group.totalSignals || 0) >= 10) {
      addCap(78, `${titleCase(group.groupType)} has more than 25% expired outcomes.`, "historical");
    }
  }
  if (recentPoor) addCap(78, "Recent generated outcomes are below break-even.", "historical");
  if (expiredHeavy) addCap(78, "This group has an elevated expired-signal rate.", "historical");
  if (severeStrategy) addCap(75, "Strategy has negative generated-signal expectancy.", "historical");
  if (severePairTimeframe) addCap(75, "Pair/timeframe has negative generated-signal expectancy.", "historical");
  if (severeStrategy && severePairTimeframe) addCap(68, "Strategy and pair/timeframe are both underperforming.", "historical");
  if (quarantined) addCap(68, `${titleCase(quarantined.groupType)} is ${quarantined.status}.`, "historical");

  const strongestPositive = positiveGroups
    .sort((a, b) => b.confidenceCapLift - a.confidenceCapLift || b.estimatedExpectancy - a.estimatedExpectancy)[0];
  if (strongestPositive && !poorGroups.length && !quarantined && !expiredHeavy) {
    const recoveryTarget = strongestPositive.confidenceCapLift >= 5 ? 92 : 88;
    if (historicalCap < recoveryTarget) {
      historicalCap = recoveryTarget;
      capRecovery.push({
        cap: recoveryTarget,
        reason: `${titleCase(strongestPositive.groupType)} has positive expectancy over ${strongestPositive.closedSignals} closed signals.`
      });
    }
  }

  const confidenceCap = Math.min(ruleCap, historicalCap, expectancyCap);
  const finalConfidence = Math.max(50, Math.min(confidenceCap, originalConfidence + penalty));
  const status = quarantined?.status || (severeStrategy || severePairTimeframe ? "reduced_confidence" : poorGroups.length ? "watchlist" : "active");
  const calibrationReason = status === "active"
    ? CONFIDENCE_COPY
    : "Confidence was reduced because generated-signal outcomes for similar setups are below calibration thresholds.";
  const roundedFinalConfidence = Math.round(finalConfidence);
  const calibrationPayload = {
    version: CONFIDENCE_CALIBRATION_VERSION,
    rawSetupScore,
    originalConfidence,
    calibratedConfidence: roundedFinalConfidence,
    finalConfidence: roundedFinalConfidence,
    confidenceCap,
    totalPenalty: penalty,
    caps,
    capRecovery,
    penalties,
    status,
    label: confidenceQualityLabel(roundedFinalConfidence, status),
    blocked: ["quarantined", "disabled_by_admin"].includes(status),
    calibrationReason,
    message: CONFIDENCE_COPY,
    groups: (context.groups || []).map(summarizeGroupForSignal)
  };

  return {
    ...signal,
    confidenceScore: roundedFinalConfidence,
    calibratedConfidence: roundedFinalConfidence,
    rawSetupScore,
    confidenceVersion: CONFIDENCE_CALIBRATION_VERSION,
    calibrationReason,
    confidenceCalibration: calibrationPayload,
    indicators: {
      ...(signal.indicators || {}),
      confidenceCalibration: calibrationPayload,
      confidenceCalibrationMessage: CONFIDENCE_COPY,
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
  const hasExactSourceStrategyTimeframeHistory = groups.some((group) =>
    group.groupType === "source_strategy_timeframe" && group.closedSignals >= 3
  );
  return {
    groups,
    noHistory: !hasExactSourceStrategyTimeframeHistory
  };
}

export async function getAdminSignalQualityBreakdown(scope = "current") {
  const groups = [
    ...(await aggregatePerformanceGroups("strategy", "strategy", "strategy IS NOT NULL", scope)),
    ...(await aggregatePerformanceGroups("pair", "pair", "pair IS NOT NULL", scope)),
    ...(await aggregatePerformanceGroups("timeframe", "timeframe", "timeframe IS NOT NULL", scope)),
    ...(await aggregatePerformanceGroups("direction", "direction", "direction IS NOT NULL", scope)),
    ...(await aggregatePerformanceGroups("pattern", "COALESCE(pattern, 'No pattern')", "true", scope)),
    ...(await aggregatePerformanceGroups("source", "source", "source IS NOT NULL", scope)),
    ...(await aggregatePerformanceGroups("market_regime", "COALESCE(full_analysis->'indicators'->>'regime', 'Unknown')", "true", scope)),
    ...(await aggregatePerformanceGroups("confidence_bucket", confidenceBucketSql(), "true", scope)),
    ...(await aggregatePerformanceGroups("pair_timeframe", "pair || ':' || timeframe", "pair IS NOT NULL AND timeframe IS NOT NULL", scope))
  ];
  await upsertPerformanceGroups(groups);
  const stats = await getOverallQualityWarning(scope);
  const bestStrategies = bestGroups(groups, "strategy");
  const bestPairTimeframes = bestGroups(groups, "pair_timeframe");
  const bestPairs = bestGroups(groups, "pair");
  const bestTimeframes = bestGroups(groups, "timeframe");
  const bestDirections = bestGroups(groups, "direction");
  const bestPatterns = bestGroups(groups, "pattern");
  const bestConfidenceBuckets = bestGroups(groups, "confidence_bucket");
  const bestMarketRegimes = bestGroups(groups, "market_regime");
  const bestSources = bestGroups(groups, "source");
  const worstStrategies = worstGroups(groups, "strategy");
  const worstPairTimeframes = worstGroups(groups, "pair_timeframe");
  const worstPairs = worstGroups(groups, "pair");
  const worstTimeframes = worstGroups(groups, "timeframe");
  const worstDirections = worstGroups(groups, "direction");
  const worstPatterns = worstGroups(groups, "pattern");
  const underconfident = underconfidentWinners(groups);
  const overconfident = groups.filter((group) => group.groupType === "strategy" && group.closedSignals >= 10).sort((a, b) => b.confidenceGap - a.confidenceGap).slice(0, 5);
  const confidenceBuckets = groups.filter((group) => group.groupType === "confidence_bucket").sort((a, b) => a.groupValue.localeCompare(b.groupValue));
  const calibrationSummary = analyzeConfidenceBucketCalibration(confidenceBuckets);
  return {
    warning: stats,
    calibrationSummary,
    scope: normalizeStatsScope(scope),
    summary: buildBestWorstSummary({
      bestStrategies,
      bestPairTimeframes,
      worstStrategies,
      worstPairTimeframes,
      overconfident,
      underconfident
    }),
    groups,
    bestStrategies,
    bestPairTimeframes,
    bestPairs,
    bestTimeframes,
    bestDirections,
    bestPatterns,
    bestConfidenceBuckets,
    bestMarketRegimes,
    bestSources,
    worstStrategies,
    worstPairs,
    worstTimeframes,
    worstPairTimeframes,
    worstDirections,
    worstPatterns,
    mostExpiredStrategies: groups.filter((group) => group.groupType === "strategy" && group.totalSignals >= 10).sort((a, b) => b.expiredRate - a.expiredRate).slice(0, 5),
    mostOverconfidentStrategies: overconfident,
    underconfidentWinners: underconfident,
    mostReliableStrategies: bestStrategies,
    confidenceBuckets
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

async function aggregatePerformanceGroups(groupType, groupExpression, where = "true", scope = "current") {
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
    WHERE ${where} AND ${statsScopeSql(scope)}
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

export function analyzeConfidenceBucketCalibration(bucketGroups = []) {
  const byBucket = new Map((bucketGroups || []).map((group) => [group.groupValue, group]));
  const mid = byBucket.get("80-89");
  const high = byBucket.get("90-100");
  const good = byBucket.get("70-79");
  const warnings = [];
  const enoughBucketSamples = Boolean(
    good && mid && high &&
    Number(good.closedSignals || 0) >= 10 &&
    Number(mid.closedSignals || 0) >= 10 &&
    Number(high.closedSignals || 0) >= 10
  );
  const beats = (upper, lower) => {
    if (!upper || !lower) return true;
    if (Number(upper.closedSignals || 0) < 10 || Number(lower.closedSignals || 0) < 10) return true;
    return Number(upper.estimatedExpectancy || 0) > Number(lower.estimatedExpectancy || 0) &&
      Number(upper.winRate || 0) >= Number(lower.winRate || 0);
  };
  if (!beats(high, mid)) warnings.push("90-100 is not outperforming 80-89.");
  if (!beats(mid, good)) warnings.push("80-89 is not outperforming 70-79.");
  if (high && Number(high.closedSignals || 0) >= 10 && Number(high.winRate || 0) < Number(high.breakEvenWinRate || 0)) {
    warnings.push("90-100 is below break-even.");
  }
  const sampled = bucketGroups.filter((group) => Number(group.closedSignals || 0) >= 10);
  const worstBucket = sampled.slice().sort((a, b) => Number(a.estimatedExpectancy || 0) - Number(b.estimatedExpectancy || 0))[0] || null;
  const mostOverconfidentBucket = sampled.slice().sort((a, b) => Number(b.confidenceGap || 0) - Number(a.confidenceGap || 0))[0] || null;
  return {
    calibrated: !warnings.length && enoughBucketSamples,
    higherBucketsOutperforming: !warnings.length,
    active: Boolean(warnings.length),
    message: warnings.length
      ? CONFIDENCE_WARNING_COPY
      : enoughBucketSamples
        ? "Confidence buckets are monotonic across current-engine closed outcomes."
        : "Confidence buckets do not have enough closed samples yet.",
    details: warnings,
    worstBucket: worstBucket ? summarizeGroupForSignal(worstBucket) : null,
    mostOverconfidentBucket: mostOverconfidentBucket ? summarizeGroupForSignal(mostOverconfidentBucket) : null,
    recommendedAction: warnings.length
      ? "Keep future confidence capped at 88 and tighten promotion until higher buckets outperform lower buckets."
      : "Keep collecting closed outcomes before allowing wider confidence ranges."
  };
}

async function getOverallQualityWarning(scope = "current") {
  const result = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'Hit TP')::integer AS hit_tp,
      COUNT(*) FILTER (WHERE status = 'Hit SL')::integer AS hit_sl,
      COUNT(*) FILTER (WHERE status = 'Expired')::integer AS expired,
      COALESCE(AVG(risk_reward), 0) AS average_rr,
      COALESCE(AVG(confidence), 0) AS average_confidence
    FROM generated_signals
    WHERE status IN ('Hit TP', 'Hit SL', 'Expired') AND ${statsScopeSql(scope)}
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
  const source = signal.generationSource || signal.source || signal.indicators?.generationSource || "manual_scan";
  const pattern = signal.patternContext?.pattern || signal.indicators?.patternContext?.pattern || "";
  const confidenceBucket = buildConfidenceBucket(signal.confidenceScore);
  return [
    { groupType: "source_strategy_timeframe", groupValue: `${source}:${strategy}:${timeframe}`, where: "source = $1 AND strategy = $2 AND timeframe = $3", params: [source, strategy, timeframe] },
    { groupType: "strategy", groupValue: strategy, where: "strategy = $1", params: [strategy] },
    { groupType: "pair_timeframe", groupValue: `${pair}:${timeframe}`, where: "pair = $1 AND timeframe = $2", params: [pair, timeframe] },
    { groupType: "pair", groupValue: pair, where: "pair = $1", params: [pair] },
    { groupType: "timeframe", groupValue: timeframe, where: "timeframe = $1", params: [timeframe] },
    { groupType: "direction", groupValue: direction, where: "direction = $1", params: [direction] },
    { groupType: "confidence_bucket", groupValue: confidenceBucket, where: `${confidenceBucketSql()} = $1`, params: [confidenceBucket] },
    { groupType: "recent_strategy", groupValue: strategy, where: "strategy = $1 AND created_at >= now() - interval '7 days'", params: [strategy] },
    ...(pattern ? [{ groupType: "pattern", groupValue: pattern, where: "pattern = $1", params: [pattern] }] : [])
  ];
}

function findProvenExactSourceStrategyTimeframe(groups = []) {
  return groups.find((group) =>
    group.groupType === "source_strategy_timeframe" &&
    Number(group.closedSignals || 0) >= EXACT_SOURCE_STRATEGY_TIMEFRAME_MIN_CLOSED &&
    Number(group.estimatedExpectancy || 0) > 0 &&
    Number(group.winRate || 0) >= Number(group.breakEvenWinRate || 0)
  ) || null;
}

function canAllowEliteConfidence(signal, groups = [], exactPositiveGroup = null) {
  if (!exactPositiveGroup) return false;
  if (Number(signal.readinessScore ?? signal.indicators?.readinessScore ?? 0) <= 0) return false;
  if (["5m", "1h"].includes(signal.timeframe)) return false;
  if (Number(signal.riskRewardRatio || 0) < 1.5) return false;
  if (hasMissingHigherTimeframe(signal) || hasWeakVolume(signal) || isChoppy(signal) || entryReadinessBelowExcellent(signal)) return false;
  const bucket = groups.find((group) => group.groupType === "confidence_bucket" && group.groupValue === "90-100");
  if (!bucket || Number(bucket.closedSignals || 0) < 10) return false;
  if (Number(bucket.winRate || 0) < Number(bucket.breakEvenWinRate || 0)) return false;
  if (Number(bucket.estimatedExpectancy || 0) <= 0 || Number(bucket.expiredRate || 0) >= 15) return false;
  const strategy = groups.find((group) => group.groupType === "strategy");
  if (!strategy || Number(strategy.closedSignals || 0) < 20 || Number(strategy.estimatedExpectancy || 0) <= 0) return false;
  const pairTimeframe = groups.find((group) => group.groupType === "pair_timeframe");
  if (pairTimeframe && Number(pairTimeframe.closedSignals || 0) >= 20 && Number(pairTimeframe.estimatedExpectancy || 0) <= 0) return false;
  return !groups.some((group) => ["quarantined", "disabled_by_admin", "reduced_confidence"].includes(group.status));
}

function getStaticTimeframePolicy(timeframe) {
  if (timeframe === "5m" || timeframe === "1h") {
    return { confidenceCap: 72, reason: `${timeframe} generated signals are quarantined and capped at 72%.` };
  }
  if (timeframe === "15m") {
    return { confidenceCap: 88, reason: "15m confidence is capped below 90 until stronger current-engine performance develops." };
  }
  if (timeframe === "4h") {
    return { confidenceCap: 88, reason: "4h confidence is capped while it remains watchlist/promising." };
  }
  return { confidenceCap: null, reason: "" };
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
    WHERE ${where} AND ${statsScopeSql("current")}
  `;
}

function statsScopeSql(scope = "current") {
  const normalized = normalizeStatsScope(scope);
  if (normalized === "legacy") return "source IN ('legacy_saved_signal','legacy_unlocked_signal')";
  if (normalized === "all") return "true";
  return "source NOT IN ('legacy_saved_signal','legacy_unlocked_signal')";
}

function normalizeStatsScope(scope = "current") {
  return ["current", "legacy", "all"].includes(scope) ? scope : "current";
}

function confidenceBucketSql() {
  return "CASE WHEN COALESCE(calibrated_confidence, confidence) < 70 THEN '60-69' WHEN COALESCE(calibrated_confidence, confidence) < 80 THEN '70-79' WHEN COALESCE(calibrated_confidence, confidence) < 90 THEN '80-89' ELSE '90-100' END";
}

function worstGroups(groups, type) {
  return groups
    .filter((group) => group.groupType === type && group.closedSignals >= 10)
    .sort((a, b) => a.estimatedExpectancy - b.estimatedExpectancy || a.winRate - b.winRate || b.hitSl - a.hitSl)
    .slice(0, 5);
}

export function bestGroups(groups, type) {
  return groups
    .filter((group) =>
      group.groupType === type &&
      group.closedSignals >= 5 &&
      Number(group.estimatedExpectancy || 0) > 0 &&
      Number(group.winRate || 0) >= Number(group.breakEvenWinRate || 0)
    )
    .sort(bestGroupSort)
    .slice(0, 5);
}

export function underconfidentWinners(groups) {
  return groups
    .filter((group) =>
      group.closedSignals >= 10 &&
      Number(group.estimatedExpectancy || 0) > 0 &&
      Number(group.winRate || 0) >= Number(group.breakEvenWinRate || 0) + 5 &&
      Number(group.averageConfidence || 0) <= 80
    )
    .sort(bestGroupSort)
    .slice(0, 5);
}

function bestGroupSort(a, b) {
  const aEdge = Number(a.winRate || 0) - Number(a.breakEvenWinRate || 0);
  const bEdge = Number(b.winRate || 0) - Number(b.breakEvenWinRate || 0);
  return Number(b.estimatedExpectancy || 0) - Number(a.estimatedExpectancy || 0) ||
    bEdge - aEdge ||
    Number(a.expiredRate || 0) - Number(b.expiredRate || 0) ||
    Number(b.closedSignals || 0) - Number(a.closedSignals || 0) ||
    Math.abs(Number(a.confidenceGap || 0)) - Math.abs(Number(b.confidenceGap || 0));
}

function buildBestWorstSummary({ bestStrategies, bestPairTimeframes, worstStrategies, worstPairTimeframes, overconfident, underconfident }) {
  const best = [bestStrategies?.[0], bestPairTimeframes?.[0]].filter(Boolean).sort(bestGroupSort)[0] || null;
  const worst = [worstStrategies?.[0], worstPairTimeframes?.[0]]
    .filter(Boolean)
    .sort((a, b) => Number(a.estimatedExpectancy || 0) - Number(b.estimatedExpectancy || 0))[0] || null;
  return {
    bestPerformer: best,
    worstPerformer: worst,
    overconfidenceWarning: overconfident?.[0] || null,
    opportunity: underconfident?.[0] || null
  };
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
    averageRiskReward: group.averageRiskReward,
    averageConfidence: group.averageConfidence,
    confidenceGap: group.confidenceGap,
    sampleSizeStatus: sampleSizeStatusForGroup(group),
    calibrationStatus: calibrationStatusForGroup(group),
    performanceLabel: group.performanceLabel,
    recommendedAction: group.recommendedAction,
    confidenceCapLift: group.confidenceCapLift,
    status: group.status,
    penalty: group.penalty,
    confidenceCap: group.confidenceCap
  };
}

export function sampleSizeStatusForGroup(group = {}) {
  const closed = Number(group.closedSignals || 0);
  if (closed < 10) return SAMPLE_SMALL;
  if (closed < 20) return SAMPLE_EARLY;
  return "Enough closed samples for calibration.";
}

export function calibrationStatusForGroup(group = {}) {
  if (["quarantined", "disabled_by_admin"].includes(group.status)) return group.status === "quarantined" ? "Quarantined" : "Disabled by admin";
  if (Number(group.closedSignals || 0) < 10) return "Needs more data";
  if (Number(group.winRate || 0) < Number(group.breakEvenWinRate || 0)) return "Overconfident";
  if (Number(group.estimatedExpectancy || 0) < 0) return "Reduced confidence";
  if (Number(group.expiredRate || 0) > 25) return "Under calibration";
  return "Calibrated";
}

function confidenceQualityLabel(confidence, status = "active") {
  if (["quarantined", "disabled_by_admin"].includes(status)) return "Quarantined";
  if (status === "reduced_confidence") return "Reduced confidence";
  if (status === "watchlist") return "Under calibration";
  const score = Number(confidence || 0);
  if (score >= 89) return "Proven elite";
  if (score >= 85) return "Very strong";
  if (score >= 80) return "Strong";
  if (score >= 70) return "Moderate";
  return "Experimental";
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
