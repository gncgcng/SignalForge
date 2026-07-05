import { appConfig } from "../../config/appConfig.js";
import { createId } from "../../shared/ids.js";
import { analyzeMarketRegime } from "../market-data/marketRegimeService.js";
import { scoreMultiTimeframeConfluence } from "../market-data/multiTimeframeService.js";
import {
  analyzeSmartMoneyConcepts,
  evaluateSmcConfluence
} from "../market-data/smartMoneyConceptsService.js";
import {
  buildDynamicRiskPlan,
  minimumRiskReward
} from "../risk/riskEngineService.js";
import { evaluateAdvancedStructure } from "../market-data/advancedMarketStructureService.js";
import { evaluateCorrelationContext } from "../market-data/correlationService.js";
import {
  buildSignalAnalystReport,
  calculateAdaptiveQualityAdjustment,
  currentStrategyVersion
} from "../analyst/signalAnalystService.js";

const minimumCandles = 60;
const minimumQualityScore = 70;

const diagnosticLabels = {
  trend_conflict: "trend conflict",
  weak_confirmation: "weak confirmation",
  poor_rr: "poor RR",
  low_volatility: "low volatility",
  too_close_to_support_resistance: "too close to support/resistance",
  failed_volume_filter: "failed volume filter",
  failed_confluence_threshold: "failed confluence threshold",
  news_session_blocked: "news/session blocked",
  strategy_not_matched: "strategy not matched"
};

export function generateMarketDataSetup(marketData, timeframe, options = {}) {
  if (!appConfig.supportedTimeframes.includes(timeframe)) {
    throw new Error("Unsupported timeframe.");
  }

  const candles = marketData.candles;

  if (candles.length < minimumCandles) {
    return noSetup("Not enough candles to calculate reliable indicators.", marketData, timeframe, [], ["strategy_not_matched"]);
  }

  const indicators = calculateIndicators(candles);
  const latest = candles[candles.length - 1];
  const regime = analyzeMarketRegime(candles);
  const smc = analyzeSmartMoneyConcepts(candles);
  const levels = mergeAdvancedLevels(
    mergeOrderBlockLevels(detectSupportResistance(candles), smc, latest.close),
    marketData.advancedStructure,
    latest.close
  );
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
    marketData.intelligence,
    smc,
    marketData.advancedStructure,
    marketData.correlation,
    options.analystProfile
  );
  const shortCase = validateCandidate(
    adjustCandidateForVolatility(rawShortCase, regime),
    candles,
    indicators,
    levels,
    regime,
    marketData.confluence,
    marketData.intelligence,
    smc,
    marketData.advancedStructure,
    marketData.correlation,
    options.analystProfile
  );
  const bestCase = [longCase, shortCase]
    .filter((candidate) => candidate.valid)
    .sort((a, b) => b.qualityScore - a.qualityScore || b.confidenceScore - a.confidenceScore)[0];

  if (!bestCase) {
    const evaluated = [longCase, shortCase];
    return noSetup(
      isCommodity
        ? "No valid commodity setup found. EMA trend, RSI, ATR, support, and resistance are not sufficiently aligned."
        : buildNoSetupMessage(evaluated),
      marketData,
      timeframe,
      evaluated
    );
  }
  const analyst = buildSignalAnalystReport(bestCase, options.analystProfile);

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
      smc: bestCase.smc,
      riskPlan: bestCase.riskPlan,
      marketStructure: bestCase.marketStructure,
      correlation: bestCase.correlation,
      analyst,
      reasoning: analyst.summary,
      confirmations: bestCase.confirmations,
      indicators: serializeIndicators(
        indicators,
        levels,
        regime,
        bestCase.confluence,
        bestCase.session,
        bestCase.newsRisk,
        bestCase.smc,
        bestCase.riskPlan,
        bestCase.marketStructure,
        bestCase.correlation,
        analyst
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
        bestCase.newsRisk,
        bestCase.smc,
        bestCase.riskPlan,
        bestCase.marketStructure,
        bestCase.correlation,
        analyst
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
    confidenceScore: Math.min(89, 46 + Math.round((passedCount / confirmations.length) * 42)),
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

function validateCandidate(
  candidate,
  candles,
  indicators,
  levels,
  regime,
  confluenceContext,
  intelligence,
  smcState,
  advancedStructure,
  correlationContext,
  analystProfile
) {
  const setupType = classifySetupType(
    candidate.direction,
    candles,
    indicators,
    levels,
    regime,
    smcState,
    advancedStructure,
    confluenceContext
  );
  const confluence = scoreMultiTimeframeConfluence(confluenceContext, candidate.direction);
  const smc = evaluateSmcConfluence(smcState, candidate.direction, regime);
  const marketStructure = evaluateAdvancedStructure(
    advancedStructure,
    candidate.direction,
    candidate.entry,
    regime
  );
  const correlation = evaluateCorrelationContext(correlationContext, candidate.direction);
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
    "ATR"
  ];
  const strategyRules = getStrategyRules(setupType, candidate.direction, candidate.confirmations);
  requiredConfirmationNames.push(...strategyRules.requiredConfirmations);
  const rejectionReasons = [];
  const rejectionReasonCodes = new Set();
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
    addRejection(rejectionReasons, rejectionReasonCodes, "trend_conflict", "Trend Up only favors continuation and pullback longs.");
  }
  if (regime.label === "Trend Down" && candidate.direction !== "short") {
    addRejection(rejectionReasons, rejectionReasonCodes, "trend_conflict", "Trend Down only favors continuation and pullback shorts.");
  }
  if (
    ["Trend Up", "Trend Down"].includes(regime.label) &&
    !["Trend continuation", "Pullback bounce", "Multi-timeframe continuation", "Support/resistance retest", "Breakout retest", "Momentum breakout", "VWAP reclaim/rejection"].includes(setupType)
  ) {
    addRejection(rejectionReasons, rejectionReasonCodes, "strategy_not_matched", `${regime.label} requires a continuation, retest, pullback, breakout, or VWAP setup.`);
  }
  if (regime.label === "Range" && !["Range bounce", "Mean reversion", "Liquidity sweep reversal"].includes(setupType)) {
    addRejection(rejectionReasons, rejectionReasonCodes, "trend_conflict", "Range conditions avoid trend trades and require range bounce or mean-reversion structure.");
  }
  if (regime.label === "Breakout" && !["Breakout retest", "Momentum breakout", "VWAP reclaim/rejection"].includes(setupType)) {
    addRejection(rejectionReasons, rejectionReasonCodes, "strategy_not_matched", "Breakout conditions require a confirmed breakout, retest, or VWAP event.");
  }
  if (regime.label === "Low Volatility" && levelStrength < 3 && !["Breakout retest", "Momentum breakout", "VWAP reclaim/rejection"].includes(setupType)) {
    addRejection(rejectionReasons, rejectionReasonCodes, "low_volatility", "Low volatility conditions need strong structure before a trade is allowed.");
  }
  if (confluence.badge === "Countertrend" && confluence.score < 25) {
    addRejection(rejectionReasons, rejectionReasonCodes, "failed_confluence_threshold", "Higher-timeframe structure strongly opposes this lower-timeframe setup.");
  }
  if (newsRisk.blockSignal) {
    addRejection(rejectionReasons, rejectionReasonCodes, "news_session_blocked", newsRisk.explanation);
  }
  if (!emaAligned && strategyRules.requiresEmaAlignment) {
    addRejection(rejectionReasons, rejectionReasonCodes, "trend_conflict", "Price and EMA20/EMA50 are not fully aligned.");
  }
  if (!regime.atrPass) {
    addRejection(rejectionReasons, rejectionReasonCodes, "low_volatility", "ATR volatility is outside the tradable range.");
  }
  if (regime.choppy && levelStrength < 3) {
    addRejection(rejectionReasons, rejectionReasonCodes, "weak_confirmation", "Market is choppy without a very strong support/resistance level.");
  }
  if (
    candidate.riskRewardRatio < minimumRiskReward ||
    opposingRoom < candidate.riskRewardRatio
  ) {
    addRejection(rejectionReasons, rejectionReasonCodes, "poor_rr",
      `The ${candidate.riskRewardRatio.toFixed(2)}R target does not fit before the opposing level.`
    );
  }
  if (!setupType) {
    addRejection(rejectionReasons, rejectionReasonCodes, "strategy_not_matched", "Price action does not match an approved setup type.");
  }
  const failedRequiredConfirmations = requiredConfirmationNames.filter((name) => {
    return !candidate.confirmations.some((item) => item.name === name && item.passed);
  });
  if (failedRequiredConfirmations.length) {
    const failedVolume = failedRequiredConfirmations.includes("Volume");
    addRejection(rejectionReasons, rejectionReasonCodes, failedVolume ? "failed_volume_filter" : "weak_confirmation",
      `Required confirmations failed: ${failedRequiredConfirmations.join(", ")}.`
    );
  }
  const missingPreferredConfirmations = strategyRules.preferredConfirmations.filter((name) => {
    return !candidate.confirmations.some((item) => item.name === name && item.passed);
  });
  if (missingPreferredConfirmations.includes("Volume")) {
    addRejection(rejectionReasons, rejectionReasonCodes, "failed_volume_filter", "Volume did not confirm this setup, so confidence is capped.");
  }

  const baseQualityScore = Math.max(0, Math.min(100, calculateQualityScore({
    candidate,
    setupType,
    regime,
    levelStrength,
    opposingRoom,
    emaAligned
  }) +
    confluence.qualityAdjustment +
    smc.qualityAdjustment +
    marketStructure.qualityAdjustment +
    correlation.qualityAdjustment));
  const adaptiveQuality = calculateAdaptiveQualityAdjustment({
    ...candidate,
    setupType,
    regime: regime.label,
    confluence,
    smc,
    marketStructure,
    correlation,
    session,
    newsRisk,
    opposingRoom
  }, analystProfile);
  const qualityScore = Math.max(
    0,
    Math.min(100, baseQualityScore + adaptiveQuality.adjustment)
  );
  const protectiveLevel = candidate.direction === "long"
    ? levels.nearestSupport
    : levels.nearestResistance;
  const riskPlan = buildDynamicRiskPlan({
    direction: candidate.direction,
    entry: candidate.entry,
    atr: indicators.atr14,
    regime,
    setupType,
    qualityScore,
    protectiveLevel,
    opposingLevel
  });
  const confidenceScore = calculateDisplayConfidence({
    candidate,
    setupType,
    regime,
    confluence,
    smc,
    marketStructure,
    correlation,
    session,
    newsRisk,
    riskPlan,
    qualityScore,
    opposingRoom,
    emaAligned
  });
  const reversalSetups = new Set(["Mean reversion", "Range bounce", "Liquidity sweep reversal"]);
  const requiredQuality = strategyRules.minimumQuality;

  if (qualityScore < requiredQuality) {
    addRejection(rejectionReasons, rejectionReasonCodes, "weak_confirmation", `Quality score ${qualityScore} is below the required ${requiredQuality}.`);
  }
  if (confidenceScore < 70) {
    addRejection(rejectionReasons, rejectionReasonCodes, "weak_confirmation", `Confidence score ${confidenceScore} is below the 70% signal threshold.`);
  }
  if (!riskPlan.tradeAllowed) {
    addRejection(rejectionReasons, rejectionReasonCodes, riskPlan.riskTier === "No trade" ? "weak_confirmation" : "poor_rr",
      riskPlan.riskTier === "No trade"
        ? "Dynamic Risk Engine classifies this as low quality and suggests no trade."
        : `Dynamic target is only ${riskPlan.riskRewardRatio.toFixed(2)}R; at least ${minimumRiskReward}R is required.`
    );
  }

  return {
    ...candidate,
    stopLoss: riskPlan.stopLoss,
    takeProfit: riskPlan.takeProfit,
    riskRewardRatio: riskPlan.riskRewardRatio,
    setupType,
    qualityScore,
    confidenceScore,
    confluence,
    smc,
    marketStructure,
    correlation,
    adaptiveQuality,
    riskPlan,
    session,
    newsRisk,
    regime: regime.label,
    opposingRoom: Number(opposingRoom.toFixed(2)),
    rejectionReasons,
    rejectionReasonCodes: [...rejectionReasonCodes],
    valid: (
      candidate.valid ||
      (reversalSetups.has(setupType) && candidate.passedCount >= candidate.requiredPassCount - 1)
    ) && rejectionReasons.length === 0
  };
}

export function calculateDisplayConfidence({
  candidate,
  setupType,
  regime,
  confluence,
  smc,
  marketStructure,
  correlation,
  session,
  newsRisk,
  riskPlan,
  qualityScore,
  opposingRoom,
  emaAligned
}) {
  const rawScore = Number(candidate.confidenceScore || 0) +
    Number(confluence?.confidenceAdjustment || 0) +
    Number(smc?.confidenceAdjustment || 0) +
    Number(marketStructure?.confidenceAdjustment || 0) +
    Number(correlation?.confidenceAdjustment || 0) +
    Number(session?.confidenceAdjustment || 0) +
    Number(newsRisk?.confidenceAdjustment || 0);
  const confirmationRatio = candidate.confirmations?.length
    ? candidate.passedCount / candidate.confirmations.length
    : 0;
  const qualityLift = Math.max(-10, Math.min(8, (Number(qualityScore || 0) - 82) * 0.25));
  const raw = rawScore + qualityLift;
  const nearPerfect = isNearPerfectConfluence({
    candidate,
    setupType,
    regime,
    confluence,
    smc,
    marketStructure,
    correlation,
    session,
    newsRisk,
    riskPlan,
    qualityScore,
    opposingRoom,
    emaAligned,
    confirmationRatio
  });

  if (nearPerfect) {
    return Math.max(98, Math.min(100, Math.round(raw)));
  }

  const cap = getNormalConfidenceCap({
    qualityScore,
    confirmationRatio,
    confluence,
    smc,
    marketStructure,
    correlation,
    session,
    newsRisk,
    riskPlan,
    opposingRoom,
    emaAligned
  });

  return Math.max(0, Math.min(cap, Math.round(raw)));
}

function getNormalConfidenceCap({
  qualityScore,
  confirmationRatio,
  confluence,
  smc,
  marketStructure,
  correlation,
  session,
  newsRisk,
  riskPlan,
  opposingRoom,
  emaAligned
}) {
  let cap = 89;

  if (
    Number(qualityScore || 0) >= 90 &&
    confirmationRatio >= 0.84 &&
    Number(confluence?.score || 0) >= 75 &&
    Number(riskPlan?.riskRewardRatio || 0) >= 2
  ) {
    cap = 97;
  } else if (
    Number(qualityScore || 0) >= 84 &&
    confirmationRatio >= 0.75 &&
    Number(confluence?.score || 0) >= 55
  ) {
    cap = 92;
  } else if (Number(qualityScore || 0) >= minimumQualityScore && confirmationRatio >= 0.6) {
    cap = 89;
  } else {
    cap = 69;
  }

  if (confluence?.badge === "Countertrend") cap = Math.min(cap, 82);
  if (smc?.conflict) cap = Math.min(cap, 84);
  if (correlation?.conflict) cap = Math.min(cap, 86);
  if (newsRisk?.blockSignal || newsRisk?.level === "High") cap = Math.min(cap, 74);
  if (session?.liquidity === "Low") cap = Math.min(cap, 84);
  if (!emaAligned) cap = Math.min(cap, 79);
  if (Number(opposingRoom || 0) < Number(riskPlan?.riskRewardRatio || minimumRiskReward) + 0.25) {
    cap = Math.min(cap, 88);
  }

  return cap;
}

function isNearPerfectConfluence({
  candidate,
  setupType,
  regime,
  confluence,
  smc,
  marketStructure,
  correlation,
  session,
  newsRisk,
  riskPlan,
  qualityScore,
  opposingRoom,
  emaAligned,
  confirmationRatio
}) {
  const constructiveRegime = ["Trend Up", "Trend Down", "Breakout"].includes(regime.label) &&
    !regime.choppy &&
    regime.label !== "High Volatility" &&
    regime.label !== "Low Volatility";
  const structureAligned = marketStructure?.available === false ||
    (marketStructure?.vwapAligned && marketStructure?.volumeProfileAligned);

  return Boolean(
    candidate.valid &&
    setupType &&
    constructiveRegime &&
    emaAligned &&
    confirmationRatio >= 0.95 &&
    Number(qualityScore || 0) >= 96 &&
    Number(confluence?.score || 0) >= 92 &&
    confluence?.badge === "Full Alignment" &&
    Number(riskPlan?.riskRewardRatio || 0) >= 2.3 &&
    Number(opposingRoom || 0) >= Number(riskPlan?.riskRewardRatio || 0) + 0.75 &&
    Number(smc?.score || 0) >= 22 &&
    !smc?.conflict &&
    structureAligned &&
    !correlation?.conflict &&
    session?.liquidity !== "Low" &&
    !newsRisk?.blockSignal &&
    newsRisk?.level !== "High"
  );
}

export function classifySetupType(
  direction,
  candles,
  indicators,
  levels,
  regime,
  smcState = null,
  advancedStructure = null,
  confluenceContext = null
) {
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const atrValue = indicators.atr14;
  const aligned = direction === "long"
    ? latest.close > indicators.ema20 && indicators.ema20 > indicators.ema50
    : latest.close < indicators.ema20 && indicators.ema20 < indicators.ema50;
  const nearEma20 = Math.abs(latest.close - indicators.ema20) <= atrValue * 0.8;
  const activeLevel = direction === "long" ? levels.nearestSupport : levels.nearestResistance;
  const nearLevel = activeLevel && Math.abs(latest.close - activeLevel.price) <= atrValue * 1.35;
  const priorWindow = candles.slice(-24, -3);
  const priorHigh = Math.max(...priorWindow.map((candle) => candle.high));
  const priorLow = Math.min(...priorWindow.map((candle) => candle.low));
  const directionalBreakout = direction === "long"
    ? previous.close <= priorHigh && latest.close > priorHigh && latest.close > latest.open
    : previous.close >= priorLow && latest.close < priorLow && latest.close < latest.open;
  const breakoutRetest = direction === "long"
    ? previous.close > priorHigh && latest.low <= priorHigh + atrValue * 0.35 && latest.close > priorHigh
    : previous.close < priorLow && latest.high >= priorLow - atrValue * 0.35 && latest.close < priorLow;
  const activeVwap = advancedStructure?.vwap;
  const vwapEvent = activeVwap?.event === "Reclaim" && direction === "long" ||
    activeVwap?.event === "Rejection" && direction === "short";
  const htfAligned = (confluenceContext?.higherTimeframes || [])
    .filter((item) => item?.available && item.regime?.preferredDirection)
    .filter((item) => item.regime.preferredDirection === direction).length >= 1;
  const sweptLiquidity = smcState?.liquiditySweep?.confirmed &&
    smcState.liquiditySweep.direction === direction;

  if (sweptLiquidity && isDirectionalCandle(latest, direction)) {
    return "Liquidity sweep reversal";
  }

  if (breakoutRetest && aligned) {
    return "Breakout retest";
  }

  if (directionalBreakout && aligned && latest.volume >= indicators.volumeMa20 * 1.02) {
    return "Momentum breakout";
  }

  if (vwapEvent && isDirectionalCandle(latest, direction)) {
    return "VWAP reclaim/rejection";
  }

  if (htfAligned && aligned && isDirectionalCandle(latest, direction)) {
    return "Multi-timeframe continuation";
  }

  if (aligned && nearEma20 && isDirectionalCandle(latest, direction)) {
    return "Pullback bounce";
  }

  if (aligned && nearLevel && isDirectionalCandle(latest, direction)) {
    return "Support/resistance retest";
  }

  if (aligned && regime.trendStrength >= 0.56 && isDirectionalCandle(latest, direction)) {
    return "Trend continuation";
  }

  const levelStrength = direction === "long" ? levels.supportStrength : levels.resistanceStrength;
  const reversalRsi = direction === "long"
    ? indicators.rsi14 >= 32 && indicators.rsi14 <= 48
    : indicators.rsi14 >= 52 && indicators.rsi14 <= 68;

  if (regime.label === "Range" && levelStrength >= 2 && nearLevel && isDirectionalCandle(latest, direction)) {
    return "Range bounce";
  }

  if (levelStrength >= 2 && reversalRsi && nearLevel) {
    return "Mean reversion";
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
    "Range bounce": 18,
    "Mean reversion": 20,
    "Momentum breakout": 16,
    "Liquidity sweep reversal": 20,
    "VWAP reclaim/rejection": 17,
    "Support/resistance retest": 16,
    "Multi-timeframe continuation": 18
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

function getStrategyRules(setupType, direction, confirmations = []) {
  const levelName = direction === "long" ? "Support" : "Resistance";
  const roomName = direction === "long" ? "Resistance room" : "Support room";
  const hasVolume = confirmations.some((item) => item.name === "Volume");
  const base = {
    minimumQuality: minimumQualityScore,
    requiredConfirmations: ["RSI", levelName, roomName],
    preferredConfirmations: [],
    requiresEmaAlignment: true
  };

  const rules = {
    "Trend continuation": {
      minimumQuality: 70,
      requiredConfirmations: ["RSI", roomName],
      preferredConfirmations: hasVolume ? ["Volume"] : [],
      requiresEmaAlignment: true
    },
    "Pullback bounce": {
      minimumQuality: 70,
      requiredConfirmations: ["RSI", levelName, roomName],
      preferredConfirmations: hasVolume ? ["Volume"] : [],
      requiresEmaAlignment: true
    },
    "Breakout retest": {
      minimumQuality: 72,
      requiredConfirmations: ["RSI", roomName],
      preferredConfirmations: hasVolume ? ["Volume"] : [],
      requiresEmaAlignment: true
    },
    "Momentum breakout": {
      minimumQuality: 74,
      requiredConfirmations: ["RSI", roomName, ...(hasVolume ? ["Volume"] : [])],
      preferredConfirmations: [],
      requiresEmaAlignment: true
    },
    "Range bounce": {
      minimumQuality: 72,
      requiredConfirmations: ["RSI", levelName, roomName],
      preferredConfirmations: [],
      requiresEmaAlignment: false
    },
    "Mean reversion": {
      minimumQuality: 74,
      requiredConfirmations: ["RSI", levelName, roomName],
      preferredConfirmations: [],
      requiresEmaAlignment: false
    },
    "Liquidity sweep reversal": {
      minimumQuality: 76,
      requiredConfirmations: ["RSI", levelName, roomName],
      preferredConfirmations: [],
      requiresEmaAlignment: false
    },
    "VWAP reclaim/rejection": {
      minimumQuality: 72,
      requiredConfirmations: ["RSI", roomName],
      preferredConfirmations: hasVolume ? ["Volume"] : [],
      requiresEmaAlignment: false
    },
    "Support/resistance retest": {
      minimumQuality: 70,
      requiredConfirmations: ["RSI", levelName, roomName],
      preferredConfirmations: hasVolume ? ["Volume"] : [],
      requiresEmaAlignment: true
    },
    "Multi-timeframe continuation": {
      minimumQuality: 72,
      requiredConfirmations: ["RSI", roomName],
      preferredConfirmations: hasVolume ? ["Volume"] : [],
      requiresEmaAlignment: true
    }
  }[setupType] || base;

  return {
    ...rules,
    requiredConfirmations: [...new Set(rules.requiredConfirmations)],
    preferredConfirmations: [...new Set(rules.preferredConfirmations || [])]
  };
}

function addRejection(rejectionReasons, rejectionReasonCodes, code, detail) {
  rejectionReasonCodes.add(code);
  rejectionReasons.push(detail);
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

function mergeOrderBlockLevels(levels, smc, latestClose) {
  const bullishBlocks = smc.orderBlocks.active
    .filter((block) => block.upper < latestClose)
    .map((block) => ({
      price: block.upper,
      time: block.time,
      source: "Bullish order block"
    }));
  const bearishBlocks = smc.orderBlocks.active
    .filter((block) => block.lower > latestClose)
    .map((block) => ({
      price: block.lower,
      time: block.time,
      source: "Bearish order block"
    }));
  const supportCandidates = [...levels.swingLows, ...bullishBlocks];
  const resistanceCandidates = [...levels.swingHighs, ...bearishBlocks];
  const nearestSupport = nearestLevel(
    supportCandidates.filter((level) => level.price < latestClose),
    latestClose
  );
  const nearestResistance = nearestLevel(
    resistanceCandidates.filter((level) => level.price > latestClose),
    latestClose
  );

  return {
    ...levels,
    nearestSupport,
    nearestResistance,
    supportStrength: levels.supportStrength + (nearestSupport?.source ? 1 : 0),
    resistanceStrength: levels.resistanceStrength + (nearestResistance?.source ? 1 : 0)
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

function noSetup(message, marketData, timeframe, candidates, fallbackCodes = []) {
  const diagnostics = summarizeDiagnostics(candidates, fallbackCodes);
  return {
    valid: false,
    signal: null,
    analysis: {
      symbol: marketData.pair.symbol,
      timeframe,
      message,
      rejectionReasons: diagnostics.reasons,
      rejectionReasonCodes: diagnostics.codes,
      rejectionSummary: diagnostics.summary,
      evaluatedAt: new Date().toISOString(),
      candidates: candidates.map((candidate) => ({
        direction: candidate.direction,
        passedCount: candidate.passedCount,
        setupType: candidate.setupType,
        qualityScore: candidate.qualityScore,
        regime: candidate.regime,
        confluence: candidate.confluence,
        smc: candidate.smc,
        marketStructure: candidate.marketStructure,
        correlation: candidate.correlation,
        session: candidate.session,
        newsRisk: candidate.newsRisk,
        rejectionReasons: candidate.rejectionReasons,
        rejectionReasonCodes: candidate.rejectionReasonCodes || [],
        confirmations: candidate.confirmations
      }))
    }
  };
}

function buildNoSetupMessage(candidates = []) {
  const reasons = candidates.flatMap((candidate) => candidate.rejectionReasons || []);
  const codes = new Set(candidates.flatMap((candidate) => candidate.rejectionReasonCodes || []));
  const joined = reasons.join(" ").toLowerCase();

  if (codes.has("low_volatility") || joined.includes("low volatility") || joined.includes("atr volatility")) {
    return "No high-quality setup. Volatility is too low or outside the tradable ATR range.";
  }
  if (codes.has("trend_conflict") || codes.has("failed_confluence_threshold") || joined.includes("trend up") || joined.includes("trend down") || joined.includes("countertrend") || joined.includes("ema")) {
    return "No high-quality setup. Trend and higher-timeframe structure are conflicting.";
  }
  if (codes.has("poor_rr") || codes.has("too_close_to_support_resistance") || joined.includes("target") || joined.includes("opposing level") || joined.includes("resistance") || joined.includes("support")) {
    return "No high-quality setup. Price is too close to support/resistance or the risk/reward is poor.";
  }
  if (codes.has("weak_confirmation") || codes.has("failed_volume_filter") || joined.includes("required confirmations") || joined.includes("quality score")) {
    return "No high-quality setup. The pattern did not receive enough objective confirmation.";
  }

  return "No high-quality setup. Conditions are too mixed for a reliable entry.";
}

function summarizeDiagnostics(candidates = [], fallbackCodes = []) {
  const codes = [...new Set([
    ...fallbackCodes,
    ...candidates.flatMap((candidate) => candidate.rejectionReasonCodes || [])
  ])];
  const reasons = codes.map((code) => diagnosticLabels[code]).filter(Boolean);

  return {
    codes,
    reasons: reasons.length ? reasons : ["strategy not matched"],
    summary: reasons.length
      ? `No setup found because: ${reasons.slice(0, 4).join(", ")}.`
      : "No setup found because: strategy not matched."
  };
}

function buildReasoning(candidate, indicators, levels, regime, isCommodity) {
  const passed = candidate.confirmations.filter((item) => item.passed).map((item) => item.name).join(", ");
  const failed = candidate.confirmations.filter((item) => !item.passed).map((item) => item.name).join(", ") || "none";
  const prefix = isCommodity
    ? `Commodity ${candidate.direction.toUpperCase()} analysis uses Twelve Data price structure; volume is not required. Setup`
    : `${candidate.direction.toUpperCase()} setup`;

  return `${prefix} classified as ${candidate.setupType} with quality ${candidate.qualityScore}/100 in a ${regime.label} regime. ${regime.explanation} ${candidate.confluence.explanation} ${candidate.smc.explanation} ${candidate.marketStructure.explanation} ${candidate.correlation.explanation} ${candidate.riskPlan.explanation} ${candidate.session.explanation} ${candidate.newsRisk.explanation} Confirmed by ${passed}. Failed checks: ${failed}. EMA20 ${formatNumber(indicators.ema20)}, EMA50 ${formatNumber(indicators.ema50)}, ADX14 ${formatNumber(regime.metrics.adx14)}, RSI14 ${formatNumber(indicators.rsi14)}, ATR14 ${formatNumber(indicators.atr14)}. Support ${levels.nearestSupport ? formatNumber(levels.nearestSupport.price) : "n/a"}, resistance ${levels.nearestResistance ? formatNumber(levels.nearestResistance.price) : "n/a"}.`;
}

function serializeIndicators(
  indicators,
  levels,
  regime,
  confluence = null,
  session = null,
  newsRisk = null,
  smc = null,
  riskPlan = null,
  marketStructure = null,
  correlation = null
  ,
  analyst = null
) {
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
    newsEvent: newsRisk?.event || null,
    smcScore: smc?.score ?? 0,
    smcConflict: smc?.conflict ?? false,
    smcExplanation: smc?.explanation || "SMC unavailable.",
    smcFactors: smc?.factors || [],
    stopStyle: riskPlan?.stopStyle || "ATR regime",
    stopMultiplier: riskPlan?.stopMultiplier ?? null,
    targetStyle: riskPlan?.targetStyle || "Regime dynamic",
    targetMultiple: riskPlan?.targetMultiple ?? null,
    riskTier: riskPlan?.riskTier || "Unknown",
    recommendedRiskPercent: riskPlan?.recommendedRiskPercent ?? 0,
    riskExplanation: riskPlan?.explanation || "",
    vwapAvailable: marketStructure?.available ?? false,
    vwapAligned: marketStructure?.vwapAligned ?? false,
    volumeProfileAligned: marketStructure?.volumeProfileAligned ?? false,
    marketStructureFactors: marketStructure?.factors || [],
    marketStructureExplanation: marketStructure?.explanation || "Advanced structure unavailable.",
    sessionVwap: marketStructure?.vwap?.session?.value ?? null,
    anchoredVwap: marketStructure?.vwap?.anchored?.value ?? null,
    vwapEvent: marketStructure?.vwap?.event || "None",
    volumeProfile: marketStructure?.volumeProfile || null,
    correlationAvailable: correlation?.available ?? false,
    correlationAligned: correlation?.aligned ?? false,
    correlationConflict: correlation?.conflict ?? false,
    correlationBreakdown: correlation?.breakdown ?? false,
    correlationExplanation: correlation?.explanation || "Correlation unavailable.",
    correlationPeers: correlation?.peers || [],
    strategyVersion: currentStrategyVersion,
    analystOverallQuality: analyst?.overallQuality || null,
    analystStrengths: analyst?.strengths || [],
    analystWeaknesses: analyst?.weaknesses || [],
    analystSections: analyst?.sections || {},
    analystAdaptiveAdjustment: analyst?.adaptive?.adjustment || 0,
    analystAdaptiveFactors: analyst?.adaptive?.factors || []
  };
}

function mergeAdvancedLevels(levels, advancedStructure, latestClose) {
  const nodes = advancedStructure?.volumeProfile?.highVolumeNodes || [];
  if (!nodes.length) return levels;
  const profileLevels = nodes.map((node) => ({
    price: node.midpoint,
    time: null,
    source: "High-volume node"
  }));
  const supports = [...levels.swingLows, ...profileLevels]
    .filter((level) => level.price < latestClose);
  const resistances = [...levels.swingHighs, ...profileLevels]
    .filter((level) => level.price > latestClose);
  const nearestSupport = nearestLevel(supports, latestClose);
  const nearestResistance = nearestLevel(resistances, latestClose);

  return {
    ...levels,
    nearestSupport,
    nearestResistance,
    supportStrength: levels.supportStrength + (nearestSupport?.source === "High-volume node" ? 1 : 0),
    resistanceStrength: levels.resistanceStrength + (nearestResistance?.source === "High-volume node" ? 1 : 0)
  };
}

function roundPrice(value) {
  return Number(value.toFixed(value > 1000 ? 2 : 4));
}

function formatNumber(value) {
  return Number.isFinite(value) ? roundPrice(value).toLocaleString("en-US") : "n/a";
}
