import { query } from "../../db/client.js";
import { createId } from "../../shared/ids.js";

const terminalOutcomes = new Set(["Hit TP", "Hit SL", "Expired"]);
const strongerEvidenceMinimum = 100;
const promisingMinimum = 50;
const experimentalMinimum = 20;
const exampleCapPerStat = 60;

export function calculateBreakEvenWinRate(averageRiskReward) {
  const rr = Number(averageRiskReward || 0);
  if (!Number.isFinite(rr) || rr <= 0) return 0;
  return round((1 / (1 + rr)) * 100, 1);
}

export function calculateStrategyExpectancy({ winRate = 0, averageRiskReward = 0, expiredRate = 0 }) {
  const wins = Number(winRate || 0) / 100;
  const rr = Number(averageRiskReward || 0);
  const expiredDrag = (Number(expiredRate || 0) / 100) * 0.25;
  if (!Number.isFinite(wins) || !Number.isFinite(rr) || rr <= 0) return 0;
  return round(wins * rr - (1 - wins) - expiredDrag, 2);
}

export function getSampleSizeLabel(totalSetups) {
  const count = Number(totalSetups || 0);
  if (count >= strongerEvidenceMinimum) return "stronger_evidence";
  if (count >= promisingMinimum) return "promising";
  if (count >= experimentalMinimum) return "experimental";
  return "not_enough_data";
}

export function evaluateHistoricalOutcome(setup, forwardCandles = []) {
  if (!setup || !["long", "short"].includes(setup.direction)) {
    return { status: "Expired", realizedR: 0, barsToOutcome: forwardCandles.length };
  }

  for (let index = 0; index < forwardCandles.length; index += 1) {
    const candle = forwardCandles[index];
    const hitStop = setup.direction === "long"
      ? Number(candle.low) <= Number(setup.stopLoss)
      : Number(candle.high) >= Number(setup.stopLoss);
    const hitTarget = setup.direction === "long"
      ? Number(candle.high) >= Number(setup.takeProfit)
      : Number(candle.low) <= Number(setup.takeProfit);

    if (hitStop && hitTarget) {
      return { status: "Hit SL", realizedR: -1, barsToOutcome: index + 1, conservative: true };
    }
    if (hitStop) return { status: "Hit SL", realizedR: -1, barsToOutcome: index + 1 };
    if (hitTarget) {
      return {
        status: "Hit TP",
        realizedR: Number(setup.riskRewardRatio || setup.riskReward || 0),
        barsToOutcome: index + 1
      };
    }
  }

  return { status: "Expired", realizedR: 0, barsToOutcome: forwardCandles.length };
}

export function calculateHistoricalStrategyMetrics(examples = []) {
  const normalized = examples
    .map(normalizeHistoricalExample)
    .filter((example) => terminalOutcomes.has(example.result));
  const hitTp = normalized.filter((example) => example.result === "Hit TP");
  const hitSl = normalized.filter((example) => example.result === "Hit SL");
  const expired = normalized.filter((example) => example.result === "Expired");
  const closed = hitTp.length + hitSl.length;
  const validSetupCount = normalized.length;
  const averageRiskReward = validSetupCount
    ? round(normalized.reduce((sum, item) => sum + Number(item.riskReward || 0), 0) / validSetupCount, 2)
    : 0;
  const winRate = closed ? round((hitTp.length / closed) * 100, 1) : 0;
  const expiredRate = validSetupCount ? round((expired.length / validSetupCount) * 100, 1) : 0;
  const expectancy = calculateStrategyExpectancy({ winRate, averageRiskReward, expiredRate });
  const recent = normalized.slice(-Math.min(20, normalized.length));
  const recentPerformance = recent.length
    ? round(recent.reduce((sum, item) => sum + Number(item.realizedR || 0), 0) / recent.length, 2)
    : 0;

  return {
    totalTested: normalized.length,
    validSetupCount,
    hitTp: hitTp.length,
    hitSl: hitSl.length,
    expired: expired.length,
    winRate,
    breakEvenWinRate: calculateBreakEvenWinRate(averageRiskReward),
    averageRiskReward,
    expectancy,
    averageTimeToTpMinutes: averageBarsToMinutes(hitTp),
    averageTimeToSlMinutes: averageBarsToMinutes(hitSl),
    expiredRate,
    maxLosingStreak: calculateMaxLosingStreak(normalized),
    recentPerformance,
    confidenceCalibrationScore: calculateConfidenceCalibrationScore({ expectancy, winRate, expiredRate, sampleSize: normalized.length }),
    sampleSizeLabel: getSampleSizeLabel(normalized.length)
  };
}

export function calculateWalkForwardValidation(examples = [], trainingRatio = 0.7) {
  const sorted = examples
    .map(normalizeHistoricalExample)
    .filter((example) => terminalOutcomes.has(example.result))
    .sort((a, b) => new Date(a.entryCandleTime || a.createdAt || 0) - new Date(b.entryCandleTime || b.createdAt || 0));
  if (sorted.length < experimentalMinimum) {
    return {
      status: "not_enough_data",
      training: calculateHistoricalStrategyMetrics(sorted),
      validation: calculateHistoricalStrategyMetrics([])
    };
  }

  const splitIndex = Math.max(1, Math.min(sorted.length - 1, Math.floor(sorted.length * trainingRatio)));
  const training = calculateHistoricalStrategyMetrics(sorted.slice(0, splitIndex));
  const validation = calculateHistoricalStrategyMetrics(sorted.slice(splitIndex));
  const trainingPasses = training.totalTested >= Math.min(experimentalMinimum, splitIndex) && training.expectancy > 0 && training.winRate >= training.breakEvenWinRate;
  const validationPasses = validation.totalTested >= 5 && validation.expectancy > -0.05 && validation.winRate >= Math.max(0, validation.breakEvenWinRate - 5);
  return {
    status: trainingPasses && validationPasses ? "validated" : "failed_validation",
    training,
    validation
  };
}

export function compareSetupToHistoricalExamples(signal, examples = []) {
  const current = buildSimilarityVector(signal);
  const scored = examples
    .map((example) => ({
      example,
      similarity: vectorSimilarity(current, example.similarityVector || buildSimilarityVector(example))
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 12);
  const successful = scored.filter((item) => item.example.result === "Hit TP");
  const failed = scored.filter((item) => item.example.result === "Hit SL" || item.example.result === "Expired");
  const successSimilarity = successful.length ? average(successful.map((item) => item.similarity)) : 0;
  const failureSimilarity = failed.length ? average(failed.map((item) => item.similarity)) : 0;
  const adjustment = successSimilarity > failureSimilarity + 0.15 ? 2 : failureSimilarity > successSimilarity + 0.1 ? -6 : 0;

  return {
    successSimilarity: round(successSimilarity, 2),
    failureSimilarity: round(failureSimilarity, 2),
    adjustment,
    reason: adjustment < 0
      ? "Current setup resembles historically failed examples more than successful examples."
      : adjustment > 0
        ? "Current setup resembles historically successful examples, but validation still controls publication."
        : "Historical examples are mixed or insufficient."
  };
}

export async function applyHistoricalStrategyCalibration(signal) {
  if (!signal) return signal;
  try {
    const context = await getHistoricalStrategyContext(signal);
    return applyHistoricalStrategyContext(signal, context);
  } catch (error) {
    console.warn(`[strategy-lab] historical_calibration_skipped reason=${error.message}`);
    return applyHistoricalStrategyContext(signal, {
      stat: null,
      similarity: null
    });
  }
}

export function applyHistoricalStrategyContext(signal, context = {}) {
  if (!signal) return signal;
  const original = Number(signal.confidenceScore || 0);
  let penalty = 0;
  let cap = 99;
  const reasons = [];

  if (!context.stat || context.stat.sampleSizeLabel === "not_enough_data") {
    cap = Math.min(cap, 88);
    reasons.push("Historical strategy testing has fewer than 20 setups for this exact strategy, pair, timeframe, and regime.");
  } else {
    const stat = context.stat;
    if (stat.walkForwardStatus !== "validated") {
      cap = Math.min(cap, 82);
      penalty -= 6;
      reasons.push("Walk-forward validation has not confirmed this strategy in the current regime.");
    }
    if (Number(stat.expectancy || 0) < 0) {
      cap = Math.min(cap, 75);
      penalty -= 10;
      reasons.push(`Historical expectancy is negative (${Number(stat.expectancy).toFixed(2)}R).`);
    }
    if (Number(stat.expiredRate || 0) >= 35) {
      cap = Math.min(cap, 78);
      penalty -= 4;
      reasons.push("Historical testing shows a high expired setup rate.");
    }
  }

  if (context.similarity?.adjustment) {
    penalty += context.similarity.adjustment;
    reasons.push(context.similarity.reason);
  }

  const finalConfidence = Math.max(50, Math.min(cap, original + penalty));
  const historicalCalibration = {
    version: "historical_strategy_v1",
    originalConfidence: original,
    calibratedConfidence: Math.round(finalConfidence),
    confidenceCap: cap,
    penalty,
    status: context.stat?.walkForwardStatus || "not_enough_data",
    sampleSizeLabel: context.stat?.sampleSizeLabel || "not_enough_data",
    reasons,
    stat: context.stat ? summarizeStat(context.stat) : null,
    similarity: context.similarity || null,
    copy: "Historical performance helps calibrate confidence, but it does not guarantee future results."
  };

  return {
    ...signal,
    confidenceScore: Math.round(finalConfidence),
    historicalStrategyStatus: historicalCalibration.status,
    historicalStrategyReason: reasons.join(" ") || "Historical calibration applied.",
    indicators: {
      ...(signal.indicators || {}),
      historicalStrategyCalibration: historicalCalibration
    }
  };
}

export async function getHistoricalStrategyContext(signal) {
  const stat = await findStrategyBacktestStat(signal);
  const examples = stat ? await listStrategyBacktestExamplesForSignal(signal, stat.id) : [];
  return {
    stat,
    examples,
    similarity: examples.length ? compareSetupToHistoricalExamples(signal, examples) : null
  };
}

export async function saveStrategyBacktestAggregate({ strategy, pair, timeframe, marketRegime = "unknown", source = "historical_backtest", examples = [] }) {
  const metrics = calculateHistoricalStrategyMetrics(examples);
  const walkForward = calculateWalkForwardValidation(examples);
  const id = `sbt_${hash([strategy, pair, timeframe, marketRegime, source].join(":"))}`;
  const result = await query(`
    INSERT INTO strategy_backtest_stats (
      id, strategy, pair, timeframe, market_regime, source, total_tested, valid_setup_count,
      hit_tp, hit_sl, expired, win_rate, break_even_win_rate, average_rr, expectancy,
      average_time_to_tp_minutes, average_time_to_sl_minutes, expired_rate, max_losing_streak,
      recent_performance, confidence_calibration_score, sample_size_label, walk_forward_status,
      training_summary, validation_summary, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,now())
    ON CONFLICT (strategy, pair, timeframe, market_regime, source) DO UPDATE SET
      total_tested = EXCLUDED.total_tested,
      valid_setup_count = EXCLUDED.valid_setup_count,
      hit_tp = EXCLUDED.hit_tp,
      hit_sl = EXCLUDED.hit_sl,
      expired = EXCLUDED.expired,
      win_rate = EXCLUDED.win_rate,
      break_even_win_rate = EXCLUDED.break_even_win_rate,
      average_rr = EXCLUDED.average_rr,
      expectancy = EXCLUDED.expectancy,
      average_time_to_tp_minutes = EXCLUDED.average_time_to_tp_minutes,
      average_time_to_sl_minutes = EXCLUDED.average_time_to_sl_minutes,
      expired_rate = EXCLUDED.expired_rate,
      max_losing_streak = EXCLUDED.max_losing_streak,
      recent_performance = EXCLUDED.recent_performance,
      confidence_calibration_score = EXCLUDED.confidence_calibration_score,
      sample_size_label = EXCLUDED.sample_size_label,
      walk_forward_status = EXCLUDED.walk_forward_status,
      training_summary = EXCLUDED.training_summary,
      validation_summary = EXCLUDED.validation_summary,
      updated_at = now()
    RETURNING *
  `, [
    id, strategy, pair, timeframe, marketRegime || "unknown", source,
    metrics.totalTested, metrics.validSetupCount, metrics.hitTp, metrics.hitSl, metrics.expired,
    metrics.winRate, metrics.breakEvenWinRate, metrics.averageRiskReward, metrics.expectancy,
    metrics.averageTimeToTpMinutes, metrics.averageTimeToSlMinutes, metrics.expiredRate,
    metrics.maxLosingStreak, metrics.recentPerformance, metrics.confidenceCalibrationScore,
    metrics.sampleSizeLabel, walkForward.status, JSON.stringify(walkForward.training), JSON.stringify(walkForward.validation)
  ]);
  const stat = mapStrategyBacktestStat(result.rows[0]);
  await saveStrategyBacktestExamples(stat.id, examples);
  return stat;
}

export async function listStrategyLabSummary() {
  const [stats, examples, runs] = await Promise.all([
    query("SELECT * FROM strategy_backtest_stats ORDER BY expectancy DESC, updated_at DESC LIMIT 80"),
    query("SELECT * FROM strategy_backtest_examples ORDER BY created_at DESC LIMIT 24"),
    query("SELECT * FROM strategy_backtest_runs ORDER BY created_at DESC LIMIT 10")
  ]);
  const mappedStats = stats.rows.map(mapStrategyBacktestStat);
  return {
    stats: mappedStats,
    bestStrategies: mappedStats.filter((item) => item.expectancy > 0).slice(0, 12),
    quarantinedRecommendations: mappedStats.filter((item) => item.expectancy < 0 || item.walkForwardStatus === "failed_validation").slice(0, 12),
    examples: examples.rows.map(mapStrategyBacktestExample),
    runs: runs.rows.map(mapStrategyBacktestRun),
    safetyCopy: "Historical performance does not guarantee future results. Confidence is not a win probability."
  };
}

export async function startStrategyBacktestJob(scope = {}, user = null) {
  const id = createId("sbtjob");
  const run = await query(`
    INSERT INTO strategy_backtest_runs (id, status, scope, progress, created_by, created_at, updated_at)
    VALUES ($1,'queued',$2,$3,$4,now(),now()) RETURNING *
  `, [
    id,
    JSON.stringify(scope || {}),
    JSON.stringify({ marketsTested: 0, strategiesTested: 0, candlesProcessed: 0, setupsFound: 0 }),
    user?.id || "admin"
  ]);
  setTimeout(() => completeSyntheticBacktestJob(id, scope).catch((error) => {
    console.warn(`[strategy-lab] job_failed id=${id} reason=${error.message}`);
  }), 50);
  return mapStrategyBacktestRun(run.rows[0]);
}

export async function getStrategyBacktestJob(id) {
  const result = await query("SELECT * FROM strategy_backtest_runs WHERE id = $1", [id]);
  return mapStrategyBacktestRun(result.rows[0]);
}

async function completeSyntheticBacktestJob(id, scope = {}) {
  await query("UPDATE strategy_backtest_runs SET status='running', progress=$2, updated_at=now() WHERE id=$1", [
    id,
    JSON.stringify({ marketsTested: 0, strategiesTested: 0, candlesProcessed: 0, setupsFound: 0, estimatedSecondsLeft: 30 })
  ]);
  await query(`
    UPDATE strategy_backtest_runs
    SET status='completed',
      progress=$2,
      result_summary=$3,
      completed_at=now(),
      updated_at=now()
    WHERE id=$1
  `, [
    id,
    JSON.stringify({ marketsTested: 0, strategiesTested: 0, candlesProcessed: 0, setupsFound: 0, estimatedSecondsLeft: 0 }),
    JSON.stringify({
      message: "Backtest job shell created. Run targeted strategy tests from existing candle fixtures or admin-selected markets.",
      scope
    })
  ]);
}

async function findStrategyBacktestStat(signal) {
  const result = await query(`
    SELECT * FROM strategy_backtest_stats
    WHERE strategy = $1
      AND pair = $2
      AND timeframe = $3
      AND market_regime = $4
    ORDER BY updated_at DESC
    LIMIT 1
  `, [
    signal.setupType || signal.strategy || "Qualified setup",
    signal.symbol || signal.pair,
    signal.timeframe,
    normalizeRegime(signal)
  ]);
  return mapStrategyBacktestStat(result.rows[0]);
}

async function listStrategyBacktestExamplesForSignal(signal, statId) {
  const result = await query(`
    SELECT * FROM strategy_backtest_examples
    WHERE stat_id = $1 OR (strategy = $2 AND pair = $3 AND timeframe = $4)
    ORDER BY created_at DESC
    LIMIT 40
  `, [statId, signal.setupType || signal.strategy || "Qualified setup", signal.symbol || signal.pair, signal.timeframe]);
  return result.rows.map(mapStrategyBacktestExample);
}

async function saveStrategyBacktestExamples(statId, examples = []) {
  const normalized = examples
    .map(normalizeHistoricalExample)
    .filter((example) => terminalOutcomes.has(example.result))
    .sort((a, b) => Math.abs(Number(b.realizedR || 0)) - Math.abs(Number(a.realizedR || 0)))
    .slice(0, exampleCapPerStat);
  for (const example of normalized) {
    await query(`
      INSERT INTO strategy_backtest_examples (
        id, stat_id, strategy, pair, timeframe, market_regime, entry_candle_time,
        entry, stop_loss, take_profit, result, qualification_reason, chart_context,
        key_confirmations, similarity_vector, example_type, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
      ON CONFLICT (id) DO UPDATE SET
        result = EXCLUDED.result,
        qualification_reason = EXCLUDED.qualification_reason,
        chart_context = EXCLUDED.chart_context,
        key_confirmations = EXCLUDED.key_confirmations,
        similarity_vector = EXCLUDED.similarity_vector
    `, [
      `sbte_${hash([statId, example.entryCandleTime, example.result, example.entry].join(":"))}`,
      statId,
      example.strategy,
      example.pair,
      example.timeframe,
      example.marketRegime || "unknown",
      example.entryCandleTime || null,
      finiteOrNull(example.entry),
      finiteOrNull(example.stopLoss),
      finiteOrNull(example.takeProfit),
      example.result,
      example.qualificationReason || "",
      JSON.stringify(example.chartContext || {}),
      JSON.stringify(example.keyConfirmations || []),
      JSON.stringify(example.similarityVector || buildSimilarityVector(example)),
      example.result === "Hit TP" ? "best" : example.result === "Hit SL" ? "worst" : "recent"
    ]);
  }
  await query(`
    DELETE FROM strategy_backtest_examples
    WHERE stat_id = $1
      AND id NOT IN (
        SELECT id FROM strategy_backtest_examples
        WHERE stat_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      )
  `, [statId, exampleCapPerStat]);
}

function normalizeHistoricalExample(example = {}) {
  const riskReward = Number(example.riskReward ?? example.riskRewardRatio ?? example.rr ?? 0);
  const result = example.result || example.outcome || example.status || "Expired";
  return {
    ...example,
    strategy: example.strategy || example.setupType || "Qualified setup",
    pair: example.pair || example.symbol || "",
    timeframe: example.timeframe || "",
    marketRegime: example.marketRegime || example.regime || "unknown",
    result,
    riskReward,
    realizedR: result === "Hit TP" ? riskReward : result === "Hit SL" ? -1 : Number(example.realizedR || 0),
    barsToOutcome: Number(example.barsToOutcome || 0),
    minutesPerBar: timeframeMinutes(example.timeframe)
  };
}

function calculateConfidenceCalibrationScore({ expectancy, winRate, expiredRate, sampleSize }) {
  const sampleWeight = Math.min(1, Number(sampleSize || 0) / strongerEvidenceMinimum);
  return round(((Number(expectancy || 0) * 25) + (Number(winRate || 0) - 50) - Number(expiredRate || 0) * 0.4) * sampleWeight, 1);
}

function calculateMaxLosingStreak(examples) {
  let current = 0;
  let max = 0;
  for (const example of examples) {
    if (example.result === "Hit SL") {
      current += 1;
      max = Math.max(max, current);
    } else if (example.result === "Hit TP") {
      current = 0;
    }
  }
  return max;
}

function averageBarsToMinutes(examples) {
  const values = examples.map((item) => Number(item.barsToOutcome || 0) * Number(item.minutesPerBar || 0)).filter((item) => Number.isFinite(item) && item > 0);
  return values.length ? round(average(values), 1) : null;
}

function buildSimilarityVector(value = {}) {
  return {
    rr: bucket(Number(value.riskReward ?? value.riskRewardRatio ?? 0), [1.5, 2, 2.5, 3]),
    confidence: bucket(Number(value.confidence ?? value.confidenceScore ?? 0), [70, 80, 88, 94]),
    readiness: bucket(Number(value.readinessScore ?? value.entryReadinessScore ?? 0), [70, 80, 90]),
    regime: normalizeRegime(value),
    direction: value.direction || "",
    strategy: value.strategy || value.setupType || ""
  };
}

function vectorSimilarity(left = {}, right = {}) {
  const fields = ["rr", "confidence", "readiness", "regime", "direction", "strategy"];
  const matches = fields.filter((field) => String(left[field] ?? "") === String(right[field] ?? "")).length;
  return matches / fields.length;
}

function normalizeRegime(signal = {}) {
  return String(
    signal.marketRegime ||
    signal.regime ||
    signal.indicators?.regime ||
    signal.fullAnalysis?.indicators?.regime ||
    signal.fullAnalysis?.marketStructure?.regime ||
    "unknown"
  ).trim() || "unknown";
}

function bucket(value, thresholds) {
  if (!Number.isFinite(value)) return "unknown";
  return thresholds.findIndex((threshold) => value < threshold);
}

function summarizeStat(stat) {
  return {
    strategy: stat.strategy,
    pair: stat.pair,
    timeframe: stat.timeframe,
    marketRegime: stat.marketRegime,
    totalTested: stat.totalTested,
    winRate: stat.winRate,
    breakEvenWinRate: stat.breakEvenWinRate,
    expectancy: stat.expectancy,
    expiredRate: stat.expiredRate,
    sampleSizeLabel: stat.sampleSizeLabel,
    walkForwardStatus: stat.walkForwardStatus
  };
}

function mapStrategyBacktestStat(row) {
  if (!row) return null;
  return {
    id: row.id,
    strategy: row.strategy,
    pair: row.pair,
    timeframe: row.timeframe,
    marketRegime: row.market_regime,
    source: row.source,
    totalTested: Number(row.total_tested || 0),
    validSetupCount: Number(row.valid_setup_count || 0),
    hitTp: Number(row.hit_tp || 0),
    hitSl: Number(row.hit_sl || 0),
    expired: Number(row.expired || 0),
    winRate: Number(row.win_rate || 0),
    breakEvenWinRate: Number(row.break_even_win_rate || 0),
    averageRiskReward: Number(row.average_rr || 0),
    expectancy: Number(row.expectancy || 0),
    averageTimeToTpMinutes: row.average_time_to_tp_minutes == null ? null : Number(row.average_time_to_tp_minutes),
    averageTimeToSlMinutes: row.average_time_to_sl_minutes == null ? null : Number(row.average_time_to_sl_minutes),
    expiredRate: Number(row.expired_rate || 0),
    maxLosingStreak: Number(row.max_losing_streak || 0),
    recentPerformance: Number(row.recent_performance || 0),
    confidenceCalibrationScore: Number(row.confidence_calibration_score || 0),
    sampleSizeLabel: row.sample_size_label,
    walkForwardStatus: row.walk_forward_status,
    trainingSummary: row.training_summary || {},
    validationSummary: row.validation_summary || {},
    updatedAt: row.updated_at
  };
}

function mapStrategyBacktestExample(row) {
  if (!row) return null;
  return {
    id: row.id,
    statId: row.stat_id,
    strategy: row.strategy,
    pair: row.pair,
    timeframe: row.timeframe,
    marketRegime: row.market_regime,
    entryCandleTime: row.entry_candle_time,
    entry: row.entry == null ? null : Number(row.entry),
    stopLoss: row.stop_loss == null ? null : Number(row.stop_loss),
    takeProfit: row.take_profit == null ? null : Number(row.take_profit),
    result: row.result,
    qualificationReason: row.qualification_reason,
    chartContext: row.chart_context || {},
    keyConfirmations: row.key_confirmations || [],
    similarityVector: row.similarity_vector || {},
    exampleType: row.example_type,
    createdAt: row.created_at
  };
}

function mapStrategyBacktestRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    scope: row.scope || {},
    progress: row.progress || {},
    resultSummary: row.result_summary || {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    failedReason: row.failed_reason
  };
}

function timeframeMinutes(timeframe) {
  return { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240 }[timeframe] || 15;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function hash(value) {
  let result = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    result = ((result << 5) - result + text.charCodeAt(index)) | 0;
  }
  return Math.abs(result).toString(16);
}
