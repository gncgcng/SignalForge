import { appConfig } from "../../config/appConfig.js";
import { createId } from "../../shared/ids.js";
import { analyzeMarketRegime } from "../market-data/marketRegimeService.js";
import { scoreMultiTimeframeConfluence } from "../market-data/multiTimeframeService.js";

const minimumCandles = 60;
const minimumRiskReward = 1.8;
const minimumQualityScore = 78;

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
  const regime = analyzeMarketRegime(candles);
  const isCommodity = marketData.pair.assetClass === "Commodity";
  const rawLongCase = isCommodity
    ? evaluateCommodityLong(latest, indicators, levels)
    : evaluateCryptoLong(latest, indicators, levels, marketData.volumeAvailable !== false);
  const rawShortCase = isCommodity
    ? evaluateCommodityShort(latest, indicators, levels)
    : evaluateCryptoShort(latest, indicators, levels, marketData.volumeAvailable !== false);
  const longCase = validateCandidate(
    adjustCandidateForVolatility(rawLongCase, regime),
    candles,
    indicators,
    levels,
    regime,
    marketData.confluence,
    marketData.intelligence
  );
  const shortCase = validateCandidate(
    adjustCandidateForVolatility(rawShortCase, regime),
    candles,
    indicators,
    levels,
    regime,
    marketData.confluence,
    marketData.intelligence
  );
  const bestCase = [longCase, shortCase]
    .filter((candidate) => candidate.valid)
    .sort((a, b) => b.qualityScore - a.qualityScore || b.confidenceScore - a.confidenceScore)[0];

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
      setupKey: `${marketData.pair.symbol}:${timeframe}:${bestCase.direction}:${latest.time}`,
      symbol: marketData.pair.symbol,
      timeframe,
      direction: bestCase.direction,
      entryPrice: roundPrice(bestCase.entry),
      stopLoss: roundPrice(bestCase.stopLoss),
      takeProfit: roundPrice(bestCase.takeProfit),
      riskRewardRatio: Number(bestCase.riskRewardRatio.toFixed(2)),
      confidenceScore: bestCase.confidenceScore,
      confluenceScore: bestCase.confluence.score,
      alignmentBadge: bestCase.confluence.badge,
      session: bestCase.session,
      newsRisk: bestCase.newsRisk,
      qualityScore: bestCase.qualityScore,
      setupType: bestCase.setupType,
      confluence: bestCase.confluence,
      reasoning: buildReasoning(bestCase, indicators, levels, regime, isCommodity),
      confirmations: bestCase.confirmations,
      indicators: serializeIndicators(
        indicators,
        levels,
        regime,
        bestCase.confluence,
        bestCase.session,
        bestCase.newsRisk
      ),
      generatedAt: new Date().toISOString(),
      marketSource: marketData.source
    },
    analysis: {
      message: "Valid setup found.",
      qualityScore: bestCase.qualityScore,
      setupType: bestCase.setupType,
      confirmations: bestCase.confirmations,
      indicators: serializeIndicators(
        indicators,
        levels,
        regime,
        bestCase.confluence,
        bestCase.session,
        bestCase.newsRisk
      )
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
    confirmation("Resistance room", roomToResistance >= risk * minimumRiskReward, resistance ? `Nearest resistance leaves ${formatNumber(roomToResistance / risk)}R of upside room.` : "No nearby resistance overhead.")
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
    confirmation("Support room", roomToSupport >= risk * minimumRiskReward, support ? `Nearest support leaves ${formatNumber(roomToSupport / risk)}R of downside room.` : "No nearby support underneath.")
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
    confirmation("Resistance", roomToResistance >= risk * minimumRiskReward, resistance ? `Resistance near ${formatNumber(resistance.price)} leaves ${formatNumber(roomToResistance / risk)}R of upside room.` : "No nearby commodity resistance overhead.")
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
    confirmation("Support", roomToSupport >= risk * minimumRiskReward, support ? `Support near ${formatNumber(support.price)} leaves ${formatNumber(roomToSupport / risk)}R of downside room.` : "No nearby commodity support underneath.")
  ];

  return buildCandidate("short", entry, stopLoss, confirmations, risk, 5);
}

function buildCandidate(direction, entry, stopLoss, confirmations, risk, requiredPassCount = 4) {
  const passedCount = confirmations.filter((item) => item.passed).length;
  const valid = passedCount >= requiredPassCount && Number.isFinite(risk) && risk > 0;
  const rewardMultiple = Math.min(2.5, Math.max(minimumRiskReward, 1.8 + (passedCount - requiredPassCount) * 0.35));
  const targetDistance = risk * rewardMultiple;
  const takeProfit = direction === "long" ? entry + targetDistance : entry - targetDistance;

  return {
    direction,
    entry,
    stopLoss,
    takeProfit,
    riskRewardRatio: rewardMultiple,
    confidenceScore: Math.min(92, 48 + Math.round((passedCount / confirmations.length) * 44)),
    requiredPassCount,
    passedCount,
    valid,
    confirmations
  };
}

function adjustCandidateForVolatility(candidate, regime) {
  if (regime.label !== "High Volatility") {
    return candidate;
  }

  const originalRisk = Math.abs(candidate.entry - candidate.stopLoss);
  const widenedRisk = originalRisk * 1.25;
  const stopLoss = candidate.direction === "long"
    ? candidate.entry - widenedRisk
    : candidate.entry + widenedRisk;
  const takeProfit = candidate.direction === "long"
    ? candidate.entry + widenedRisk * candidate.riskRewardRatio
    : candidate.entry - widenedRisk * candidate.riskRewardRatio;

  return {
    ...candidate,
    stopLoss,
    takeProfit,
    risk: widenedRisk,
    confidenceScore: Math.max(0, candidate.confidenceScore - 8),
    volatilityAdjusted: true
  };
}

function validateCandidate(candidate, candles, indicators, levels, regime, confluenceContext, intelligence) {
  const setupType = classifySetupType(candidate.direction, candles, indicators, levels, regime);
  const confluence = scoreMultiTimeframeConfluence(confluenceContext, candidate.direction);
  const opposingLevel = candidate.direction === "long"
    ? levels.nearestResistance
    : levels.nearestSupport;
  const opposingRoom = opposingLevel
    ? Math.abs(opposingLevel.price - candidate.entry) / Math.max(Math.abs(candidate.entry - candidate.stopLoss), Number.EPSILON)
    : 4;
  const emaAligned = candidate.direction === "long"
    ? indicators.ema20 > indicators.ema50 &&
      candidate.entry > indicators.ema20 &&
      candidate.entry > indicators.ema50
    : indicators.ema20 < indicators.ema50 &&
      candidate.entry < indicators.ema20 &&
      candidate.entry < indicators.ema50;
  const levelStrength = candidate.direction === "long"
    ? levels.supportStrength
    : levels.resistanceStrength;
  const requiredConfirmationNames = [
    "RSI",
    "ATR",
    candidate.direction === "long" ? "Support" : "Resistance",
    candidate.direction === "long" ? "Resistance room" : "Support room"
  ];
  if (candidate.confirmations.some((item) => item.name === "Volume")) {
    requiredConfirmationNames.push("Volume");
  }
  const rejectionReasons = [];
  const session = intelligence?.session || {
    name: "Unknown",
    liquidity: "Unknown",
    confidenceAdjustment: 0,
    explanation: "Session intelligence unavailable."
  };
  const newsRisk = intelligence?.calendar?.newsRisk || {
    level: "Unknown",
    badge: "Calendar Unavailable",
    blockSignal: false,
    confidenceAdjustment: 0,
    explanation: "Economic calendar unavailable.",
    event: null
  };

  if (regime.label === "Trend Up" && candidate.direction !== "long") {
    rejectionReasons.push("Trend Up only favors continuation and pullback longs.");
  }
  if (regime.label === "Trend Down" && candidate.direction !== "short") {
    rejectionReasons.push("Trend Down only favors continuation and pullback shorts.");
  }
  if (
    ["Trend Up", "Trend Down"].includes(regime.label) &&
    !["Trend continuation", "Pullback bounce"].includes(setupType)
  ) {
    rejectionReasons.push(`${regime.label} requires a continuation or pullback setup.`);
  }
  if (regime.label === "Range" && setupType !== "Reversal") {
    rejectionReasons.push("Range conditions avoid trend trades and require strong mean-reversion structure.");
  }
  if (regime.label === "Breakout" && setupType !== "Breakout retest") {
    rejectionReasons.push("Breakout conditions require a confirmed breakout retest.");
  }
  if (regime.label === "Low Volatility") {
    rejectionReasons.push("Low volatility conditions do not justify forcing a trade.");
  }
  if (confluence.badge === "Countertrend" && confluence.score < 35) {
    rejectionReasons.push("Higher-timeframe structure strongly opposes this lower-timeframe setup.");
  }
  if (newsRisk.blockSignal) {
    rejectionReasons.push(newsRisk.explanation);
  }
  if (!emaAligned && setupType !== "Reversal") {
    rejectionReasons.push("Price and EMA20/EMA50 are not fully aligned.");
  }
  if (!regime.atrPass) {
    rejectionReasons.push("ATR volatility is outside the tradable range.");
  }
  if (regime.choppy && levelStrength < 3) {
    rejectionReasons.push("Market is choppy without a very strong support/resistance level.");
  }
  if (
    candidate.riskRewardRatio < minimumRiskReward ||
    opposingRoom < candidate.riskRewardRatio
  ) {
    rejectionReasons.push(
      `The ${candidate.riskRewardRatio.toFixed(2)}R target does not fit before the opposing level.`
    );
  }
  if (!setupType) {
    rejectionReasons.push("Price action does not match an approved setup type.");
  }
  const failedRequiredConfirmations = requiredConfirmationNames.filter((name) => {
    return !candidate.confirmations.some((item) => item.name === name && item.passed);
  });
  if (failedRequiredConfirmations.length) {
    rejectionReasons.push(
      `Required confirmations failed: ${failedRequiredConfirmations.join(", ")}.`
    );
  }

  const qualityScore = Math.max(0, Math.min(100, calculateQualityScore({
    candidate,
    setupType,
    regime,
    levelStrength,
    opposingRoom,
    emaAligned
  }) + confluence.qualityAdjustment));
  const requiredQuality = setupType === "Reversal" ? 86 : minimumQualityScore;

  if (qualityScore < requiredQuality) {
    rejectionReasons.push(`Quality score ${qualityScore} is below the required ${requiredQuality}.`);
  }

  return {
    ...candidate,
    setupType,
    qualityScore,
    confidenceScore: Math.max(0, Math.min(
      100,
      candidate.confidenceScore +
        confluence.confidenceAdjustment +
        session.confidenceAdjustment +
        newsRisk.confidenceAdjustment
    )),
    confluence,
    session,
    newsRisk,
    regime: regime.label,
    opposingRoom: Number(opposingRoom.toFixed(2)),
    rejectionReasons,
    valid: (
      candidate.valid ||
      (setupType === "Reversal" && candidate.passedCount >= candidate.requiredPassCount - 1)
    ) && rejectionReasons.length === 0
  };
}

function classifySetupType(direction, candles, indicators, levels, regime) {
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const atrValue = indicators.atr14;
  const aligned = direction === "long"
    ? latest.close > indicators.ema20 && indicators.ema20 > indicators.ema50
    : latest.close < indicators.ema20 && indicators.ema20 < indicators.ema50;
  const nearEma20 = Math.abs(latest.close - indicators.ema20) <= atrValue * 0.8;
  const activeLevel = direction === "long" ? levels.nearestSupport : levels.nearestResistance;
  const nearLevel = activeLevel && Math.abs(latest.close - activeLevel.price) <= atrValue;
  const priorWindow = candles.slice(-24, -3);
  const priorHigh = Math.max(...priorWindow.map((candle) => candle.high));
  const priorLow = Math.min(...priorWindow.map((candle) => candle.low));
  const breakoutRetest = direction === "long"
    ? previous.close > priorHigh && latest.low <= priorHigh + atrValue * 0.35 && latest.close > priorHigh
    : previous.close < priorLow && latest.high >= priorLow - atrValue * 0.35 && latest.close < priorLow;

  if (breakoutRetest && aligned) {
    return "Breakout retest";
  }

  if (aligned && (nearEma20 || nearLevel) && isDirectionalCandle(latest, direction)) {
    return "Pullback bounce";
  }

  if (aligned && regime.trendStrength >= 0.65 && isDirectionalCandle(latest, direction)) {
    return "Trend continuation";
  }

  const levelStrength = direction === "long" ? levels.supportStrength : levels.resistanceStrength;
  const reversalRsi = direction === "long"
    ? indicators.rsi14 >= 32 && indicators.rsi14 <= 48
    : indicators.rsi14 >= 52 && indicators.rsi14 <= 68;

  if (levelStrength >= 3 && reversalRsi && isDirectionalCandle(latest, direction)) {
    return "Reversal";
  }

  return null;
}

function calculateQualityScore({ candidate, setupType, regime, levelStrength, opposingRoom, emaAligned }) {
  const confirmationRatio = candidate.confirmations.length
    ? candidate.passedCount / candidate.confirmations.length
    : 0;
  const setupPoints = {
    "Trend continuation": 14,
    "Pullback bounce": 16,
    "Breakout retest": 18,
    Reversal: 20
  }[setupType] || 0;
  const score =
    confirmationRatio * 42 +
    Math.min(18, regime.trendStrength * 16) +
    Math.min(10, regime.efficiencyRatio * 24) +
    Math.min(8, levelStrength * 2.5) +
    Math.min(8, opposingRoom * 2.5) +
    setupPoints +
    (emaAligned ? 8 : 0) -
    (regime.choppy ? 18 : 0) -
    (regime.label === "High Volatility" ? 10 : 0);

  return Math.max(0, Math.min(100, Math.round(score)));
}

function isDirectionalCandle(candle, direction) {
  return direction === "long" ? candle.close > candle.open : candle.close < candle.open;
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
    supportStrength: calculateLevelStrength(supportCandidates, latestClose, candles),
    resistanceStrength: calculateLevelStrength(resistanceCandidates, latestClose, candles),
    swingHighs: swingHighs.slice(-5),
    swingLows: swingLows.slice(-5)
  };
}

function calculateLevelStrength(levels, latestClose, candles) {
  if (!levels.length) return 0;
  const recentRange = Math.max(...candles.slice(-40).map((candle) => candle.high)) -
    Math.min(...candles.slice(-40).map((candle) => candle.low));
  const tolerance = Math.max(recentRange * 0.012, latestClose * 0.0005);
  const nearest = nearestLevel([...levels], latestClose);
  return levels.filter((level) => Math.abs(level.price - nearest.price) <= tolerance).length;
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
        setupType: candidate.setupType,
        qualityScore: candidate.qualityScore,
        regime: candidate.regime,
        confluence: candidate.confluence,
        session: candidate.session,
        newsRisk: candidate.newsRisk,
        rejectionReasons: candidate.rejectionReasons,
        confirmations: candidate.confirmations
      }))
    }
  };
}

function buildReasoning(candidate, indicators, levels, regime, isCommodity) {
  const passed = candidate.confirmations.filter((item) => item.passed).map((item) => item.name).join(", ");
  const failed = candidate.confirmations.filter((item) => !item.passed).map((item) => item.name).join(", ") || "none";
  const prefix = isCommodity
    ? `Commodity ${candidate.direction.toUpperCase()} analysis uses Twelve Data price structure; volume is not required. Setup`
    : `${candidate.direction.toUpperCase()} setup`;

  return `${prefix} classified as ${candidate.setupType} with quality ${candidate.qualityScore}/100 in a ${regime.label} regime. ${regime.explanation} ${candidate.confluence.explanation} ${candidate.session.explanation} ${candidate.newsRisk.explanation} Confirmed by ${passed}. Failed checks: ${failed}. EMA20 ${formatNumber(indicators.ema20)}, EMA50 ${formatNumber(indicators.ema50)}, ADX14 ${formatNumber(regime.metrics.adx14)}, RSI14 ${formatNumber(indicators.rsi14)}, ATR14 ${formatNumber(indicators.atr14)}. Support ${levels.nearestSupport ? formatNumber(levels.nearestSupport.price) : "n/a"}, resistance ${levels.nearestResistance ? formatNumber(levels.nearestResistance.price) : "n/a"}.`;
}

function serializeIndicators(indicators, levels, regime, confluence = null, session = null, newsRisk = null) {
  return {
    ema20: roundPrice(indicators.ema20),
    ema50: roundPrice(indicators.ema50),
    rsi14: Number(indicators.rsi14.toFixed(2)),
    atr14: roundPrice(indicators.atr14),
    volumeMa20: Number(indicators.volumeMa20.toFixed(4)),
    support: levels.nearestSupport ? roundPrice(levels.nearestSupport.price) : null,
    resistance: levels.nearestResistance ? roundPrice(levels.nearestResistance.price) : null,
    supportStrength: levels.supportStrength,
    resistanceStrength: levels.resistanceStrength,
    trendStrength: Number(regime.trendStrength.toFixed(3)),
    efficiencyRatio: Number(regime.efficiencyRatio.toFixed(3)),
    adx14: regime.metrics.adx14,
    regime: regime.label,
    regimeExplanation: regime.explanation,
    volatilityLevel: regime.volatilityLevel,
    atrRatio: regime.metrics.atrRatio,
    confluenceScore: confluence?.score ?? null,
    alignmentBadge: confluence?.badge ?? null,
    confluenceExplanation: confluence?.explanation ?? null,
    higherTimeframes: confluence?.higherTimeframes ?? [],
    session: session?.name || "Unknown",
    sessionLiquidity: session?.liquidity || "Unknown",
    sessionExplanation: session?.explanation || "",
    newsRiskLevel: newsRisk?.level || "Unknown",
    newsRiskBadge: newsRisk?.badge || "Calendar Unavailable",
    newsRiskExplanation: newsRisk?.explanation || "",
    newsEvent: newsRisk?.event || null
  };
}

function roundPrice(value) {
  return Number(value.toFixed(value > 1000 ? 2 : 4));
}

function formatNumber(value) {
  return Number.isFinite(value) ? roundPrice(value).toLocaleString("en-US") : "n/a";
}
