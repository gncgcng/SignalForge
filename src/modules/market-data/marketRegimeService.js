const minimumCandles = 60;

export function analyzeMarketRegime(candles) {
  if (!Array.isArray(candles) || candles.length < minimumCandles) {
    return {
      label: "Range",
      volatilityLevel: "Unknown",
      explanation: "Not enough candles are available for reliable regime detection.",
      metrics: {}
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
  const atrPercent = latest.close > 0 ? (atr14 / latest.close) * 100 : 0;
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
  const breakoutUp = latest.close > priorHigh && latest.close > ema20 && atrRatio >= 1.05;
  const breakoutDown = latest.close < priorLow && latest.close < ema20 && atrRatio >= 1.05;
  const trendUp = ema20 > ema50 && latest.close > ema20 && adx14 >= 22 &&
    rsi14 >= 48 && structureUp;
  const trendDown = ema20 < ema50 && latest.close < ema20 && adx14 >= 22 &&
    rsi14 <= 52 && structureDown;
  const levels = detectStructureLevels(candles);
  const trendStrength = atr14 > 0 ? Math.abs(ema20 - ema50) / atr14 : 0;
  const path = recent.slice(1).reduce((sum, candle, index) => {
    return sum + Math.abs(candle.close - recent[index].close);
  }, 0);
  const efficiencyRatio = path > 0
    ? Math.abs(recent[recent.length - 1].close - recent[0].close) / path
    : 0;
  let label = "Range";

  if (breakoutUp || breakoutDown) {
    label = "Breakout";
  } else if (volatilityLevel === "High") {
    label = "High Volatility";
  } else if (volatilityLevel === "Low") {
    label = "Low Volatility";
  } else if (trendUp) {
    label = "Trend Up";
  } else if (trendDown) {
    label = "Trend Down";
  }

  return {
    label,
    volatilityLevel,
    explanation: buildExplanation({
      label,
      volatilityLevel,
      ema20,
      ema50,
      latest,
      atrPercent,
      atrRatio,
      adx14,
      rsi14,
      structureUp,
      structureDown,
      breakoutUp,
      breakoutDown,
      levels
    }),
    preferredDirection: label === "Trend Up"
      ? "long"
      : label === "Trend Down"
        ? "short"
        : breakoutUp
          ? "long"
          : breakoutDown
            ? "short"
            : "both",
    preferredSetups: preferredSetups(label),
    choppy: label === "Range",
    atrPass: volatilityLevel !== "Low" && Number.isFinite(atrPercent) && atrPercent <= 12,
    trendStrength,
    efficiencyRatio,
    strongLevel: false,
    metrics: {
      ema20: round(ema20),
      ema50: round(ema50),
      atr14: round(atr14),
      atrPercent: round(atrPercent),
      atrRatio: round(atrRatio),
      adx14: round(adx14),
      rsi14: round(rsi14),
      support: round(levels.support),
      resistance: round(levels.resistance),
      structure: structureUp ? "Higher highs / higher lows" : structureDown ? "Lower highs / lower lows" : "Mixed"
    }
  };
}

function preferredSetups(label) {
  if (label === "Trend Up" || label === "Trend Down") {
    return ["Trend continuation", "Pullback bounce"];
  }
  if (label === "Range") return ["Reversal"];
  if (label === "Breakout") return ["Breakout retest"];
  return [];
}

function buildExplanation(context) {
  const emaDirection = context.ema20 > context.ema50 ? "above" : "below";
  const base = `EMA20 is ${emaDirection} EMA50, ADX is ${round(context.adx14)}, RSI is ${round(context.rsi14)}, and ATR is ${round(context.atrPercent)}% of price (${context.volatilityLevel.toLowerCase()} volatility).`;

  if (context.label === "Breakout") {
    return `${base} Price closed ${context.breakoutUp ? "above resistance" : "below support"} with expanding ATR, indicating a breakout that still requires a retest.`;
  }
  if (context.label === "Trend Up") {
    return `${base} Price is above both EMAs and structure is printing higher highs and higher lows.`;
  }
  if (context.label === "Trend Down") {
    return `${base} Price is below both EMAs and structure is printing lower highs and lower lows.`;
  }
  if (context.label === "High Volatility") {
    return `${base} ATR is ${round(context.atrRatio)}x its recent median, so stops need more room and confidence is reduced.`;
  }
  if (context.label === "Low Volatility") {
    return `${base} ATR is only ${round(context.atrRatio)}x its recent median, so SignalForge avoids forcing a trade.`;
  }
  return `${base} ADX and price structure do not confirm a directional trend; price is rotating between support ${round(context.levels.support)} and resistance ${round(context.levels.resistance)}.`;
}

function detectStructureLevels(candles) {
  const recent = candles.slice(-40);
  return {
    support: Math.min(...recent.map((candle) => candle.low)),
    resistance: Math.max(...recent.map((candle) => candle.high))
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

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}
