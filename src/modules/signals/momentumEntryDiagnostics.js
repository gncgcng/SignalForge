const DIAGNOSTIC_VERSION = "momentum_entry_shadow_v1";
const MARKET_QUALITY_WINDOW = 40;

export const momentumEntryDiagnosticFormulas = Object.freeze({
  latestCandleRangeAtr: "(latest high - latest low) / ATR",
  latestBodyAtr: "abs(latest close - latest open) / ATR",
  bodyToRangeRatio: "abs(latest close - latest open) / (latest high - latest low)",
  breakoutDistanceAtr: "LONG: (entry - breakout level) / ATR; SHORT: (breakout level - entry) / ATR",
  ema20DistanceAtr: "LONG: (entry - EMA20) / ATR; SHORT: (EMA20 - entry) / ATR",
  ema50DistanceAtr: "LONG: (entry - EMA50) / ATR; SHORT: (EMA50 - entry) / ATR",
  stopDistanceAtr: "abs(entry - stop loss) / ATR",
  stopBeyondBreakoutCandleAtr: "LONG: (breakout candle low - stop loss) / ATR; SHORT: (stop loss - breakout candle high) / ATR",
  closeBeyondLevelAtr: "LONG: (latest close - breakout level) / ATR; SHORT: (breakout level - latest close) / ATR",
  volumeRatio: "latest volume / volume MA20",
  prior3BarMoveAtr: "LONG: (latest close - close three bars earlier) / ATR; SHORT: (close three bars earlier - latest close) / ATR",
  directionalExpansionCount3: "Consecutive latest candles, up to 3, with directional body, directional close-to-close movement, and body/range >= 0.5",
  nearZeroRangeFraction: "Fraction of the 40 pre-entry candles with range <= max(5% of median range, median close * 1e-8)",
  maxRangeToMedianRange: "maximum pre-entry candle range / median pre-entry candle range",
  maxVolumeToMedianVolume: "maximum pre-entry volume / median pre-entry volume",
  medianRecentRange: "median range of the 40 pre-entry candles",
  medianRecentVolume: "median volume of the 40 pre-entry candles"
});

export function attachMomentumEntryDiagnostics(indicatorSnapshot, context = {}) {
  if (context.setupType !== "Momentum breakout") return indicatorSnapshot;
  return {
    ...indicatorSnapshot,
    momentumEntryDiagnostics: calculateMomentumEntryDiagnostics(context)
  };
}

export function calculateMomentumEntryDiagnostics({
  candles,
  direction,
  entryPrice,
  stopLoss,
  indicators
} = {}) {
  const normalizedDirection = String(direction || "").toLowerCase();
  const latest = Array.isArray(candles) ? candles.at(-1) : null;
  const atr = positiveNumber(indicators?.atr14);
  const entry = finiteNumber(entryPrice);
  const stop = finiteNumber(stopLoss);
  const ema20 = finiteNumber(indicators?.ema20);
  const ema50 = finiteNumber(indicators?.ema50);
  const latestOpen = finiteNumber(latest?.open);
  const latestHigh = finiteNumber(latest?.high);
  const latestLow = finiteNumber(latest?.low);
  const latestClose = finiteNumber(latest?.close);
  const latestVolume = nonNegativeNumber(latest?.volume);
  const volumeMa20 = positiveNumber(indicators?.volumeMa20);
  const range = validRange(latestHigh, latestLow);
  const body = latestOpen == null || latestClose == null ? null : Math.abs(latestClose - latestOpen);
  const breakoutLevel = calculateBreakoutLevel(candles, normalizedDirection);
  const directional = (longValue, shortValue) => normalizedDirection === "long"
    ? longValue
    : normalizedDirection === "short" ? shortValue : null;
  const priorClose = Array.isArray(candles) ? finiteNumber(candles.at(-4)?.close) : null;

  return {
    version: DIAGNOSTIC_VERSION,
    latestCandleRangeAtr: divideByAtr(range, atr),
    latestBodyAtr: divideByAtr(body, atr),
    bodyToRangeRatio: safeRatio(body, range),
    breakoutDistanceAtr: divideByAtr(directionalDifference(
      normalizedDirection,
      entry,
      breakoutLevel
    ), atr),
    ema20DistanceAtr: divideByAtr(directionalDifference(normalizedDirection, entry, ema20), atr),
    ema50DistanceAtr: divideByAtr(directionalDifference(normalizedDirection, entry, ema50), atr),
    stopDistanceAtr: divideByAtr(entry == null || stop == null ? null : Math.abs(entry - stop), atr),
    stopBeyondBreakoutCandleAtr: divideByAtr(directional(
      latestLow == null || stop == null ? null : latestLow - stop,
      latestHigh == null || stop == null ? null : stop - latestHigh
    ), atr),
    closeBeyondLevelAtr: divideByAtr(directional(
      latestClose == null || breakoutLevel == null ? null : latestClose - breakoutLevel,
      latestClose == null || breakoutLevel == null ? null : breakoutLevel - latestClose
    ), atr),
    volumeRatio: safeRatio(latestVolume, volumeMa20),
    prior3BarMoveAtr: divideByAtr(directional(
      latestClose == null || priorClose == null ? null : latestClose - priorClose,
      latestClose == null || priorClose == null ? null : priorClose - latestClose
    ), atr),
    directionalExpansionCount3: calculateDirectionalExpansionCount(candles, normalizedDirection),
    marketQuality: calculateMarketQualityDiagnostics(candles)
  };
}

function calculateBreakoutLevel(candles, direction) {
  if (!Array.isArray(candles) || !["long", "short"].includes(direction)) return null;
  const priorWindow = candles.slice(-24, -3);
  const values = priorWindow
    .map((candle) => finiteNumber(direction === "long" ? candle?.high : candle?.low))
    .filter((value) => value != null);
  if (!values.length) return null;
  return direction === "long" ? Math.max(...values) : Math.min(...values);
}

function calculateDirectionalExpansionCount(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 2 || !["long", "short"].includes(direction)) return null;
  const oriented = (value) => direction === "long" ? value : -value;
  let total = 0;
  for (let index = candles.length - 1; index > 0 && total < 3; index -= 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const open = finiteNumber(candle?.open);
    const high = finiteNumber(candle?.high);
    const low = finiteNumber(candle?.low);
    const close = finiteNumber(candle?.close);
    const previousClose = finiteNumber(previous?.close);
    const range = validRange(high, low);
    if ([open, close, previousClose, range].some((value) => value == null)) break;
    if (oriented(close - open) <= 0 || oriented(close - previousClose) <= 0 || Math.abs(close - open) / range < 0.5) break;
    total += 1;
  }
  return total;
}

function calculateMarketQualityDiagnostics(candles) {
  const preEntry = Array.isArray(candles) ? candles.slice(0, -1).slice(-MARKET_QUALITY_WINDOW) : [];
  const validCandles = preEntry.map((candle) => ({
    range: validRange(finiteNumber(candle?.high), finiteNumber(candle?.low)),
    volume: nonNegativeNumber(candle?.volume),
    close: positiveNumber(candle?.close)
  }));
  const ranges = validCandles.map((item) => item.range).filter((value) => value != null);
  const volumes = validCandles.map((item) => item.volume).filter((value) => value != null);
  const closes = validCandles.map((item) => item.close).filter((value) => value != null);
  const medianRange = median(ranges);
  const medianVolume = median(volumes);
  const medianClose = median(closes);
  const nearZeroCutoff = medianRange == null || medianClose == null
    ? null
    : Math.max(medianRange * 0.05, medianClose * 1e-8);

  return {
    windowCandles: preEntry.length,
    nearZeroRangeFraction: nearZeroCutoff == null || !ranges.length
      ? null
      : round(ranges.filter((value) => value <= nearZeroCutoff).length / ranges.length),
    maxRangeToMedianRange: medianRange > 0 ? round(Math.max(...ranges) / medianRange) : null,
    maxVolumeToMedianVolume: medianVolume > 0 ? round(Math.max(...volumes) / medianVolume) : null,
    medianRecentRange: round(medianRange, 8),
    medianRecentVolume: round(medianVolume, 8)
  };
}

function directionalDifference(direction, first, second) {
  if (first == null || second == null) return null;
  if (direction === "long") return first - second;
  if (direction === "short") return second - first;
  return null;
}

function validRange(high, low) {
  if (high == null || low == null || high < low) return null;
  return high - low;
}

function safeRatio(numerator, denominator) {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return round(numerator / denominator);
}

function divideByAtr(value, atr) {
  return atr == null ? null : safeRatio(value, atr);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? number : null;
}

function median(values) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, precision = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(precision)) : null;
}
