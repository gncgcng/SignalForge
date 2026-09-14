import { analyzeMarketRegime } from "./marketRegimeService.js";

const minimumCandles = 60;
const adxThreshold = 22;
const rsiUpThreshold = 48;
const rsiDownThreshold = 52;
const breakoutAtrRatioThreshold = 1.05;

/**
 * Read-only diagnostic wrapper around analyzeMarketRegime. Reuses the real classifier for
 * finalLabel, and separately recomputes the same intermediates (duplicated on purpose, not
 * imported, so this file can never affect the live trading path) so every sub-condition can be
 * inspected individually instead of only the final label. If diagnosticLabel and finalLabel
 * ever disagree, that mismatch itself is the bug to chase -- see agreesWithProduction below.
 */
export function diagnoseMarketRegimeClassification(candles) {
  const result = analyzeMarketRegime(candles);

  if (!Array.isArray(candles) || candles.length < minimumCandles) {
    return {
      finalLabel: result.label,
      diagnosticLabel: result.label,
      agreesWithProduction: true,
      insufficientCandles: true,
      subConditions: null,
      trendUpConditionsMetCount: null,
      trendDownConditionsMetCount: null
    };
  }

  const closes = candles.map((candle) => candle.close);
  const latest = candles[candles.length - 1];
  const ema20 = latestValue(ema(closes, 20));
  const ema50 = latestValue(ema(closes, 50));
  const atrSeries = atr(candles, 14);
  const atr14 = latestValue(atrSeries);
  const adx14 = latestValue(adx(candles, 14));
  const rsi14 = latestValue(rsi(closes, 14));
  const recentAtr = atrSeries.filter(Number.isFinite).slice(-50);
  const medianAtr = median(recentAtr);
  const atrRatio = medianAtr > 0 ? atr14 / medianAtr : 1;
  const volatilityLevel = atrRatio >= 1.5
    ? "High"
    : atrRatio <= 0.68
      ? "Low"
      : "Normal";
  const prior = candles.slice(-22, -2);
  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const priorLow = Math.min(...prior.map((candle) => candle.low));
  const recent = candles.slice(-12);
  const firstHalf = recent.slice(0, 6);
  const secondHalf = recent.slice(6);
  const structureUp = Math.max(...secondHalf.map((candle) => candle.high)) >
      Math.max(...firstHalf.map((candle) => candle.high)) &&
    Math.min(...secondHalf.map((candle) => candle.low)) >
      Math.min(...firstHalf.map((candle) => candle.low));
  const structureDown = Math.max(...secondHalf.map((candle) => candle.high)) <
      Math.max(...firstHalf.map((candle) => candle.high)) &&
    Math.min(...secondHalf.map((candle) => candle.low)) <
      Math.min(...firstHalf.map((candle) => candle.low));
  const breakoutUp = latest.close > priorHigh && latest.close > ema20 && atrRatio >= breakoutAtrRatioThreshold;
  const breakoutDown = latest.close < priorLow && latest.close < ema20 && atrRatio >= breakoutAtrRatioThreshold;

  const emaAlignedUp = ema20 > ema50;
  const emaAlignedDown = ema20 < ema50;
  const priceAboveEma20 = latest.close > ema20;
  const priceBelowEma20 = latest.close < ema20;
  const adxPass = adx14 >= adxThreshold;
  const rsiPassUp = rsi14 >= rsiUpThreshold;
  const rsiPassDown = rsi14 <= rsiDownThreshold;

  const trendUp = emaAlignedUp && priceAboveEma20 && adxPass && rsiPassUp && structureUp;
  const trendDown = emaAlignedDown && priceBelowEma20 && adxPass && rsiPassDown && structureDown;

  let diagnosticLabel = "Range";
  if (breakoutUp || breakoutDown) {
    diagnosticLabel = "Breakout";
  } else if (volatilityLevel === "High") {
    diagnosticLabel = "High Volatility";
  } else if (volatilityLevel === "Low") {
    diagnosticLabel = "Low Volatility";
  } else if (trendUp) {
    diagnosticLabel = "Trend Up";
  } else if (trendDown) {
    diagnosticLabel = "Trend Down";
  }

  const trendUpConditions = [emaAlignedUp, priceAboveEma20, adxPass, rsiPassUp, structureUp];
  const trendDownConditions = [emaAlignedDown, priceBelowEma20, adxPass, rsiPassDown, structureDown];

  return {
    finalLabel: result.label,
    diagnosticLabel,
    agreesWithProduction: diagnosticLabel === result.label,
    insufficientCandles: false,
    subConditions: {
      breakoutUp,
      breakoutDown,
      volatilityLevel,
      emaAlignedUp,
      emaAlignedDown,
      priceAboveEma20,
      priceBelowEma20,
      adxPass,
      rsiPassUp,
      rsiPassDown,
      structureUp,
      structureDown
    },
    trendUpConditionsMetCount: trendUpConditions.filter(Boolean).length,
    trendDownConditionsMetCount: trendDownConditions.filter(Boolean).length
  };
}

function adx(candles, period) {
  const trueRanges = [];
  const plusDm = [];
  const minusDm = [];

  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const trSmooth = wilders(trueRanges, period);
  const plusSmooth = wilders(plusDm, period);
  const minusSmooth = wilders(minusDm, period);
  const dx = trSmooth.map((tr, index) => {
    if (!Number.isFinite(tr) || tr === 0) return null;
    const plusDi = (plusSmooth[index] / tr) * 100;
    const minusDi = (minusSmooth[index] / tr) * 100;
    const total = plusDi + minusDi;
    return total === 0 ? 0 : (Math.abs(plusDi - minusDi) / total) * 100;
  });
  return wilders(dx.map((value) => Number.isFinite(value) ? value : 0), period);
}

function wilders(values, period) {
  const output = Array(values.length).fill(null);
  if (values.length < period) return output;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  output[period - 1] = value;
  for (let index = period; index < values.length; index += 1) {
    value = (value * (period - 1) + values[index]) / period;
    output[index] = value;
  }
  return output;
}

function ema(values, period) {
  const output = Array(values.length).fill(null);
  const multiplier = 2 / (period + 1);
  let previous = null;
  for (let index = period - 1; index < values.length; index += 1) {
    if (previous === null) {
      previous = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    } else {
      previous = (values[index] - previous) * multiplier + previous;
    }
    output[index] = previous;
  }
  return output;
}

function rsi(values, period) {
  const output = Array(values.length).fill(null);
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  output[period] = rsiValue(averageGain, averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = rsiValue(averageGain, averageLoss);
  }
  return output;
}

function rsiValue(gain, loss) {
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function atr(candles, period) {
  const ranges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - candles[index - 1].close),
      Math.abs(candle.low - candles[index - 1].close)
    );
  });
  return wilders(ranges, period);
}

function latestValue(values) {
  return values.findLast(Number.isFinite);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
