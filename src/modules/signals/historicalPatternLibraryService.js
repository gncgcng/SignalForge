const minimumRiskReward = 1.5;
const activeReadyTimeframes = new Set(["15m"]);
const researchOnlyTimeframes = new Set(["5m", "1h", "4h"]);

export function buildLearnedPatternCandidates({
  marketData = {},
  timeframe = "15m",
  candles = [],
  indicators = {},
  levels = {},
  regime = {},
  detectedPatterns = []
} = {}) {
  if (!Array.isArray(candles) || candles.length < 40) return [];
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const atr = Number(indicators.atr14 || 0);
  if (!latest || !previous || !Number.isFinite(atr) || atr <= 0) return [];

  const context = buildTemplateContext({
    marketData,
    timeframe,
    candles,
    latest,
    previous,
    atr,
    indicators,
    levels,
    regime,
    detectedPatterns
  });
  const templates = [
    supportBounceLong,
    resistanceRejectionShort,
    pullbackContinuationLong,
    pullbackContinuationShort,
    breakoutRetestLong,
    breakoutRetestShort,
    failedBreakoutShort,
    failedBreakdownLong,
    momentumContinuationLong,
    momentumContinuationShort,
    rangeBounceLong,
    rangeBounceShort
  ];

  return templates
    .map((template) => template(context))
    .filter(Boolean)
    .filter((candidate) => validateLearnedPatternCandidate(candidate).valid)
    .sort((left, right) => {
      return Number(right.learnedPattern?.patternMatchScore || 0) -
        Number(left.learnedPattern?.patternMatchScore || 0);
    })
    .slice(0, 8);
}

export function buildPatternLibraryFromExamples(examples = [], options = {}) {
  const maxPerBucket = Math.max(1, Number(options.maxExamplesPerBucket || 30));
  const normalized = examples.map(normalizePatternExample).filter((item) => item.strategy && item.timeframe);
  const successful = selectPatternExamplesForStorage(
    normalized.filter((item) => item.result === "Hit TP"),
    maxPerBucket
  );
  const failed = selectPatternExamplesForStorage(
    normalized.filter((item) => item.result === "Hit SL"),
    maxPerBucket
  );
  const expired = selectPatternExamplesForStorage(
    normalized.filter((item) => item.result === "Expired"),
    Math.ceil(maxPerBucket / 2)
  );

  return {
    successful,
    failed,
    expired,
    templates: buildStrategyTemplates([...successful, ...failed, ...expired]),
    capped: normalized.length > successful.length + failed.length + expired.length
  };
}

export function selectPatternExamplesForStorage(examples = [], maxRows = 60) {
  return [...examples]
    .sort((left, right) => Math.abs(Number(right.realizedR || 0)) - Math.abs(Number(left.realizedR || 0)))
    .slice(0, Math.max(0, Number(maxRows || 0)));
}

export function validateLearnedPatternCandidate(candidate = {}) {
  const entry = Number(candidate.entry);
  const stopLoss = Number(candidate.stopLoss);
  const takeProfit = Number(candidate.takeProfit);
  const riskRewardRatio = Number(candidate.riskRewardRatio || 0);
  const direction = candidate.direction;
  const hasValidLevels = direction === "long"
    ? entry > stopLoss && takeProfit > entry
    : direction === "short" && entry < stopLoss && takeProfit < entry;
  const patternScore = Number(candidate.learnedPattern?.patternMatchScore || 0);
  const hasStructure = (candidate.confirmations || []).some((item) =>
    item.passed && /support|resistance|retest|range|breakout|structure/i.test(item.name)
  );

  if (!["long", "short"].includes(direction)) {
    return { valid: false, reason: "invalid_direction" };
  }
  if (![entry, stopLoss, takeProfit, riskRewardRatio].every(Number.isFinite)) {
    return { valid: false, reason: "invalid_levels" };
  }
  if (!hasValidLevels) {
    return { valid: false, reason: "invalid_directional_levels" };
  }
  if (riskRewardRatio < minimumRiskReward) {
    return { valid: false, reason: "weak_risk_reward" };
  }
  if (!hasStructure) {
    return { valid: false, reason: "missing_structure" };
  }
  if (patternScore < 58) {
    return { valid: false, reason: "weak_pattern_match" };
  }
  return { valid: true, reason: "valid_pattern_candidate" };
}

export function candidateEligibleForReady(candidate = {}, { qualityGatePassed = false } = {}) {
  if (!qualityGatePassed) return false;
  if (researchOnlyTimeframes.has(candidate.timeframe) && !activeReadyTimeframes.has(candidate.timeframe)) {
    return false;
  }
  if (!activeReadyTimeframes.has(candidate.timeframe)) return false;
  const validation = validateLearnedPatternCandidate(candidate);
  return validation.valid && Number(candidate.confidenceScore || 0) >= 65;
}

function buildTemplateContext({
  marketData,
  timeframe,
  candles,
  latest,
  previous,
  atr,
  indicators,
  levels,
  regime,
  detectedPatterns
}) {
  const prior = candles.slice(-32, -3);
  const recent = candles.slice(-14);
  const priorHigh = Math.max(...prior.map((candle) => Number(candle.high)));
  const priorLow = Math.min(...prior.map((candle) => Number(candle.low)));
  const recentHigh = Math.max(...recent.map((candle) => Number(candle.high)));
  const recentLow = Math.min(...recent.map((candle) => Number(candle.low)));
  const support = levels.nearestSupport;
  const resistance = levels.nearestResistance;
  const volumeRatio = Number(indicators.volumeMa20 || 0) > 0
    ? Number(latest.volume || 0) / Number(indicators.volumeMa20)
    : 1;

  return {
    symbol: marketData?.pair?.symbol,
    timeframe,
    latest,
    previous,
    candles,
    atr,
    indicators,
    levels,
    regime,
    detectedPatterns,
    support,
    resistance,
    priorHigh,
    priorLow,
    recentHigh,
    recentLow,
    volumeRatio,
    trendUp: indicators.ema20 > indicators.ema50,
    trendDown: indicators.ema20 < indicators.ema50,
    bullishCandle: latest.close > latest.open,
    bearishCandle: latest.close < latest.open,
    rangeBound: regime.label === "Range" || regime.choppy
  };
}

function supportBounceLong(context) {
  const { latest, support, resistance, atr, indicators } = context;
  if (!support) return null;
  const entry = Number(latest.close);
  const nearSupport = entry > support.price && entry - support.price <= atr * 1.25;
  const rsiReset = indicators.rsi14 >= 35 && indicators.rsi14 <= 58;
  const stopLoss = support.price - atr * 0.35;
  const target = targetFromResistance(entry, stopLoss, resistance, atr);
  return makeCandidate(context, {
    direction: "long",
    strategy: context.rangeBound ? "Range bounce" : "Support/resistance retest",
    label: context.rangeBound ? "Support bounce in range" : "Support retest bounce",
    entry,
    stopLoss,
    takeProfit: target,
    confirmations: [
      confirm("Support", nearSupport, `Price is close to support near ${formatNumber(support.price)}.`),
      confirm("RSI", rsiReset, `RSI reset is ${formatNumber(indicators.rsi14)}.`),
      confirm("Resistance room", target > entry, "There is room toward the next resistance or a 2R objective."),
      confirm("Volume", context.volumeRatio >= 0.95, `Volume is ${formatNumber(context.volumeRatio)}x average.`),
      confirm("Structure", context.bullishCandle, "Latest candle is holding bullish structure.")
    ]
  });
}

function resistanceRejectionShort(context) {
  const { latest, support, resistance, atr, indicators } = context;
  if (!resistance) return null;
  const entry = Number(latest.close);
  const nearResistance = resistance.price > entry && resistance.price - entry <= atr * 1.25;
  const rsiReset = indicators.rsi14 >= 42 && indicators.rsi14 <= 65;
  const stopLoss = resistance.price + atr * 0.35;
  const target = targetFromSupport(entry, stopLoss, support, atr);
  return makeCandidate(context, {
    direction: "short",
    strategy: context.rangeBound ? "Range bounce" : "Support/resistance retest",
    label: context.rangeBound ? "Resistance rejection in range" : "Resistance retest rejection",
    entry,
    stopLoss,
    takeProfit: target,
    confirmations: [
      confirm("Resistance", nearResistance, `Price is close to resistance near ${formatNumber(resistance.price)}.`),
      confirm("RSI", rsiReset, `RSI reset is ${formatNumber(indicators.rsi14)}.`),
      confirm("Support room", target < entry, "There is room toward the next support or a 2R objective."),
      confirm("Volume", context.volumeRatio >= 0.95, `Volume is ${formatNumber(context.volumeRatio)}x average.`),
      confirm("Structure", context.bearishCandle, "Latest candle is holding bearish structure.")
    ]
  });
}

function pullbackContinuationLong(context) {
  const { latest, support, resistance, atr, indicators } = context;
  const entry = Number(latest.close);
  const nearEma = Math.abs(entry - indicators.ema20) <= atr * 0.9;
  const stopLoss = Math.min(Number(support?.price || entry - atr * 1.4), entry - atr * 1.05);
  const target = targetFromResistance(entry, stopLoss, resistance, atr);
  return makeCandidate(context, {
    direction: "long",
    strategy: "Pullback bounce",
    label: "Learned pullback continuation",
    entry,
    stopLoss,
    takeProfit: target,
    confirmations: [
      confirm("Trend", context.trendUp && entry > indicators.ema50, "EMA trend favors continuation."),
      confirm("Support", Boolean(support) && entry > support.price, "Pullback remains above structure support."),
      confirm("RSI", indicators.rsi14 >= 42 && indicators.rsi14 <= 62, `RSI is reset at ${formatNumber(indicators.rsi14)}.`),
      confirm("Resistance room", target > entry, "Target room is available above entry."),
      confirm("Retest", nearEma, "Entry is near the pullback/retest zone."),
      confirm("Volume", context.volumeRatio >= 0.9, `Volume is ${formatNumber(context.volumeRatio)}x average.`)
    ]
  });
}

function pullbackContinuationShort(context) {
  const { latest, support, resistance, atr, indicators } = context;
  const entry = Number(latest.close);
  const nearEma = Math.abs(entry - indicators.ema20) <= atr * 0.9;
  const stopLoss = Math.max(Number(resistance?.price || entry + atr * 1.4), entry + atr * 1.05);
  const target = targetFromSupport(entry, stopLoss, support, atr);
  return makeCandidate(context, {
    direction: "short",
    strategy: "Pullback bounce",
    label: "Learned pullback continuation",
    entry,
    stopLoss,
    takeProfit: target,
    confirmations: [
      confirm("Trend", context.trendDown && entry < indicators.ema50, "EMA trend favors continuation."),
      confirm("Resistance", Boolean(resistance) && entry < resistance.price, "Pullback remains below structure resistance."),
      confirm("RSI", indicators.rsi14 >= 38 && indicators.rsi14 <= 58, `RSI is reset at ${formatNumber(indicators.rsi14)}.`),
      confirm("Support room", target < entry, "Target room is available below entry."),
      confirm("Retest", nearEma, "Entry is near the pullback/retest zone."),
      confirm("Volume", context.volumeRatio >= 0.9, `Volume is ${formatNumber(context.volumeRatio)}x average.`)
    ]
  });
}

function breakoutRetestLong(context) {
  const { latest, previous, priorHigh, support, resistance, atr, indicators } = context;
  const entry = Number(latest.close);
  const brokeLevel = previous.close > priorHigh || latest.close > priorHigh;
  const retestHeld = latest.low <= priorHigh + atr * 0.55 && latest.close > priorHigh;
  const stopLoss = Math.min(priorHigh - atr * 0.45, Number(support?.price || priorHigh - atr));
  const target = targetFromResistance(entry, stopLoss, resistance, atr);
  return makeCandidate(context, {
    direction: "long",
    strategy: "Breakout retest",
    label: "Learned breakout retest",
    entry,
    stopLoss,
    takeProfit: target,
    confirmations: [
      confirm("Trend", context.trendUp || latest.close > indicators.ema50, "Trend does not fight the breakout."),
      confirm("Retest", brokeLevel && retestHeld, "Price broke and retested the prior resistance zone."),
      confirm("RSI", indicators.rsi14 >= 48 && indicators.rsi14 <= 70, `RSI is ${formatNumber(indicators.rsi14)}.`),
      confirm("Resistance room", target > entry, "Target has room beyond the retest."),
      confirm("Volume", context.volumeRatio >= 1.0, `Volume is ${formatNumber(context.volumeRatio)}x average.`)
    ]
  });
}

function breakoutRetestShort(context) {
  const { latest, previous, priorLow, support, resistance, atr, indicators } = context;
  const entry = Number(latest.close);
  const brokeLevel = previous.close < priorLow || latest.close < priorLow;
  const retestHeld = latest.high >= priorLow - atr * 0.55 && latest.close < priorLow;
  const stopLoss = Math.max(priorLow + atr * 0.45, Number(resistance?.price || priorLow + atr));
  const target = targetFromSupport(entry, stopLoss, support, atr);
  return makeCandidate(context, {
    direction: "short",
    strategy: "Breakout retest",
    label: "Learned breakout retest",
    entry,
    stopLoss,
    takeProfit: target,
    confirmations: [
      confirm("Trend", context.trendDown || latest.close < indicators.ema50, "Trend does not fight the breakdown."),
      confirm("Retest", brokeLevel && retestHeld, "Price broke and retested the prior support zone."),
      confirm("RSI", indicators.rsi14 >= 30 && indicators.rsi14 <= 52, `RSI is ${formatNumber(indicators.rsi14)}.`),
      confirm("Support room", target < entry, "Target has room beyond the retest."),
      confirm("Volume", context.volumeRatio >= 1.0, `Volume is ${formatNumber(context.volumeRatio)}x average.`)
    ]
  });
}

function failedBreakoutShort(context) {
  const { latest, priorHigh, support, resistance, atr, indicators } = context;
  const entry = Number(latest.close);
  const sweptHigh = latest.high > priorHigh + atr * 0.15 && latest.close < priorHigh;
  const stopLoss = Math.max(latest.high + atr * 0.2, Number(resistance?.price || latest.high) + atr * 0.15);
  const target = targetFromSupport(entry, stopLoss, support, atr);
  return makeCandidate(context, {
    direction: "short",
    strategy: "Liquidity sweep reversal",
    label: "Failed breakout reversal",
    entry,
    stopLoss,
    takeProfit: target,
    confirmations: [
      confirm("Resistance", Boolean(resistance) || Number.isFinite(priorHigh), "Price swept an upper structure area."),
      confirm("Structure", sweptHigh, "Breakout attempt failed back below resistance."),
      confirm("RSI", indicators.rsi14 >= 48 && indicators.rsi14 <= 74, `RSI is ${formatNumber(indicators.rsi14)}.`),
      confirm("Support room", target < entry, "Downside target room is available."),
      confirm("Volume", context.volumeRatio >= 0.95, `Volume is ${formatNumber(context.volumeRatio)}x average.`)
    ]
  });
}

function failedBreakdownLong(context) {
  const { latest, priorLow, support, resistance, atr, indicators } = context;
  const entry = Number(latest.close);
  const sweptLow = latest.low < priorLow - atr * 0.15 && latest.close > priorLow;
  const stopLoss = Math.min(latest.low - atr * 0.2, Number(support?.price || latest.low) - atr * 0.15);
  const target = targetFromResistance(entry, stopLoss, resistance, atr);
  return makeCandidate(context, {
    direction: "long",
    strategy: "Liquidity sweep reversal",
    label: "Failed breakdown reversal",
    entry,
    stopLoss,
    takeProfit: target,
    confirmations: [
      confirm("Support", Boolean(support) || Number.isFinite(priorLow), "Price swept a lower structure area."),
      confirm("Structure", sweptLow, "Breakdown attempt failed back above support."),
      confirm("RSI", indicators.rsi14 >= 26 && indicators.rsi14 <= 52, `RSI is ${formatNumber(indicators.rsi14)}.`),
      confirm("Resistance room", target > entry, "Upside target room is available."),
      confirm("Volume", context.volumeRatio >= 0.95, `Volume is ${formatNumber(context.volumeRatio)}x average.`)
    ]
  });
}

function momentumContinuationLong(context) {
  const { latest, priorHigh, resistance, atr, indicators } = context;
  const entry = Number(latest.close);
  const candleRange = Number(latest.high) - Number(latest.low);
  const stopLoss = Math.min(latest.low - atr * 0.25, entry - atr * 1.15);
  const target = targetFromResistance(entry, stopLoss, resistance, atr);
  return makeCandidate(context, {
    direction: "long",
    strategy: "Momentum breakout",
    label: "Learned momentum continuation",
    entry,
    stopLoss,
    takeProfit: target,
    confirmations: [
      confirm("Trend", context.trendUp && entry > indicators.ema20, "Momentum aligns with the EMA trend."),
      confirm("Structure", latest.close > priorHigh, "Price closed beyond recent structure."),
      confirm("RSI", indicators.rsi14 >= 52 && indicators.rsi14 <= 72, `RSI is ${formatNumber(indicators.rsi14)}.`),
      confirm("Resistance room", target > entry, "Upside room remains after breakout."),
      confirm("Volume", context.volumeRatio >= 1.1, `Volume is ${formatNumber(context.volumeRatio)}x average.`),
      confirm("ATR", candleRange <= atr * 1.8, "Breakout candle is not too extended.")
    ]
  });
}

function momentumContinuationShort(context) {
  const { latest, priorLow, support, atr, indicators } = context;
  const entry = Number(latest.close);
  const candleRange = Number(latest.high) - Number(latest.low);
  const stopLoss = Math.max(latest.high + atr * 0.25, entry + atr * 1.15);
  const target = targetFromSupport(entry, stopLoss, support, atr);
  return makeCandidate(context, {
    direction: "short",
    strategy: "Momentum breakout",
    label: "Learned momentum continuation",
    entry,
    stopLoss,
    takeProfit: target,
    confirmations: [
      confirm("Trend", context.trendDown && entry < indicators.ema20, "Momentum aligns with the EMA trend."),
      confirm("Structure", latest.close < priorLow, "Price closed beyond recent structure."),
      confirm("RSI", indicators.rsi14 >= 28 && indicators.rsi14 <= 48, `RSI is ${formatNumber(indicators.rsi14)}.`),
      confirm("Support room", target < entry, "Downside room remains after breakdown."),
      confirm("Volume", context.volumeRatio >= 1.1, `Volume is ${formatNumber(context.volumeRatio)}x average.`),
      confirm("ATR", candleRange <= atr * 1.8, "Breakdown candle is not too extended.")
    ]
  });
}

function rangeBounceLong(context) {
  if (!context.rangeBound) return null;
  return supportBounceLong({ ...context, rangeBound: true });
}

function rangeBounceShort(context) {
  if (!context.rangeBound) return null;
  return resistanceRejectionShort({ ...context, rangeBound: true });
}

function makeCandidate(context, template) {
  const risk = Math.abs(Number(template.entry) - Number(template.stopLoss));
  const reward = template.direction === "long"
    ? Number(template.takeProfit) - Number(template.entry)
    : Number(template.entry) - Number(template.takeProfit);
  const rr = risk > 0 ? reward / risk : 0;
  const confirmations = template.confirmations || [];
  const passedCount = confirmations.filter((item) => item.passed).length;
  const patternScore = scoreTemplatePattern({
    confirmations,
    rr,
    volumeRatio: context.volumeRatio,
    regime: context.regime,
    detectedPatterns: context.detectedPatterns,
    direction: template.direction
  });
  const valid = passedCount >= Math.min(4, confirmations.length) &&
    rr >= minimumRiskReward &&
    Number.isFinite(risk) &&
    risk > 0;
  const confidenceScore = Math.max(50, Math.min(86, Math.round(52 + patternScore * 0.28)));

  return {
    direction: template.direction,
    timeframe: context.timeframe,
    entry: Number(template.entry),
    stopLoss: Number(template.stopLoss),
    takeProfit: Number(template.takeProfit),
    riskRewardRatio: Number(rr.toFixed(2)),
    confidenceScore,
    requiredPassCount: Math.min(4, confirmations.length),
    passedCount,
    valid,
    confirmations,
    setupType: template.strategy,
    strategySource: "historical_pattern_template",
    learnedPattern: {
      strategySource: "historical_pattern_template",
      template: slug(template.label),
      label: template.label,
      strategy: template.strategy,
      timeframe: context.timeframe,
      marketRegime: context.regime?.label || "Unknown",
      patternMatchScore: Math.round(patternScore),
      confidence: Number((patternScore / 100).toFixed(2)),
      similarityToHistoricalWinners: Number(Math.min(0.92, patternScore / 100).toFixed(2)),
      similarityToHistoricalLosers: Number(Math.max(0.08, (100 - patternScore) / 130).toFixed(2)),
      detectedPattern: bestMatchingChartPattern(context.detectedPatterns, template.direction),
      reasons: confirmations.filter((item) => item.passed).map((item) => item.detail),
      warnings: confirmations.filter((item) => !item.passed).map((item) => item.detail)
    },
    patternSimilarity: {
      similarityToHistoricalWinners: Number(Math.min(0.92, patternScore / 100).toFixed(2)),
      similarityToHistoricalLosers: Number(Math.max(0.08, (100 - patternScore) / 130).toFixed(2)),
      patternMatchScore: Math.round(patternScore)
    }
  };
}

function scoreTemplatePattern({ confirmations = [], rr = 0, volumeRatio = 1, regime = {}, detectedPatterns = [], direction }) {
  const confirmationRatio = confirmations.length
    ? confirmations.filter((item) => item.passed).length / confirmations.length
    : 0;
  const wantedBias = direction === "long" ? "bullish" : "bearish";
  const chartPattern = detectedPatterns.find((pattern) => pattern.bias === wantedBias);
  const rrScore = Math.min(14, Math.max(0, (Number(rr || 0) - minimumRiskReward) * 12));
  const volumeScore = Math.max(-8, Math.min(8, (Number(volumeRatio || 1) - 1) * 12));
  const regimePenalty = regime?.choppy ? -10 : 0;
  const patternBonus = chartPattern ? Math.min(8, Number(chartPattern.confidence || 0) * 8) : 0;
  return Math.max(0, Math.min(100, confirmationRatio * 72 + rrScore + volumeScore + patternBonus + regimePenalty));
}

function targetFromResistance(entry, stopLoss, resistance, atr) {
  const risk = Math.abs(entry - stopLoss);
  const structural = Number(resistance?.price || NaN);
  const minimumTarget = entry + risk * 1.8;
  if (Number.isFinite(structural) && structural > minimumTarget) {
    return Math.min(structural - atr * 0.15, entry + risk * 2.4);
  }
  return entry + risk * 2;
}

function targetFromSupport(entry, stopLoss, support, atr) {
  const risk = Math.abs(stopLoss - entry);
  const structural = Number(support?.price || NaN);
  const minimumTarget = entry - risk * 1.8;
  if (Number.isFinite(structural) && structural < minimumTarget) {
    return Math.max(structural + atr * 0.15, entry - risk * 2.4);
  }
  return entry - risk * 2;
}

function buildStrategyTemplates(examples = []) {
  const groups = new Map();
  for (const example of examples) {
    const key = [example.strategy, example.pair, example.timeframe, example.marketRegime, example.direction || ""].join(":");
    const group = groups.get(key) || [];
    group.push(example);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const winners = group.filter((item) => item.result === "Hit TP").length;
    const losers = group.filter((item) => item.result === "Hit SL").length;
    const expired = group.filter((item) => item.result === "Expired").length;
    const expectancy = group.reduce((sum, item) => sum + Number(item.realizedR || 0), 0) / Math.max(1, group.length);
    return {
      key,
      strategy: group[0].strategy,
      pair: group[0].pair,
      timeframe: group[0].timeframe,
      marketRegime: group[0].marketRegime,
      direction: group[0].direction || "unknown",
      examples: group.length,
      winners,
      losers,
      expired,
      expectancy: Number(expectancy.toFixed(2)),
      status: group.length >= 20 && expectancy > 0 ? "active" : "research"
    };
  });
}

function normalizePatternExample(example = {}) {
  const result = example.result || example.outcome || example.status || "Expired";
  const riskReward = Number(example.riskReward || example.riskRewardRatio || example.rr || 0);
  return {
    ...example,
    strategy: example.strategy || example.setupType || "",
    pair: example.pair || example.symbol || "",
    timeframe: example.timeframe || "",
    marketRegime: example.marketRegime || example.regime || "unknown",
    direction: example.direction || "unknown",
    result,
    riskReward,
    realizedR: Number(example.realizedR ?? (result === "Hit TP" ? riskReward : result === "Hit SL" ? -1 : 0))
  };
}

function bestMatchingChartPattern(patterns = [], direction) {
  const bias = direction === "long" ? "bullish" : "bearish";
  const pattern = patterns.find((item) => item.bias === bias) || null;
  if (!pattern) return null;
  return {
    pattern: pattern.pattern,
    label: pattern.label,
    bias: pattern.bias,
    category: pattern.category,
    confidence: pattern.confidence
  };
}

function confirm(name, passed, detail) {
  return { name, passed: Boolean(passed), detail };
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  return Number(number.toFixed(number > 1000 ? 2 : 4)).toLocaleString("en-US");
}
