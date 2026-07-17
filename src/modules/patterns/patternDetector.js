const MIN_CANDLES = 24;
const SHADOW_SAMPLE_MINIMUM = 30;

const patternDefinitions = Object.freeze({
  bull_flag: ["Bull Flag", "bullish", "continuation"],
  bear_flag: ["Bear Flag", "bearish", "continuation"],
  ascending_triangle: ["Ascending Triangle", "bullish", "bilateral"],
  descending_triangle: ["Descending Triangle", "bearish", "bilateral"],
  symmetrical_triangle: ["Symmetrical Triangle", "neutral", "bilateral"],
  bullish_rectangle: ["Bullish Rectangle", "bullish", "continuation"],
  bearish_rectangle: ["Bearish Rectangle", "bearish", "continuation"],
  double_top: ["Double Top", "bearish", "reversal"],
  double_bottom: ["Double Bottom", "bullish", "reversal"],
  head_and_shoulders: ["Head and Shoulders", "bearish", "reversal"],
  inverse_head_and_shoulders: ["Inverse Head and Shoulders", "bullish", "reversal"],
  choppy_range: ["Choppy Range", "neutral", "uncertain"],
  unclear_triangle: ["Unclear Triangle", "neutral", "uncertain"],
  failed_breakout: ["Failed Breakout", "neutral", "uncertain"]
});

export function detectChartPatterns(candles = [], options = {}) {
  const normalized = normalizeCandles(candles);
  if (normalized.length < MIN_CANDLES) return [];

  const context = buildContext(normalized, options);
  const detected = [
    ...detectFlags(context),
    ...detectTriangles(context),
    ...detectRectangles(context),
    ...detectReversals(context),
    ...detectUncertainPatterns(context)
  ];

  return deduplicatePatterns(detected)
    .filter((item) => item.confidence >= 0.5)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
}

export function getPrimaryPatternContext(candles = [], options = {}) {
  const detected = detectChartPatterns(candles, options);
  const directional = detected.find((item) => item.category !== "uncertain");
  return directional || detected[0] || null;
}

export function calculatePatternShadowModifier({ sampleSize = 0, observedWinRate = null } = {}) {
  if (Number(sampleSize) < SHADOW_SAMPLE_MINIMUM || !Number.isFinite(Number(observedWinRate))) return 0;
  if (Number(observedWinRate) >= 0.6) return 2;
  if (Number(observedWinRate) < 0.4) return -2;
  return 0;
}

export function patternStrength(confidence) {
  const score = Number(confidence || 0);
  if (score >= 0.82) return "strong";
  if (score >= 0.7) return "good";
  if (score >= 0.58) return "fair";
  return "weak";
}

function buildContext(candles, options) {
  const window = candles.slice(-48);
  const ranges = window.map((candle) => candle.high - candle.low);
  const averageRange = average(ranges) || Math.abs(window.at(-1).close) * 0.001 || 1;
  return {
    candles: window,
    timeframe: String(options.timeframe || "unknown"),
    detectedAt: toIso(options.detectedAt || window.at(-1).time),
    averageRange,
    tolerance: Math.max(averageRange * 0.7, Math.abs(window.at(-1).close) * 0.0025),
    volumeAvailable: window.some((candle) => Number(candle.volume) > 0),
    pivots: findPivots(window)
  };
}

function detectFlags(context) {
  const candles = context.candles.slice(-36);
  const impulseLength = 12;
  const impulse = candles.slice(0, impulseLength);
  const consolidation = candles.slice(impulseLength);
  if (consolidation.length < 10) return [];

  const impulseMove = impulse.at(-1).close - impulse[0].open;
  const impulseStrength = Math.abs(impulseMove) / Math.max(context.averageRange, Number.EPSILON);
  const closeSlope = regressionSlope(consolidation.map((candle) => candle.close));
  const consolidationRange = rangeOf(consolidation);
  const retracement = consolidationRange / Math.max(Math.abs(impulseMove), Number.EPSILON);
  const volumeRatio = average(consolidation.map((candle) => candle.volume)) /
    Math.max(average(impulse.map((candle) => candle.volume)), Number.EPSILON);
  const decreasingVolume = !context.volumeAvailable || volumeRatio <= 0.95;
  const slopeLimit = context.averageRange * 0.13;
  const results = [];

  if (impulseStrength >= 5 && impulseMove > 0 && closeSlope <= slopeLimit && closeSlope >= -context.averageRange * 0.35 && retracement <= 0.68) {
    results.push(makePattern(context, "bull_flag", clamp01(0.56 + impulseStrength * 0.025 + (decreasingVolume ? 0.08 : 0) + (retracement <= 0.5 ? 0.06 : 0)), {
      resistance: Math.max(...consolidation.map((candle) => candle.high)),
      support: Math.min(...consolidation.map((candle) => candle.low)),
      breakoutLevel: Math.max(...consolidation.map((candle) => candle.high)),
      invalidation: Math.min(...consolidation.map((candle) => candle.low))
    }, ["Strong impulse move before consolidation", "Price is consolidating after the bullish impulse", ...(decreasingVolume ? ["Volume is decreasing during consolidation"] : [])], breakoutWarnings(context, consolidation, "bullish", decreasingVolume)));
  }

  if (impulseStrength >= 5 && impulseMove < 0 && closeSlope >= -slopeLimit && closeSlope <= context.averageRange * 0.35 && retracement <= 0.68) {
    results.push(makePattern(context, "bear_flag", clamp01(0.56 + impulseStrength * 0.025 + (decreasingVolume ? 0.08 : 0) + (retracement <= 0.5 ? 0.06 : 0)), {
      resistance: Math.max(...consolidation.map((candle) => candle.high)),
      support: Math.min(...consolidation.map((candle) => candle.low)),
      breakoutLevel: Math.min(...consolidation.map((candle) => candle.low)),
      invalidation: Math.max(...consolidation.map((candle) => candle.high))
    }, ["Strong bearish impulse move before consolidation", "Price is consolidating after the bearish impulse", ...(decreasingVolume ? ["Volume is decreasing during consolidation"] : [])], breakoutWarnings(context, consolidation, "bearish", decreasingVolume)));
  }

  return results;
}

function detectTriangles(context) {
  const recent = context.candles.slice(-22);
  const highSlope = regressionSlope(recent.map((candle) => candle.high));
  const lowSlope = regressionSlope(recent.map((candle) => candle.low));
  const flatLimit = Math.max(Math.abs(recent.at(-1).close) * 0.0005, context.averageRange * 0.02);
  const directionalSlope = Math.max(Math.abs(recent.at(-1).close) * 0.0008, context.averageRange * 0.015);
  const startWidth = recent[0].high - recent[0].low;
  const endWidth = recent.at(-1).high - recent.at(-1).low;
  const converging = endWidth < startWidth * 0.78 || highSlope - lowSlope < -context.averageRange * 0.08;
  const resistance = Math.max(...recent.map((candle) => candle.high));
  const support = Math.min(...recent.map((candle) => candle.low));
  const results = [];

  if (Math.abs(highSlope) <= flatLimit && lowSlope >= directionalSlope && converging) {
    results.push(makePattern(context, "ascending_triangle", slopeConfidence(highSlope, lowSlope, context), { resistance, support, breakoutLevel: resistance, invalidation: support }, ["Resistance is holding near a common level", "Swing lows are rising", "The trading range is contracting"], ["Breakout confirmation missing"]));
  }
  if (Math.abs(lowSlope) <= flatLimit && highSlope <= -directionalSlope && converging) {
    results.push(makePattern(context, "descending_triangle", slopeConfidence(highSlope, lowSlope, context), { resistance, support, breakoutLevel: support, invalidation: resistance }, ["Support is holding near a common level", "Swing highs are falling", "The trading range is contracting"], ["Breakdown confirmation missing"]));
  }
  if (highSlope <= -directionalSlope && lowSlope >= directionalSlope && converging) {
    results.push(makePattern(context, "symmetrical_triangle", slopeConfidence(highSlope, lowSlope, context), { resistance, support, breakoutLevel: null, invalidation: null }, ["Swing highs are falling", "Swing lows are rising", "Price is compressing without a confirmed direction"], ["Direction remains unconfirmed until price closes outside the triangle"]));
  }
  return results;
}

function detectRectangles(context) {
  const recent = context.candles.slice(-20);
  const prior = context.candles.slice(-32, -20);
  if (prior.length < 8) return [];
  const highSlope = Math.abs(regressionSlope(recent.map((candle) => candle.high)));
  const lowSlope = Math.abs(regressionSlope(recent.map((candle) => candle.low)));
  const flat = highSlope <= context.averageRange * 0.075 && lowSlope <= context.averageRange * 0.075;
  const band = rangeOf(recent);
  const priorMove = prior.at(-1).close - prior[0].open;
  if (!flat || band > context.averageRange * 5.5 || Math.abs(priorMove) < context.averageRange * 2.5) return [];
  const key = priorMove > 0 ? "bullish_rectangle" : "bearish_rectangle";
  const resistance = Math.max(...recent.map((candle) => candle.high));
  const support = Math.min(...recent.map((candle) => candle.low));
  return [makePattern(context, key, clamp01(0.62 + Math.min(0.16, Math.abs(priorMove) / context.averageRange * 0.02)), {
    resistance, support, breakoutLevel: priorMove > 0 ? resistance : support, invalidation: priorMove > 0 ? support : resistance
  }, ["Price is consolidating between repeated support and resistance", `${priorMove > 0 ? "Bullish" : "Bearish"} momentum preceded the rectangle`], ["A close outside the rectangle is still required"] )];
}

function detectReversals(context) {
  const highs = context.pivots.highs.slice(-6);
  const lows = context.pivots.lows.slice(-6);
  highs.candles = context.candles;
  lows.candles = context.candles;
  const results = [];
  const top = findDouble(highs, "high", context.tolerance);
  const bottom = findDouble(lows, "low", context.tolerance);

  if (top) results.push(makePattern(context, "double_top", top.confidence, { resistance: average([top.first.price, top.second.price]), neckline: top.middlePrice, support: top.middlePrice, invalidation: Math.max(top.first.price, top.second.price) + context.tolerance }, ["Two swing highs formed near the same resistance", "Price pulled back between the two peaks"], ["Neckline breakdown is required for reversal confirmation"]));
  if (bottom) results.push(makePattern(context, "double_bottom", bottom.confidence, { support: average([bottom.first.price, bottom.second.price]), neckline: bottom.middlePrice, resistance: bottom.middlePrice, invalidation: Math.min(bottom.first.price, bottom.second.price) - context.tolerance }, ["Two swing lows formed near the same support", "Price bounced between the two troughs"], ["Neckline breakout is required for reversal confirmation"]));

  const shoulders = findShoulders(highs, "high", context.tolerance);
  const inverseShoulders = findShoulders(lows, "low", context.tolerance);
  if (shoulders) results.push(makePattern(context, "head_and_shoulders", shoulders.confidence, { resistance: shoulders.head.price, neckline: shoulders.neckline, support: shoulders.neckline, invalidation: shoulders.head.price + context.tolerance }, ["The middle swing high is above both shoulders", "Left and right shoulders formed at similar levels"], ["Neckline breakdown is required for reversal confirmation"]));
  if (inverseShoulders) results.push(makePattern(context, "inverse_head_and_shoulders", inverseShoulders.confidence, { support: inverseShoulders.head.price, neckline: inverseShoulders.neckline, resistance: inverseShoulders.neckline, invalidation: inverseShoulders.head.price - context.tolerance }, ["The middle swing low is below both shoulders", "Left and right shoulders formed at similar levels"], ["Neckline breakout is required for reversal confirmation"]));
  return results;
}

function detectUncertainPatterns(context) {
  const recent = context.candles.slice(-24);
  const closes = recent.map((candle) => candle.close);
  const netMove = Math.abs(closes.at(-1) - closes[0]);
  const path = closes.slice(1).reduce((sum, close, index) => sum + Math.abs(close - closes[index]), 0);
  const efficiency = path ? netMove / path : 0;
  const highSlope = regressionSlope(recent.map((candle) => candle.high));
  const lowSlope = regressionSlope(recent.map((candle) => candle.low));
  const converging = highSlope < 0 && lowSlope > 0;
  const prior = recent.slice(0, -2);
  const previous = recent.at(-2);
  const latest = recent.at(-1);
  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const priorLow = Math.min(...prior.map((candle) => candle.low));
  const results = [];

  if (efficiency < 0.22 && rangeOf(recent) <= context.averageRange * 6.5) {
    results.push(makePattern(context, "choppy_range", clamp01(0.68 + (0.22 - efficiency)), { support: priorLow, resistance: priorHigh }, ["Price has repeatedly reversed inside a limited range", "Directional efficiency is low"], ["No clean directional structure is available"]));
  }
  if (converging && Math.abs(highSlope + lowSlope) > context.averageRange * 0.18) {
    results.push(makePattern(context, "unclear_triangle", 0.58, { support: priorLow, resistance: priorHigh }, ["Price is compressing", "Triangle boundaries are uneven or conflicting"], ["Pattern direction is unclear"]));
  }
  if ((previous.close > priorHigh && latest.close <= priorHigh) || (previous.close < priorLow && latest.close >= priorLow)) {
    results.push(makePattern(context, "failed_breakout", 0.76, { support: priorLow, resistance: priorHigh, breakoutLevel: previous.close > priorHigh ? priorHigh : priorLow }, ["Price moved outside recent structure", "The latest candle closed back inside the prior range"], ["The attempted breakout failed confirmation"]));
  }
  return results;
}

function makePattern(context, pattern, confidence, keyLevels = {}, reasons = [], warnings = []) {
  const definition = patternDefinitions[pattern];
  return {
    pattern,
    label: definition[0],
    bias: definition[1],
    category: definition[2],
    confidence: Number(clamp01(confidence).toFixed(2)),
    strength: patternStrength(confidence),
    timeframe: context.timeframe,
    detectedAt: context.detectedAt,
    keyLevels: {
      breakoutLevel: finiteOrNull(keyLevels.breakoutLevel),
      neckline: finiteOrNull(keyLevels.neckline),
      support: finiteOrNull(keyLevels.support),
      resistance: finiteOrNull(keyLevels.resistance),
      invalidation: finiteOrNull(keyLevels.invalidation)
    },
    reasons: unique(reasons),
    warnings: unique(warnings),
    shadowMode: true,
    confidenceModifier: 0,
    minimumSamplesForWeighting: SHADOW_SAMPLE_MINIMUM,
    disclaimer: "Pattern recognition supports the setup analysis, but it does not guarantee direction or outcome."
  };
}

function findDouble(pivots, type, tolerance) {
  for (let right = pivots.length - 1; right >= 1; right -= 1) {
    for (let left = right - 1; left >= 0; left -= 1) {
      const first = pivots[left];
      const second = pivots[right];
      if (second.index - first.index < 4 || Math.abs(first.price - second.price) > tolerance * 1.5) continue;
      const between = pivots.candles?.slice(first.index + 1, second.index) || [];
      const middlePrice = type === "high"
        ? Math.min(...between.map((candle) => candle.low))
        : Math.max(...between.map((candle) => candle.high));
      if (!Number.isFinite(middlePrice)) continue;
      const depth = type === "high" ? Math.min(first.price, second.price) - middlePrice : middlePrice - Math.max(first.price, second.price);
      if (depth < tolerance * 1.2) continue;
      return { first, second, middlePrice, confidence: clamp01(0.67 + Math.min(0.18, depth / Math.max(tolerance, Number.EPSILON) * 0.03)) };
    }
  }
  return null;
}

function findShoulders(pivots, type, tolerance) {
  if (pivots.length < 3) return null;
  for (let index = pivots.length - 3; index >= 0; index -= 1) {
    const [left, head, right] = pivots.slice(index, index + 3);
    const shoulderMatch = Math.abs(left.price - right.price) <= tolerance * 1.8;
    const headDistance = type === "high"
      ? head.price - Math.max(left.price, right.price)
      : Math.min(left.price, right.price) - head.price;
    if (!shoulderMatch || headDistance < tolerance * 1.2) continue;
    const between = pivots.candles || [];
    const firstNeck = between.slice(left.index + 1, head.index).map((candle) => type === "high" ? candle.low : candle.high);
    const secondNeck = between.slice(head.index + 1, right.index).map((candle) => type === "high" ? candle.low : candle.high);
    const neckline = average([
      type === "high" ? Math.min(...firstNeck) : Math.max(...firstNeck),
      type === "high" ? Math.min(...secondNeck) : Math.max(...secondNeck)
    ]);
    if (!Number.isFinite(neckline)) continue;
    return { left, head, right, neckline, confidence: clamp01(0.72 + Math.min(0.16, headDistance / Math.max(tolerance, Number.EPSILON) * 0.025)) };
  }
  return null;
}

function findPivots(candles) {
  const highs = [];
  const lows = [];
  for (let index = 2; index < candles.length - 2; index += 1) {
    const before = candles.slice(index - 2, index);
    const after = candles.slice(index + 1, index + 3);
    const neighbors = [...before, ...after];
    if (neighbors.every((item) => candles[index].high >= item.high) && neighbors.some((item) => candles[index].high > item.high)) highs.push({ index, price: candles[index].high, time: candles[index].time });
    if (neighbors.every((item) => candles[index].low <= item.low) && neighbors.some((item) => candles[index].low < item.low)) lows.push({ index, price: candles[index].low, time: candles[index].time });
  }
  highs.candles = candles;
  lows.candles = candles;
  return { highs, lows };
}

function normalizeCandles(candles) {
  return candles.map((candle, index) => ({
    time: candle.time ?? index,
    open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume || 0)
  })).filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) && candle.high >= candle.low && candle.high >= Math.max(candle.open, candle.close) && candle.low <= Math.min(candle.open, candle.close));
}

function breakoutWarnings(context, candles, bias, decreasingVolume) {
  const latest = candles.at(-1);
  const boundary = bias === "bullish" ? Math.max(...candles.slice(0, -1).map((candle) => candle.high)) : Math.min(...candles.slice(0, -1).map((candle) => candle.low));
  const confirmed = bias === "bullish" ? latest.close > boundary : latest.close < boundary;
  return [...(!confirmed ? ["Breakout confirmation missing"] : []), ...(!decreasingVolume && context.volumeAvailable ? ["Consolidation volume has not contracted"] : [])];
}

function slopeConfidence(highSlope, lowSlope, context) {
  return clamp01(0.64 + Math.min(0.2, (Math.abs(highSlope) + Math.abs(lowSlope)) / Math.max(context.averageRange, Number.EPSILON) * 0.25));
}

function deduplicatePatterns(patterns) {
  const byPattern = new Map();
  for (const item of patterns) {
    if (!item || !patternDefinitions[item.pattern]) continue;
    const existing = byPattern.get(item.pattern);
    if (!existing || item.confidence > existing.confidence) byPattern.set(item.pattern, item);
  }
  return [...byPattern.values()];
}

function regressionSlope(values) {
  if (values.length < 2) return 0;
  const meanX = (values.length - 1) / 2;
  const meanY = average(values);
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - meanX) * (value - meanY);
    denominator += (index - meanX) ** 2;
  });
  return denominator ? numerator / denominator : 0;
}

function rangeOf(candles) {
  return Math.max(...candles.map((candle) => candle.high)) - Math.min(...candles.map((candle) => candle.low));
}

function average(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(8)) : null;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value || 0)));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function toIso(value) {
  if (typeof value === "number" && value < 1e12) value *= 1000;
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export { MIN_CANDLES, SHADOW_SAMPLE_MINIMUM, patternDefinitions };
