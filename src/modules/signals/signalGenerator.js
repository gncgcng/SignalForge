import { appConfig } from "../../config/appConfig.js";
import { createId } from "../../shared/ids.js";

const minimumCandles = 60;

export function generateMarketDataSetup(marketData, timeframe) {
  if (!appConfig.supportedTimeframes.includes(timeframe)) {
    throw new Error("Unsupported timeframe.");
  }

  const candles = marketData.candles;

  if (candles.length < minimumCandles) {
    return noSetup("Not enough candles to calculate reliable indicators.", marketData, timeframe, []);
  }

  const indicators = calculateIndicators(candles);
  const latest = candles[candles.length - 1];
  const levels = detectSupportResistance(candles);
  const isCommodity = marketData.pair.assetClass === "Commodity";
  const longCase = isCommodity
    ? evaluateCommodityLong(latest, indicators, levels)
    : evaluateCryptoLong(latest, indicators, levels, marketData.volumeAvailable !== false);
  const shortCase = isCommodity
    ? evaluateCommodityShort(latest, indicators, levels)
    : evaluateCryptoShort(latest, indicators, levels, marketData.volumeAvailable !== false);
  const bestCase = [longCase, shortCase]
    .filter((candidate) => candidate.valid)
    .sort((a, b) => b.passedCount - a.passedCount || b.confidenceScore - a.confidenceScore)[0];

  if (!bestCase) {
    return noSetup(
      isCommodity
        ? "No valid commodity setup found. EMA trend, RSI, ATR, support, and resistance are not sufficiently aligned."
        : "No valid setup found. Conditions are too mixed for a high-probability entry.",
      marketData,
      timeframe,
      [longCase, shortCase]
    );
  }

  return {
    valid: true,
    signal: {
      id: createId("sig"),
      symbol: marketData.pair.symbol,
      timeframe,
      direction: bestCase.direction,
      entryPrice: roundPrice(bestCase.entry),
      stopLoss: roundPrice(bestCase.stopLoss),
      takeProfit: roundPrice(bestCase.takeProfit),
      riskRewardRatio: Number(bestCase.riskRewardRatio.toFixed(2)),
      confidenceScore: bestCase.confidenceScore,
      reasoning: buildReasoning(bestCase, indicators, levels, isCommodity),
      confirmations: bestCase.confirmations,
      indicators: serializeIndicators(indicators, levels),
      generatedAt: new Date().toISOString(),
      marketSource: marketData.source
    },
    analysis: {
      message: "Valid setup found.",
      confirmations: bestCase.confirmations,
      indicators: serializeIndicators(indicators, levels)
    }
  };
}

function evaluateCryptoLong(latest, indicators, levels, volumeAvailable) {
  const support = levels.nearestSupport;
  const resistance = levels.nearestResistance;
  const entry = latest.close;
  const atr = indicators.atr14;
  const swingStop = support ? support.price - atr * 0.2 : null;
  const atrStop = entry - atr * 1.4;
  const stopLoss = swingStop && entry - swingStop <= atr * 3 ? swingStop : atrStop;
  const risk = entry - stopLoss;
  const roomToResistance = resistance ? resistance.price - entry : atr * 4;
  const confirmations = [
    confirmation("Trend", indicators.ema20 > indicators.ema50 && entry > indicators.ema20, `EMA20 ${formatNumber(indicators.ema20)} is above EMA50 ${formatNumber(indicators.ema50)} and price is above EMA20.`),
    confirmation("RSI", indicators.rsi14 >= 45 && indicators.rsi14 <= 68, `RSI14 is ${formatNumber(indicators.rsi14)}, favoring bullish momentum without being overextended.`),
    atrConfirmation(atr, entry),
    volumeConfirmation(latest, indicators, volumeAvailable),
    confirmation("Support", Boolean(support) && entry > support.price && entry - support.price <= atr * 2.5, support ? `Price is holding above swing support near ${formatNumber(support.price)}.` : "No recent swing support found."),
    confirmation("Resistance room", roomToResistance >= risk * 1.5, resistance ? `Nearest resistance leaves ${formatNumber(roomToResistance / risk)}R of upside room.` : "No nearby resistance overhead.")
  ];

  return buildCandidate("long", entry, stopLoss, confirmations, risk, 5);
}

function evaluateCryptoShort(latest, indicators, levels, volumeAvailable) {
  const support = levels.nearestSupport;
  const resistance = levels.nearestResistance;
  const entry = latest.close;
  const atr = indicators.atr14;
  const swingStop = resistance ? resistance.price + atr * 0.2 : null;
  const atrStop = entry + atr * 1.4;
  const stopLoss = swingStop && swingStop - entry <= atr * 3 ? swingStop : atrStop;
  const risk = stopLoss - entry;
  const roomToSupport = support ? entry - support.price : atr * 4;
  const confirmations = [
    confirmation("Trend", indicators.ema20 < indicators.ema50 && entry < indicators.ema20, `EMA20 ${formatNumber(indicators.ema20)} is below EMA50 ${formatNumber(indicators.ema50)} and price is below EMA20.`),
    confirmation("RSI", indicators.rsi14 >= 32 && indicators.rsi14 <= 55, `RSI14 is ${formatNumber(indicators.rsi14)}, favoring bearish momentum without being deeply oversold.`),
    atrConfirmation(atr, entry),
    volumeConfirmation(latest, indicators, volumeAvailable),
    confirmation("Resistance", Boolean(resistance) && resistance.price > entry && resistance.price - entry <= atr * 2.5, resistance ? `Price is rejecting below swing resistance near ${formatNumber(resistance.price)}.` : "No recent swing resistance found."),
    confirmation("Support room", roomToSupport >= risk * 1.5, support ? `Nearest support leaves ${formatNumber(roomToSupport / risk)}R of downside room.` : "No nearby support underneath.")
  ];

  return buildCandidate("short", entry, stopLoss, confirmations, risk, 5);
}

function evaluateCommodityLong(latest, indicators, levels) {
  const support = levels.nearestSupport;
  const resistance = levels.nearestResistance;
  const entry = latest.close;
  const atr = indicators.atr14;
  const swingStop = support ? support.price - atr * 0.2 : null;
  const atrStop = entry - atr * 1.4;
  const stopLoss = swingStop && entry - swingStop <= atr * 3 ? swingStop : atrStop;
  const risk = entry - stopLoss;
  const roomToResistance = resistance ? resistance.price - entry : atr * 4;
  const confirmations = [
    confirmation("Trend", entry > indicators.ema20, `Price ${formatNumber(entry)} is above EMA20 ${formatNumber(indicators.ema20)}.`),
    confirmation("EMA structure", indicators.ema20 > indicators.ema50, `EMA20 ${formatNumber(indicators.ema20)} is above EMA50 ${formatNumber(indicators.ema50)}.`),
    confirmation("RSI", indicators.rsi14 >= 45 && indicators.rsi14 <= 70, `RSI14 is ${formatNumber(indicators.rsi14)}, supporting bullish momentum without excessive extension.`),
    atrConfirmation(atr, entry),
    confirmation("Support", Boolean(support) && entry > support.price && entry - support.price <= atr * 3, support ? `Price is holding above commodity swing support near ${formatNumber(support.price)}.` : "No recent commodity swing support found."),
    confirmation("Resistance", roomToResistance >= risk * 1.5, resistance ? `Resistance near ${formatNumber(resistance.price)} leaves ${formatNumber(roomToResistance / risk)}R of upside room.` : "No nearby commodity resistance overhead.")
  ];

  return buildCandidate("long", entry, stopLoss, confirmations, risk, 5);
}

function evaluateCommodityShort(latest, indicators, levels) {
  const support = levels.nearestSupport;
  const resistance = levels.nearestResistance;
  const entry = latest.close;
  const atr = indicators.atr14;
  const swingStop = resistance ? resistance.price + atr * 0.2 : null;
  const atrStop = entry + atr * 1.4;
  const stopLoss = swingStop && swingStop - entry <= atr * 3 ? swingStop : atrStop;
  const risk = stopLoss - entry;
  const roomToSupport = support ? entry - support.price : atr * 4;
  const confirmations = [
    confirmation("Trend", entry < indicators.ema20, `Price ${formatNumber(entry)} is below EMA20 ${formatNumber(indicators.ema20)}.`),
    confirmation("EMA structure", indicators.ema20 < indicators.ema50, `EMA20 ${formatNumber(indicators.ema20)} is below EMA50 ${formatNumber(indicators.ema50)}.`),
    confirmation("RSI", indicators.rsi14 >= 30 && indicators.rsi14 <= 55, `RSI14 is ${formatNumber(indicators.rsi14)}, supporting bearish momentum without deep oversold conditions.`),
    atrConfirmation(atr, entry),
    confirmation("Resistance", Boolean(resistance) && resistance.price > entry && resistance.price - entry <= atr * 3, resistance ? `Price is trading below commodity swing resistance near ${formatNumber(resistance.price)}.` : "No recent commodity swing resistance found."),
    confirmation("Support", roomToSupport >= risk * 1.5, support ? `Support near ${formatNumber(support.price)} leaves ${formatNumber(roomToSupport / risk)}R of downside room.` : "No nearby commodity support underneath.")
  ];

  return buildCandidate("short", entry, stopLoss, confirmations, risk, 5);
}

function buildCandidate(direction, entry, stopLoss, confirmations, risk, requiredPassCount = 4) {
  const passedCount = confirmations.filter((item) => item.passed).length;
  const valid = passedCount >= requiredPassCount && Number.isFinite(risk) && risk > 0;
  const rewardMultiple = Math.min(2.5, Math.max(1.5, 1.5 + (passedCount - 3) * 0.35));
  const targetDistance = risk * rewardMultiple;
  const takeProfit = direction === "long" ? entry + targetDistance : entry - targetDistance;

  return {
    direction,
    entry,
    stopLoss,
    takeProfit,
    riskRewardRatio: rewardMultiple,
    confidenceScore: Math.min(92, 48 + Math.round((passedCount / confirmations.length) * 44)),
    passedCount,
    valid,
    confirmations
  };
}

function calculateIndicators(candles) {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);

  return {
    ema20: latestValue(ema(closes, 20)),
    ema50: latestValue(ema(closes, 50)),
    rsi14: latestValue(rsi(closes, 14)),
    atr14: latestValue(atr(candles, 14)),
    volumeMa20: latestValue(sma(volumes, 20))
  };
}

function detectSupportResistance(candles) {
  const recent = candles.slice(-80);
  const swingHighs = [];
  const swingLows = [];
  const latestClose = candles[candles.length - 1].close;

  for (let index = 2; index < recent.length - 2; index += 1) {
    const candle = recent[index];
    const before = recent.slice(index - 2, index);
    const after = recent.slice(index + 1, index + 3);

    if (before.every((item) => candle.high > item.high) && after.every((item) => candle.high > item.high)) {
      swingHighs.push({ price: candle.high, time: candle.time });
    }

    if (before.every((item) => candle.low < item.low) && after.every((item) => candle.low < item.low)) {
      swingLows.push({ price: candle.low, time: candle.time });
    }
  }

  const supportCandidates = swingLows.filter((level) => level.price < latestClose);
  const resistanceCandidates = swingHighs.filter((level) => level.price > latestClose);

  return {
    nearestSupport: nearestLevel(supportCandidates, latestClose),
    nearestResistance: nearestLevel(resistanceCandidates, latestClose),
    swingHighs: swingHighs.slice(-5),
    swingLows: swingLows.slice(-5)
  };
}

function nearestLevel(levels, price) {
  return levels.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0] || null;
}

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  const output = [];
  let previous = null;

  values.forEach((value, index) => {
    if (index < period - 1) {
      output.push(null);
      return;
    }

    if (previous === null) {
      previous = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
    } else {
      previous = (value - previous) * multiplier + previous;
    }

    output.push(previous);
  });

  return output;
}

function rsi(values, period) {
  const output = Array(period).fill(null);
  let gains = 0;
  let losses = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;
  output.push(rsiFromAverages(averageGain, averageLoss));

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    output.push(rsiFromAverages(averageGain, averageLoss));
  }

  return output;
}

function rsiFromAverages(averageGain, averageLoss) {
  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function atr(candles, period) {
  const ranges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });

  return sma(ranges, period);
}

function sma(values, period) {
  return values.map((_, index) => {
    if (index < period - 1) return null;
    const window = values.slice(index - period + 1, index + 1);
    return window.reduce((sum, item) => sum + item, 0) / period;
  });
}

function latestValue(values) {
  return values.findLast((value) => value !== null && Number.isFinite(value));
}

function confirmation(name, passed, detail) {
  return {
    name,
    passed,
    detail
  };
}

function volumeConfirmation(latest, indicators, volumeAvailable) {
  if (!volumeAvailable) {
    return confirmation(
      "Volume",
      false,
      "Twelve Data did not provide volume for this commodity series, so volume confirmation cannot pass."
    );
  }

  return confirmation(
    "Volume",
    latest.volume >= indicators.volumeMa20 * 1.05,
    `Latest volume is ${formatNumber(latest.volume)} versus ${formatNumber(indicators.volumeMa20)} volume MA.`
  );
}

function atrConfirmation(atrValue, price) {
  const atrPercent = price > 0 ? (atrValue / price) * 100 : 0;
  return confirmation(
    "ATR",
    Number.isFinite(atrValue) && atrValue > 0 && atrPercent >= 0.03 && atrPercent <= 12,
    `ATR14 is ${formatNumber(atrValue)} (${formatNumber(atrPercent)}% of price), providing a usable volatility range for stops and targets.`
  );
}

function noSetup(message, marketData, timeframe, candidates) {
  return {
    valid: false,
    signal: null,
    analysis: {
      symbol: marketData.pair.symbol,
      timeframe,
      message,
      evaluatedAt: new Date().toISOString(),
      candidates: candidates.map((candidate) => ({
        direction: candidate.direction,
        passedCount: candidate.passedCount,
        confirmations: candidate.confirmations
      }))
    }
  };
}

function buildReasoning(candidate, indicators, levels, isCommodity) {
  const passed = candidate.confirmations.filter((item) => item.passed).map((item) => item.name).join(", ");
  const failed = candidate.confirmations.filter((item) => !item.passed).map((item) => item.name).join(", ") || "none";
  const prefix = isCommodity
    ? `Commodity ${candidate.direction.toUpperCase()} analysis uses Twelve Data price structure; volume is not required. Setup`
    : `${candidate.direction.toUpperCase()} setup`;

  return `${prefix} confirmed by ${passed}. Failed checks: ${failed}. EMA20 ${formatNumber(indicators.ema20)}, EMA50 ${formatNumber(indicators.ema50)}, RSI14 ${formatNumber(indicators.rsi14)}, ATR14 ${formatNumber(indicators.atr14)}. Support ${levels.nearestSupport ? formatNumber(levels.nearestSupport.price) : "n/a"}, resistance ${levels.nearestResistance ? formatNumber(levels.nearestResistance.price) : "n/a"}.`;
}

function serializeIndicators(indicators, levels) {
  return {
    ema20: roundPrice(indicators.ema20),
    ema50: roundPrice(indicators.ema50),
    rsi14: Number(indicators.rsi14.toFixed(2)),
    atr14: roundPrice(indicators.atr14),
    volumeMa20: Number(indicators.volumeMa20.toFixed(4)),
    support: levels.nearestSupport ? roundPrice(levels.nearestSupport.price) : null,
    resistance: levels.nearestResistance ? roundPrice(levels.nearestResistance.price) : null
  };
}

function roundPrice(value) {
  return Number(value.toFixed(value > 1000 ? 2 : 4));
}

function formatNumber(value) {
  return Number.isFinite(value) ? roundPrice(value).toLocaleString("en-US") : "n/a";
}
