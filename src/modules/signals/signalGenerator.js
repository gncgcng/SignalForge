import { appConfig } from "../../config/appConfig.js";
import { createId } from "../../shared/ids.js";
import { analyzeMarketRegime } from "../market-data/marketRegimeService.js";
import {
  inferMultiTimeframeDirection,
  scoreMultiTimeframeConfluence
} from "../market-data/multiTimeframeService.js";
import {
  analyzeSmartMoneyConcepts,
  evaluateSmcConfluence,
  LIQUIDITY_SWEEP_REVERSAL_MAX_AGE_CANDLES
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
import { detectChartPatterns } from "../patterns/patternDetector.js";
import { attachMomentumEntryDiagnostics } from "./momentumEntryDiagnostics.js";

const minimumCandles = 60;
const minimumQualityScore = 70;
export const BREAKOUT_RETEST_TOLERANCE_ATR = 0.35;
export const SUPPORT_RESISTANCE_RETEST_TOLERANCE_ATR = 0.35;
export const SUPPORT_RESISTANCE_RETEST_MIN_SEPARATION_ATR = 0.75;
export const SUPPORT_RESISTANCE_RETEST_MAX_AGE_CANDLES = 1;
export const SUPPORT_RESISTANCE_RETEST_MIN_LEVEL_STRENGTH = 2;
export const MEAN_REVERSION_MIN_EXTENSION_ATR = 0.8;
export const MEAN_REVERSION_STRUCTURE_TOLERANCE_ATR = 1.35;
export const MEAN_REVERSION_MAX_AGE_CANDLES = 1;
export const RANGE_BOUNCE_MIN_WIDTH_ATR = 2.5;
export const RANGE_BOUNCE_INTERACTION_TOLERANCE_ATR = 0.35;
export const RANGE_BOUNCE_MAX_AGE_CANDLES = 1;
export const RANGE_BOUNCE_MIN_INSIDE_RATIO = 0.7;
export const PULLBACK_BOUNCE_MIN_PRIOR_EXTENSION_ATR = 0.8;
export const PULLBACK_BOUNCE_INTERACTION_TOLERANCE_ATR = 0.35;
export const PULLBACK_BOUNCE_MIN_CONFIRMATION_MOVE_ATR = 0.25;
export const PULLBACK_BOUNCE_MAX_AGE_CANDLES = 1;
export const PULLBACK_BOUNCE_SEQUENCE_CANDLES = 2;
export const TREND_CONTINUATION_MIN_TREND_STRENGTH = 0.56;
export const TREND_CONTINUATION_PAUSE_CANDLES = 2;
export const TREND_CONTINUATION_MAX_PAUSE_RANGE_ATR = 1.25;
export const TREND_CONTINUATION_MAX_PAUSE_BODY_ATR = 0.35;
export const TREND_CONTINUATION_MAX_PAUSE_DIRECTIONAL_MOVE_ATR = 0.4;
export const TREND_CONTINUATION_MIN_BODY_ATR = 0.45;
export const TREND_CONTINUATION_MIN_BODY_TO_RANGE = 0.55;
export const TREND_CONTINUATION_MIN_CLOSE_LOCATION = 0.7;
export const VWAP_PRIOR_DISPLACEMENT_MIN_ATR = 0.15;
export const VWAP_INTERACTION_TOLERANCE_ATR = 0.15;
export const VWAP_MIN_CLOSE_BEYOND_ATR = 0.1;
export const VWAP_MIN_BODY_TO_RANGE = 0.5;
export const VWAP_MIN_DIRECTIONAL_CLOSE_LOCATION = 0.65;
// User-facing pattern labels may describe only the trigger candle or two immediately preceding candles.
export const PATTERN_ASSOCIATION_MAX_AGE_CANDLES = 2;

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
    return noSetup("Not enough candles to calculate reliable indicators.", marketData, timeframe, [], ["strategy_not_matched"], []);
  }

  const detectedPatterns = detectChartPatterns(candles, { timeframe });
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
  const longCase = attachRelevantPatternContext(validateCandidate(
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
  ), detectedPatterns, "long", { candles, indicators, smcState: smc });
  const shortCase = attachRelevantPatternContext(validateCandidate(
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
  ), detectedPatterns, "short", { candles, indicators, smcState: smc });
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
      evaluated,
      [],
      detectedPatterns
    );
  }
  const analyst = buildSignalAnalystReport(bestCase, options.analystProfile);
  const entryPrice = roundPrice(bestCase.entry);
  const stopLoss = roundPrice(bestCase.stopLoss);
  const takeProfit = roundPrice(bestCase.takeProfit);
  const buildSerializedIndicators = () => attachMomentumEntryDiagnostics(
    serializeIndicators(
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
      analyst,
      bestCase.patternContext,
      bestCase.strategyEvidence
    ),
    {
      setupType: bestCase.setupType,
      candles,
      direction: bestCase.direction,
      entryPrice,
      stopLoss,
      indicators
    }
  );

  return {
    valid: true,
    signal: {
      id: createId("sig"),
      setupKey: `${marketData.pair.symbol}:${timeframe}:${bestCase.direction}:${latest.time}`,
      symbol: marketData.pair.symbol,
      timeframe,
      direction: bestCase.direction,
      entryPrice,
      stopLoss,
      takeProfit,
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
      patternContext: bestCase.patternContext,
      strategyEvidence: bestCase.strategyEvidence,
      analyst,
      reasoning: analyst.summary,
      confirmations: bestCase.confirmations,
      indicators: buildSerializedIndicators(),
      generatedAt: new Date().toISOString(),
      marketSource: marketData.source
    },
    analysis: {
      message: "Valid setup found.",
      qualityScore: bestCase.qualityScore,
      setupType: bestCase.setupType,
      patternContext: bestCase.patternContext,
      strategyEvidence: bestCase.strategyEvidence,
      detectedPatterns,
      confirmations: bestCase.confirmations,
      indicators: buildSerializedIndicators()
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
  const strategyEvidence = setupType === "Momentum breakout"
    ? evaluateMomentumBreakoutSetup(candidate.direction, candles)
    : setupType === "Breakout retest"
      ? evaluateBreakoutRetestSetup(candidate.direction, candles, indicators)
    : setupType === "Liquidity sweep reversal"
      ? evaluateLiquiditySweepReversalSetup(candidate.direction, candles, indicators, smcState)
      : setupType === "Multi-timeframe continuation"
        ? evaluateMultiTimeframeContinuationSetup(
            candidate.direction,
            candles,
            indicators,
            regime,
            confluenceContext
          )
      : setupType === "Pullback bounce"
        ? evaluatePullbackBounceSetup(candidate.direction, candles, indicators, levels, regime)
      : setupType === "Trend continuation"
        ? evaluateTrendContinuationSetup(candidate.direction, candles, indicators, regime)
      : setupType === "VWAP reclaim/rejection"
        ? evaluateVwapReclaimRejectionSetup(candidate.direction, candles, indicators, advancedStructure)
      : setupType === "Support/resistance retest"
        ? evaluateSupportResistanceRetestSetup(candidate.direction, candles, indicators, levels)
        : setupType === "Mean reversion"
          ? evaluateMeanReversionSetup(candidate.direction, candles, indicators, levels, regime)
          : setupType === "Range bounce"
            ? evaluateRangeBounceSetup(candidate.direction, candles, indicators, levels, regime)
            : null;
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
    addRejection(rejectionReasons, rejectionReasonCodes, "strategy_not_matched", "Breakout conditions require a confirmed breakout retest, momentum breakout, or VWAP event.");
  }
  if (regime.label === "Low Volatility" && levelStrength < 3 && !["Breakout retest", "Momentum breakout", "VWAP reclaim/rejection"].includes(setupType)) {
    addRejection(rejectionReasons, rejectionReasonCodes, "low_volatility", "Low volatility conditions do not justify forcing a trade without strong structure.");
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
    strategyEvidence,
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
    Number(confluence.confidenceAdjustment || 0) +
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
  const aligned = direction === "long"
    ? latest.close > indicators.ema20 && indicators.ema20 > indicators.ema50
    : latest.close < indicators.ema20 && indicators.ema20 < indicators.ema50;
  const momentumBreakout = evaluateMomentumBreakoutSetup(direction, candles);
  const breakoutRetest = evaluateBreakoutRetestSetup(direction, candles, indicators);
  const supportResistanceRetest = evaluateSupportResistanceRetestSetup(
    direction,
    candles,
    indicators,
    levels
  );
  const pullbackBounce = evaluatePullbackBounceSetup(direction, candles, indicators, levels, regime);
  const trendContinuation = evaluateTrendContinuationSetup(direction, candles, indicators, regime);
  const vwapSetup = evaluateVwapReclaimRejectionSetup(direction, candles, indicators, advancedStructure);
  const multiTimeframeContinuation = evaluateMultiTimeframeContinuationSetup(
    direction,
    candles,
    indicators,
    regime,
    confluenceContext
  );
  const sweptLiquidity = evaluateLiquiditySweepReversalSetup(direction, candles, indicators, smcState);

  if (sweptLiquidity.qualified) {
    return "Liquidity sweep reversal";
  }

  if (breakoutRetest.qualified && aligned) {
    return "Breakout retest";
  }

  if (momentumBreakout.qualified && aligned && latest.volume >= indicators.volumeMa20 * 1.02) {
    return "Momentum breakout";
  }

  if (vwapSetup.qualified) {
    return "VWAP reclaim/rejection";
  }

  if (multiTimeframeContinuation.passed) {
    return "Multi-timeframe continuation";
  }

  if (pullbackBounce.qualified) {
    return "Pullback bounce";
  }

  if (aligned && supportResistanceRetest.qualified) {
    return "Support/resistance retest";
  }

  if (trendContinuation.qualified) {
    return "Trend continuation";
  }

  const rangeBounce = evaluateRangeBounceSetup(direction, candles, indicators, levels, regime);
  const meanReversion = evaluateMeanReversionSetup(direction, candles, indicators, levels, regime);

  if (rangeBounce.qualified) {
    return "Range bounce";
  }

  if (meanReversion.qualified) {
    return "Mean reversion";
  }

  return null;
}

export function evaluateMomentumBreakoutSetup(direction, candles) {
  const candleCount = Array.isArray(candles) ? candles.length : 0;
  const referenceWindowStartIndex = candleCount - 24;
  const referenceWindowEndIndex = candleCount - 4;
  const triggerIndex = candleCount - 1;
  const triggerCandle = candles?.[triggerIndex];
  const priorWindow = Array.isArray(candles) ? candles.slice(-24, -3) : [];
  const interveningCandles = Array.isArray(candles) ? candles.slice(-3, -1) : [];
  const referenceValues = priorWindow.map((candle) => Number(
    direction === "long" ? candle?.high : candle?.low
  ));
  const referenceLevel = referenceValues.length && referenceValues.every(Number.isFinite)
    ? direction === "long" ? Math.max(...referenceValues) : Math.min(...referenceValues)
    : null;
  const interveningCloseMinus3 = Number(candles?.[candleCount - 3]?.close);
  const interveningCloseMinus2 = Number(candles?.[candleCount - 2]?.close);
  const baseEvidence = {
    strategy: "Momentum breakout",
    direction,
    qualified: false,
    referenceWindowStartIndex,
    referenceWindowEndIndex,
    referenceLevel,
    interveningCloseMinus3: Number.isFinite(interveningCloseMinus3) ? interveningCloseMinus3 : null,
    interveningCloseMinus2: Number.isFinite(interveningCloseMinus2) ? interveningCloseMinus2 : null,
    priorBreakoutDetected: false,
    breakoutFresh: false,
    triggerIndex
  };

  if (
    !["long", "short"].includes(direction) ||
    !triggerCandle ||
    !Number.isFinite(referenceLevel) ||
    interveningCandles.length !== 2 ||
    !Number.isFinite(interveningCloseMinus3) ||
    !Number.isFinite(interveningCloseMinus2)
  ) {
    return baseEvidence;
  }

  const priorBreakoutDetected = interveningCandles.some((candle) => direction === "long"
    ? Number(candle.close) > referenceLevel
    : Number(candle.close) < referenceLevel
  );
  const triggerBreakout = direction === "long"
    ? Number(triggerCandle.close) > referenceLevel && Number(triggerCandle.close) > Number(triggerCandle.open)
    : Number(triggerCandle.close) < referenceLevel && Number(triggerCandle.close) < Number(triggerCandle.open);
  const breakoutFresh = !priorBreakoutDetected && triggerBreakout;

  return {
    ...baseEvidence,
    qualified: breakoutFresh,
    priorBreakoutDetected,
    breakoutFresh
  };
}

export function evaluateVwapReclaimRejectionSetup(direction, candles, indicators, advancedStructure) {
  const latestIndex = Array.isArray(candles) ? candles.length - 1 : -1;
  const previousIndex = latestIndex - 1;
  const interactionCandle = candles?.[latestIndex];
  const previousCandle = candles?.[previousIndex];
  const vwapContext = advancedStructure?.vwap;
  const vwap = Number(vwapContext?.session?.value);
  const previousVwap = Number(vwapContext?.previousVwap);
  const atrValue = Number(indicators?.atr14);
  const expectedEvent = direction === "long" ? "Reclaim" : "Rejection";
  const baseEvidence = {
    strategy: "VWAP reclaim/rejection",
    direction,
    qualified: false,
    sessionId: vwapContext?.session?.id || null,
    vwap: Number.isFinite(vwap) ? vwap : null,
    previousVwap: Number.isFinite(previousVwap) ? previousVwap : null,
    sameSession: vwapContext?.sameSession === true,
    priorDistanceFromVwapAtr: null,
    interactionCandle: serializeStrategyCandle(interactionCandle),
    interactionDistanceAtr: null,
    interactionToleranceAtr: VWAP_INTERACTION_TOLERANCE_ATR,
    closeBeyondVwapAtr: null,
    bodyToRangeRatio: null,
    directionalCloseLocation: null,
    acceptedNewSide: false,
    confirmationCandle: serializeStrategyCandle(interactionCandle),
    ageCandles: 0,
    invalidationLevel: null
  };

  if (
    !["long", "short"].includes(direction) ||
    !interactionCandle ||
    !previousCandle ||
    !Number.isFinite(vwap) ||
    !Number.isFinite(previousVwap) ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0 ||
    vwapContext?.sameSession !== true ||
    vwapContext?.event !== expectedEvent
  ) {
    return baseEvidence;
  }

  const priorDistanceFromVwapAtr = direction === "long"
    ? (previousVwap - Number(previousCandle.close)) / atrValue
    : (Number(previousCandle.close) - previousVwap) / atrValue;
  const tolerance = atrValue * VWAP_INTERACTION_TOLERANCE_ATR;
  const interactionLow = Number(interactionCandle.low);
  const interactionHigh = Number(interactionCandle.high);
  const interactedWithVwap = interactionLow <= vwap + tolerance && interactionHigh >= vwap - tolerance;
  const interactionDistanceAtr = interactionLow <= vwap && interactionHigh >= vwap
    ? 0
    : Math.min(Math.abs(interactionLow - vwap), Math.abs(interactionHigh - vwap)) / atrValue;
  const closeBeyondVwapAtr = direction === "long"
    ? (Number(interactionCandle.close) - vwap) / atrValue
    : (vwap - Number(interactionCandle.close)) / atrValue;
  const candleRange = interactionHigh - interactionLow;
  const candleBody = Math.abs(Number(interactionCandle.close) - Number(interactionCandle.open));
  const bodyToRangeRatio = candleRange > 0 ? candleBody / candleRange : 0;
  const directionalCloseLocation = candleRange > 0
    ? direction === "long"
      ? (Number(interactionCandle.close) - interactionLow) / candleRange
      : (interactionHigh - Number(interactionCandle.close)) / candleRange
    : 0;
  const acceptedNewSide = closeBeyondVwapAtr >= VWAP_MIN_CLOSE_BEYOND_ATR;
  const qualified = priorDistanceFromVwapAtr >= VWAP_PRIOR_DISPLACEMENT_MIN_ATR &&
    interactedWithVwap &&
    acceptedNewSide &&
    isDirectionalCandle(interactionCandle, direction) &&
    bodyToRangeRatio >= VWAP_MIN_BODY_TO_RANGE &&
    directionalCloseLocation >= VWAP_MIN_DIRECTIONAL_CLOSE_LOCATION;

  return {
    ...baseEvidence,
    qualified,
    priorDistanceFromVwapAtr,
    interactionDistanceAtr,
    closeBeyondVwapAtr,
    bodyToRangeRatio,
    directionalCloseLocation,
    acceptedNewSide,
    invalidationLevel: direction === "long" ? interactionLow : interactionHigh
  };
}

export function evaluateTrendContinuationSetup(direction, candles, indicators, regime) {
  const atrValue = Number(indicators?.atr14);
  const ema20 = Number(indicators?.ema20);
  const ema50 = Number(indicators?.ema50);
  const trendStrength = Number(regime?.trendStrength);
  const requiredRegime = direction === "long" ? "Trend Up" : "Trend Down";
  const latestIndex = Array.isArray(candles) ? candles.length - 1 : -1;
  const pauseStartIndex = latestIndex - TREND_CONTINUATION_PAUSE_CANDLES;
  const pauseEndIndex = latestIndex - 1;
  const continuationCandle = candles?.[latestIndex];
  const baseEvidence = {
    strategy: "Trend continuation",
    direction,
    qualified: false,
    regime: regime?.label || null,
    trendStrength: Number.isFinite(trendStrength) ? trendStrength : null,
    ema20: Number.isFinite(ema20) ? ema20 : null,
    ema50: Number.isFinite(ema50) ? ema50 : null,
    pauseStartIndex,
    pauseEndIndex,
    pauseRangeAtr: null,
    pauseBodyAtr: null,
    pauseDirectionalMoveAtr: null,
    pauseOverlap: false,
    compactPause: false,
    continuationCandle: serializeStrategyCandle(continuationCandle),
    continuationBodyAtr: null,
    bodyToRangeRatio: null,
    directionalCloseLocation: null,
    brokePauseRange: false,
    volumeRatio: null,
    trendHeld: false,
    invalidationLevel: null
  };

  if (
    !["long", "short"].includes(direction) ||
    !Array.isArray(candles) ||
    candles.length < TREND_CONTINUATION_PAUSE_CANDLES + 3 ||
    regime?.label !== requiredRegime ||
    !Number.isFinite(trendStrength) ||
    trendStrength < TREND_CONTINUATION_MIN_TREND_STRENGTH ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0 ||
    !Number.isFinite(ema20) ||
    !Number.isFinite(ema50) ||
    !continuationCandle
  ) {
    return baseEvidence;
  }

  const emaAligned = direction === "long"
    ? Number(continuationCandle.close) > ema20 && ema20 > ema50
    : Number(continuationCandle.close) < ema20 && ema20 < ema50;
  if (!emaAligned) return baseEvidence;

  const pauseCandles = candles.slice(pauseStartIndex, latestIndex);
  if (pauseCandles.length !== TREND_CONTINUATION_PAUSE_CANDLES) return baseEvidence;

  const ema20ByIndex = deriveRecentEmaSeries(candles, ema20, 20);
  const ema50ByIndex = deriveRecentEmaSeries(candles, ema50, 50);
  const pauseHigh = Math.max(...pauseCandles.map((candle) => Number(candle.high)));
  const pauseLow = Math.min(...pauseCandles.map((candle) => Number(candle.low)));
  const pauseRangeAtr = (pauseHigh - pauseLow) / atrValue;
  const pauseBodyAtr = pauseCandles.reduce(
    (sum, candle) => sum + Math.abs(Number(candle.close) - Number(candle.open)) / atrValue,
    0
  ) / pauseCandles.length;
  const pauseDirectionalMoveAtr = Math.abs(
    Number(pauseCandles.at(-1).close) - Number(pauseCandles[0].open)
  ) / atrValue;
  const overlapHigh = Math.min(...pauseCandles.map((candle) => Number(candle.high)));
  const overlapLow = Math.max(...pauseCandles.map((candle) => Number(candle.low)));
  const pauseOverlap = overlapHigh >= overlapLow;
  const compactPause = pauseOverlap &&
    pauseRangeAtr <= TREND_CONTINUATION_MAX_PAUSE_RANGE_ATR &&
    pauseBodyAtr <= TREND_CONTINUATION_MAX_PAUSE_BODY_ATR &&
    pauseDirectionalMoveAtr <= TREND_CONTINUATION_MAX_PAUSE_DIRECTIONAL_MOVE_ATR;
  const trendHeld = pauseCandles.every((candle, offset) => {
    const index = pauseStartIndex + offset;
    const candleEma20 = ema20ByIndex[index];
    const candleEma50 = ema50ByIndex[index];
    if (!Number.isFinite(candleEma20) || !Number.isFinite(candleEma50)) return false;
    return direction === "long"
      ? Number(candle.close) > candleEma20 && Number(candle.low) > candleEma50 && candleEma20 > candleEma50
      : Number(candle.close) < candleEma20 && Number(candle.high) < candleEma50 && candleEma20 < candleEma50;
  });

  const candleRange = Number(continuationCandle.high) - Number(continuationCandle.low);
  const candleBody = Math.abs(Number(continuationCandle.close) - Number(continuationCandle.open));
  const continuationBodyAtr = candleBody / atrValue;
  const bodyToRangeRatio = candleRange > 0 ? candleBody / candleRange : 0;
  const directionalCloseLocation = candleRange > 0
    ? direction === "long"
      ? (Number(continuationCandle.close) - Number(continuationCandle.low)) / candleRange
      : (Number(continuationCandle.high) - Number(continuationCandle.close)) / candleRange
    : 0;
  const brokePauseRange = direction === "long"
    ? Number(continuationCandle.close) > pauseHigh
    : Number(continuationCandle.close) < pauseLow;
  const volume = Number(continuationCandle.volume);
  const volumeMa20 = Number(indicators?.volumeMa20);
  const volumeRatio = Number.isFinite(volume) && Number.isFinite(volumeMa20) && volumeMa20 > 0
    ? volume / volumeMa20
    : null;
  const expansionConfirmed = isDirectionalCandle(continuationCandle, direction) &&
    continuationBodyAtr >= TREND_CONTINUATION_MIN_BODY_ATR &&
    bodyToRangeRatio >= TREND_CONTINUATION_MIN_BODY_TO_RANGE &&
    directionalCloseLocation >= TREND_CONTINUATION_MIN_CLOSE_LOCATION &&
    brokePauseRange;

  return {
    ...baseEvidence,
    qualified: compactPause && trendHeld && expansionConfirmed,
    pauseRangeAtr,
    pauseBodyAtr,
    pauseDirectionalMoveAtr,
    pauseOverlap,
    compactPause,
    continuationBodyAtr,
    bodyToRangeRatio,
    directionalCloseLocation,
    brokePauseRange,
    volumeRatio,
    trendHeld,
    invalidationLevel: direction === "long" ? pauseLow : pauseHigh
  };
}

export function evaluateBreakoutRetestSetup(direction, candles, indicators) {
  const preBreakoutCandle = candles[candles.length - 3];
  const breakoutCandle = candles[candles.length - 2];
  const retestCandle = candles[candles.length - 1];
  const priorWindow = candles.slice(-24, -3);
  const atrValue = Number(indicators?.atr14);
  if (
    !["long", "short"].includes(direction) ||
    !preBreakoutCandle ||
    !breakoutCandle ||
    !retestCandle ||
    !priorWindow.length ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0
  ) {
    return {
      strategy: "Breakout retest",
      direction,
      qualified: false,
      breakoutLevel: null,
      breakoutCandle: serializeStrategyCandle(breakoutCandle),
      retestCandle: serializeStrategyCandle(retestCandle),
      retestExtreme: null,
      retestDistanceAtr: null,
      retestToleranceAtr: BREAKOUT_RETEST_TOLERANCE_ATR,
      freshBreakout: false,
      heldLevel: false,
      confirmation: false,
      invalidationLevel: null
    };
  }

  const breakoutLevel = direction === "long"
    ? Math.max(...priorWindow.map((candle) => Number(candle.high)))
    : Math.min(...priorWindow.map((candle) => Number(candle.low)));
  const tolerance = atrValue * BREAKOUT_RETEST_TOLERANCE_ATR;
  const zoneLower = breakoutLevel - tolerance;
  const zoneUpper = breakoutLevel + tolerance;
  const retestExtreme = direction === "long" ? Number(retestCandle.low) : Number(retestCandle.high);
  const breakoutConfirmed = direction === "long"
    ? Number(breakoutCandle.close) > breakoutLevel
    : Number(breakoutCandle.close) < breakoutLevel;
  const freshBreakout = direction === "long"
    ? Number(preBreakoutCandle.close) <= breakoutLevel
    : Number(preBreakoutCandle.close) >= breakoutLevel;
  const retestInteracted = retestExtreme >= zoneLower && retestExtreme <= zoneUpper;
  const heldLevel = retestInteracted && (direction === "long"
    ? Number(retestCandle.close) > breakoutLevel
    : Number(retestCandle.close) < breakoutLevel);
  const confirmation = isDirectionalCandle(retestCandle, direction);

  return {
    strategy: "Breakout retest",
    direction,
    qualified: breakoutConfirmed && freshBreakout && heldLevel && confirmation,
    breakoutLevel,
    breakoutCandle: serializeStrategyCandle(breakoutCandle),
    retestCandle: serializeStrategyCandle(retestCandle),
    retestExtreme,
    retestDistanceAtr: Math.abs(retestExtreme - breakoutLevel) / atrValue,
    retestToleranceAtr: BREAKOUT_RETEST_TOLERANCE_ATR,
    freshBreakout,
    heldLevel,
    confirmation,
    invalidationLevel: direction === "long" ? zoneLower : zoneUpper
  };
}

export function evaluateLiquiditySweepReversalSetup(direction, candles, indicators, smcState) {
  const sweep = smcState?.liquiditySweepReversal;
  const confirmationCandle = candles[candles.length - 1];
  const atrValue = Number(indicators?.atr14);
  const sweepCandle = sweep?.sweepCandle;
  const ageCandles = Number.isInteger(sweep?.sweepIndex)
    ? candles.length - 1 - sweep.sweepIndex
    : null;
  const directionMatches = sweep?.confirmed === true && sweep.direction === direction;
  const reclaimed = directionMatches && sweep.reclaimed === true;
  const confirmation = directionMatches && isDirectionalCandle(confirmationCandle, direction) && (direction === "long"
    ? Number(confirmationCandle?.close) > Number(sweep.level)
    : Number(confirmationCandle?.close) < Number(sweep.level));
  const fresh = Number.isInteger(ageCandles) &&
    ageCandles >= 0 &&
    ageCandles <= LIQUIDITY_SWEEP_REVERSAL_MAX_AGE_CANDLES;
  const sweepExtreme = direction === "long"
    ? Number(sweepCandle?.low)
    : Number(sweepCandle?.high);
  const sweepDistanceAtr = directionMatches && Number.isFinite(atrValue) && atrValue > 0
    ? Math.abs(sweepExtreme - Number(sweep.level)) / atrValue
    : null;
  const distanceFromSweepAtr = directionMatches && Number.isFinite(atrValue) && atrValue > 0
    ? Math.abs(Number(confirmationCandle?.close) - Number(sweepCandle?.close)) / atrValue
    : null;
  const reversalMoveAtr = directionMatches && Number.isFinite(atrValue) && atrValue > 0
    ? (direction === "long"
        ? Number(confirmationCandle?.close) - sweepExtreme
        : sweepExtreme - Number(confirmationCandle?.close)) / atrValue
    : null;

  return {
    strategy: "Liquidity sweep reversal",
    direction,
    qualified: Boolean(
      directionMatches &&
      reclaimed &&
      fresh &&
      confirmation &&
      !sweep?.ambiguous &&
      Number.isFinite(atrValue) &&
      atrValue > 0
    ),
    ambiguous: Boolean(sweep?.ambiguous),
    liquidityLevel: directionMatches ? Number(sweep.level) : null,
    liquiditySide: direction === "long" ? "downside" : "upside",
    referenceSwing: directionMatches ? sweep.referenceSwing || null : null,
    sweepCandle: directionMatches ? serializeStrategyCandle(sweepCandle) : null,
    sweepDistanceAtr,
    reclaimed,
    confirmationCandle: serializeStrategyCandle(confirmationCandle),
    confirmationDirection: confirmation ? direction : null,
    ageCandles,
    distanceFromSweepAtr,
    reversalMoveAtr,
    invalidationLevel: directionMatches ? sweepExtreme : null
  };
}

const multiTimeframeAgreementRules = {
  "5m": { expected: ["15m", "1h", "4h"], minimumAligned: 2, label: "at_least_2_aligned_no_opposition" },
  "15m": { expected: ["1h", "4h"], minimumAligned: 2, label: "1h_and_4h_aligned" },
  "1h": { expected: ["4h"], minimumAligned: 1, label: "4h_aligned" },
  "4h": { expected: [], minimumAligned: Number.POSITIVE_INFINITY, label: "higher_timeframe_required" }
};

export function evaluateMultiTimeframeContinuationSetup(
  direction,
  candles,
  indicators,
  regime,
  confluenceContext
) {
  const baseTimeframe = confluenceContext?.lowerTimeframe || null;
  const rule = multiTimeframeAgreementRules[baseTimeframe] || null;
  const latest = candles[candles.length - 1];
  const baseRegimeDirection = regime?.preferredDirection === "long" || regime?.label === "Trend Up"
    ? "long"
    : regime?.preferredDirection === "short" || regime?.label === "Trend Down"
      ? "short"
      : "neutral";
  const baseEmaAligned = direction === "long"
    ? latest?.close > indicators?.ema20 && indicators?.ema20 > indicators?.ema50
    : latest?.close < indicators?.ema20 && indicators?.ema20 < indicators?.ema50;
  const baseDirectionalCandle = Boolean(latest && isDirectionalCandle(latest, direction));
  const baseContinuation = baseRegimeDirection === direction && baseEmaAligned && baseDirectionalCandle;
  const supplied = new Map(
    (confluenceContext?.higherTimeframes || []).map((item) => [item?.timeframe, item])
  );
  const higherTimeframes = (rule?.expected || []).map((timeframe) => {
    const item = supplied.get(timeframe);
    if (!item?.available) {
      return { timeframe, state: "unavailable", direction: null, strength: null };
    }
    const higherDirection = inferMultiTimeframeDirection(item.regime);
    return {
      timeframe,
      state: higherDirection === direction
        ? "aligned"
        : higherDirection === "neutral"
          ? "neutral"
          : "opposing",
      direction: higherDirection,
      strength: finiteOrNull(item.regime?.trendStrength)
    };
  });
  const alignedCount = higherTimeframes.filter((item) => item.state === "aligned").length;
  const opposingCount = higherTimeframes.filter((item) => item.state === "opposing").length;
  const neutralCount = higherTimeframes.filter((item) => item.state === "neutral").length;
  const broadest = higherTimeframes.at(-1) || null;
  const passed = Boolean(
    rule &&
    rule.expected.length > 0 &&
    baseContinuation &&
    alignedCount >= rule.minimumAligned &&
    opposingCount === 0
  );

  return {
    strategy: "Multi-timeframe continuation",
    baseTimeframe,
    baseDirection: direction,
    baseRegimeDirection,
    baseContinuation,
    higherTimeframes,
    alignedCount,
    opposingCount,
    neutralCount,
    unavailableCount: higherTimeframes.filter((item) => item.state === "unavailable").length,
    broadestTimeframeDirection: broadest?.direction || null,
    agreementRule: rule?.label || "unsupported_base_timeframe",
    passed
  };
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function evaluatePullbackBounceSetup(direction, candles, indicators, levels, regime) {
  const atrValue = Number(indicators?.atr14);
  const ema20 = Number(indicators?.ema20);
  const ema50 = Number(indicators?.ema50);
  const trendRegime = direction === "long" ? "Trend Up" : "Trend Down";
  const trendStrength = Number(regime?.trendStrength);
  const activeLevel = direction === "long" ? levels?.nearestSupport : levels?.nearestResistance;
  const activeLevelPrice = Number(activeLevel?.price);
  const activeLevelStrength = Number(direction === "long" ? levels?.supportStrength : levels?.resistanceStrength);
  const nearbyStructuralLevel = Number.isFinite(activeLevelPrice) &&
    Number.isFinite(atrValue) && atrValue > 0 &&
    Math.abs(activeLevelPrice - ema20) / atrValue <= 1
    ? {
        type: direction === "long" ? "support" : "resistance",
        price: activeLevelPrice,
        strength: Number.isFinite(activeLevelStrength) ? activeLevelStrength : null,
        distanceAtr: Math.abs(activeLevelPrice - ema20) / atrValue
      }
    : null;
  const baseEvidence = {
    strategy: "Pullback bounce",
    direction,
    qualified: false,
    trendRegime: regime?.label || null,
    trendStrength: Number.isFinite(trendStrength) ? trendStrength : null,
    ema20: Number.isFinite(ema20) ? ema20 : null,
    ema50: Number.isFinite(ema50) ? ema50 : null,
    emaSeparationAtr: Number.isFinite(atrValue) && atrValue > 0 && Number.isFinite(ema20) && Number.isFinite(ema50)
      ? Math.abs(ema20 - ema50) / atrValue
      : null,
    priorExtensionAtr: null,
    priorExtensionIndex: null,
    priorExtensionTime: null,
    pullbackStartIndex: null,
    pullbackEndIndex: null,
    pullbackDirection: direction === "long" ? "down" : "up",
    pullbackDepthAtr: null,
    interactionCandle: null,
    interactionEma20: null,
    interactionEma50: null,
    interactionDistanceAtr: null,
    pullbackToleranceAtr: PULLBACK_BOUNCE_INTERACTION_TOLERANCE_ATR,
    heldTrendSupport: false,
    ambiguousEmaCross: false,
    confirmationCandle: null,
    confirmationDirection: null,
    confirmationMoveAtr: null,
    movedAwayFromEma: false,
    ageCandles: null,
    nearbyStructuralLevel,
    invalidationLevel: null
  };

  const latest = candles?.at?.(-1);
  const emaAligned = direction === "long"
    ? Number(latest?.close) > ema20 && ema20 > ema50
    : Number(latest?.close) < ema20 && ema20 < ema50;
  if (
    !["long", "short"].includes(direction) ||
    !Array.isArray(candles) ||
    candles.length < PULLBACK_BOUNCE_SEQUENCE_CANDLES + 4 ||
    regime?.label !== trendRegime ||
    !Number.isFinite(trendStrength) ||
    trendStrength <= 0 ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0 ||
    !Number.isFinite(ema20) ||
    !Number.isFinite(ema50) ||
    !emaAligned
  ) {
    return baseEvidence;
  }

  const latestIndex = candles.length - 1;
  const interactionIndexes = [latestIndex, latestIndex - 1];
  const tolerance = atrValue * PULLBACK_BOUNCE_INTERACTION_TOLERANCE_ATR;
  const ema20ByIndex = deriveRecentEmaSeries(candles, ema20, 20);
  const ema50ByIndex = deriveRecentEmaSeries(candles, ema50, 50);
  const trendDistance = (price, reference) => direction === "long"
    ? Number(price) - Number(reference)
    : Number(reference) - Number(price);

  const evaluateInteraction = (interactionIndex) => {
    const extensionIndex = interactionIndex - PULLBACK_BOUNCE_SEQUENCE_CANDLES - 1;
    const pullbackStartIndex = extensionIndex + 1;
    const pullbackEndIndex = interactionIndex - 1;
    const extensionCandle = candles[extensionIndex];
    const pullbackCandles = candles.slice(pullbackStartIndex, interactionIndex);
    const interactionCandle = candles[interactionIndex];
    const confirmationCandle = candles[latestIndex];
    const extensionEma20 = ema20ByIndex[extensionIndex];
    const pullbackEma20 = ema20ByIndex.slice(pullbackStartIndex, interactionIndex);
    const interactionEma20 = ema20ByIndex[interactionIndex];
    const interactionEma50 = ema50ByIndex[interactionIndex];
    const confirmationEma20 = ema20ByIndex[latestIndex];
    const ageCandles = latestIndex - interactionIndex;
    if (
      !extensionCandle ||
      pullbackCandles.length !== PULLBACK_BOUNCE_SEQUENCE_CANDLES ||
      !interactionCandle ||
      !Number.isFinite(extensionEma20) ||
      pullbackEma20.some((value) => !Number.isFinite(value)) ||
      !Number.isFinite(interactionEma20) ||
      !Number.isFinite(interactionEma50) ||
      !Number.isFinite(confirmationEma20)
    ) {
      return baseEvidence;
    }

    const extensionExtreme = direction === "long"
      ? Number(extensionCandle.high)
      : Number(extensionCandle.low);
    const priorExtensionAtr = trendDistance(extensionExtreme, extensionEma20) / atrValue;
    const pullbackCloseDistances = [
      trendDistance(extensionCandle.close, extensionEma20),
      ...pullbackCandles.map((candle, index) => trendDistance(candle.close, pullbackEma20[index]))
    ];
    const closesProgressTowardEma = pullbackCloseDistances.every((distance, index) => (
      index === 0 || distance >= 0 && distance < pullbackCloseDistances[index - 1]
    ));
    const countertrendDirection = direction === "long" ? "short" : "long";
    const countertrendSequence = pullbackCandles.every((candle) =>
      isDirectionalCandle(candle, countertrendDirection)
    ) && closesProgressTowardEma;
    const interactionExtreme = direction === "long"
      ? Number(interactionCandle.low)
      : Number(interactionCandle.high);
    const interactionDistanceAtr = Math.abs(interactionExtreme - interactionEma20) / atrValue;
    const interactedWithEma = interactionExtreme >= interactionEma20 - tolerance &&
      interactionExtreme <= interactionEma20 + tolerance;
    const interactionClosedOnTrendSide = direction === "long"
      ? Number(interactionCandle.close) >= interactionEma20
      : Number(interactionCandle.close) <= interactionEma20;
    const ambiguousEmaCross = direction === "long"
      ? interactionExtreme <= interactionEma50
      : interactionExtreme >= interactionEma50;
    const heldTrendSupport = interactedWithEma && interactionClosedOnTrendSide && !ambiguousEmaCross;
    const confirmationOnTrendSide = direction === "long"
      ? Number(confirmationCandle.close) > confirmationEma20
      : Number(confirmationCandle.close) < confirmationEma20;
    const confirmationMove = interactionIndex === latestIndex
      ? trendDistance(interactionCandle.close, interactionEma20) -
        Math.max(0, trendDistance(interactionCandle.open, interactionEma20))
      : trendDistance(confirmationCandle.close, confirmationEma20) -
        Math.max(0, trendDistance(interactionCandle.close, interactionEma20));
    const confirmationMoveAtr = confirmationMove / atrValue;
    const sameCandleBounce = interactionIndex === latestIndex &&
      isDirectionalCandle(interactionCandle, direction) &&
      confirmationMoveAtr >= PULLBACK_BOUNCE_MIN_CONFIRMATION_MOVE_ATR;
    const followingCandleBounce = interactionIndex !== latestIndex &&
      isDirectionalCandle(confirmationCandle, direction) &&
      confirmationMoveAtr >= PULLBACK_BOUNCE_MIN_CONFIRMATION_MOVE_ATR;
    const movedAwayFromEma = sameCandleBounce || followingCandleBounce;
    const pullbackDepthAtr = direction === "long"
      ? (extensionExtreme - interactionExtreme) / atrValue
      : (interactionExtreme - extensionExtreme) / atrValue;
    const qualified = priorExtensionAtr >= PULLBACK_BOUNCE_MIN_PRIOR_EXTENSION_ATR &&
      countertrendSequence &&
      interactedWithEma &&
      heldTrendSupport &&
      confirmationOnTrendSide &&
      movedAwayFromEma &&
      ageCandles <= PULLBACK_BOUNCE_MAX_AGE_CANDLES;

    return {
      ...baseEvidence,
      qualified,
      priorExtensionAtr,
      priorExtensionIndex: extensionIndex,
      priorExtensionTime: extensionCandle.time ?? extensionCandle.timestamp ?? null,
      pullbackStartIndex,
      pullbackEndIndex,
      pullbackDepthAtr,
      interactionCandle: serializeStrategyCandle(interactionCandle),
      interactionEma20,
      interactionEma50,
      interactionDistanceAtr,
      heldTrendSupport,
      ambiguousEmaCross,
      confirmationCandle: serializeStrategyCandle(confirmationCandle),
      confirmationDirection: movedAwayFromEma ? direction : null,
      confirmationMoveAtr,
      movedAwayFromEma,
      ageCandles,
      invalidationLevel: interactionExtreme
    };
  };

  const evaluations = interactionIndexes.map(evaluateInteraction);
  return evaluations.find((evaluation) => evaluation.qualified) || evaluations[0];
}

function deriveRecentEmaSeries(candles, latestEma, period) {
  const output = Array(candles.length).fill(null);
  const multiplier = 2 / (period + 1);
  const inverseMultiplier = 1 - multiplier;
  output[candles.length - 1] = latestEma;
  for (let index = candles.length - 2; index >= 0; index -= 1) {
    const nextEma = output[index + 1];
    const nextClose = Number(candles[index + 1]?.close);
    if (!Number.isFinite(nextEma) || !Number.isFinite(nextClose)) break;
    output[index] = (nextEma - multiplier * nextClose) / inverseMultiplier;
  }
  return output;
}

export function evaluateSupportResistanceRetestSetup(direction, candles, indicators, levels) {
  const atrValue = Number(indicators?.atr14);
  const levelType = direction === "long" ? "support" : "resistance";
  const level = direction === "long" ? levels?.nearestSupport : levels?.nearestResistance;
  const levelStrength = Number(direction === "long" ? levels?.supportStrength : levels?.resistanceStrength);
  const levelPrice = Number(level?.price);
  const baseEvidence = {
    strategy: "Support/resistance retest",
    direction,
    qualified: false,
    levelType,
    levelPrice: Number.isFinite(levelPrice) ? levelPrice : null,
    levelStrength: Number.isFinite(levelStrength) ? levelStrength : null,
    levelAgeCandles: null,
    priorSeparationAtr: null,
    interactionCandle: null,
    interactionDistanceAtr: null,
    toleranceAtr: SUPPORT_RESISTANCE_RETEST_TOLERANCE_ATR,
    heldLevel: false,
    confirmationCandle: null,
    confirmationDirection: null,
    ageCandles: null,
    invalidationLevel: null,
    levelPredatesInteraction: false,
    priorSeparated: false
  };

  if (
    !["long", "short"].includes(direction) ||
    !Array.isArray(candles) ||
    candles.length < 4 ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0 ||
    !Number.isFinite(levelPrice) ||
    !Number.isFinite(levelStrength) ||
    levelStrength < SUPPORT_RESISTANCE_RETEST_MIN_LEVEL_STRENGTH ||
    level?.time == null
  ) {
    return baseEvidence;
  }

  const levelIndex = candles.findIndex((candle) => sameCandleTime(candle.time ?? candle.timestamp, level.time));
  if (levelIndex < 0) return baseEvidence;

  const latestIndex = candles.length - 1;
  const interactionIndexes = [latestIndex, latestIndex - 1];
  for (const interactionIndex of interactionIndexes) {
    const interactionCandle = candles[interactionIndex];
    const confirmationCandle = interactionIndex === latestIndex
      ? interactionCandle
      : candles[latestIndex];
    const ageCandles = latestIndex - interactionIndex;
    const levelPredatesInteraction = levelIndex <= interactionIndex - 3;
    if (!levelPredatesInteraction || ageCandles > SUPPORT_RESISTANCE_RETEST_MAX_AGE_CANDLES) continue;

    const separationWindow = candles.slice(levelIndex + 2, interactionIndex);
    const separationDistances = separationWindow.map((candle) => direction === "long"
      ? (Number(candle.close) - levelPrice) / atrValue
      : (levelPrice - Number(candle.close)) / atrValue
    );
    const priorSeparationAtr = separationDistances.length
      ? Math.max(...separationDistances)
      : Number.NEGATIVE_INFINITY;
    const priorSeparated = priorSeparationAtr >= SUPPORT_RESISTANCE_RETEST_MIN_SEPARATION_ATR;
    const interactionExtreme = direction === "long"
      ? Number(interactionCandle.low)
      : Number(interactionCandle.high);
    const interactionDistanceAtr = Math.abs(interactionExtreme - levelPrice) / atrValue;
    const zoneTolerance = atrValue * SUPPORT_RESISTANCE_RETEST_TOLERANCE_ATR;
    const interacted = interactionExtreme >= levelPrice - zoneTolerance &&
      interactionExtreme <= levelPrice + zoneTolerance;
    const heldLevel = interacted && (direction === "long"
      ? Number(interactionCandle.close) >= levelPrice
      : Number(interactionCandle.close) <= levelPrice);
    const confirmation = heldLevel &&
      isDirectionalCandle(confirmationCandle, direction) &&
      (direction === "long"
        ? Number(confirmationCandle.close) >= levelPrice
        : Number(confirmationCandle.close) <= levelPrice);
    const qualified = priorSeparated && heldLevel && confirmation;

    if (qualified) {
      return {
        ...baseEvidence,
        qualified: true,
        levelAgeCandles: interactionIndex - levelIndex,
        priorSeparationAtr,
        interactionCandle: serializeStrategyCandle(interactionCandle),
        interactionDistanceAtr,
        heldLevel,
        confirmationCandle: serializeStrategyCandle(confirmationCandle),
        confirmationDirection: direction,
        ageCandles,
        invalidationLevel: interactionExtreme,
        levelPredatesInteraction,
        priorSeparated
      };
    }
  }

  const interactionIndex = latestIndex;
  const interactionCandle = candles[interactionIndex];
  const levelPredatesInteraction = levelIndex <= interactionIndex - 3;
  const separationWindow = levelPredatesInteraction
    ? candles.slice(levelIndex + 2, interactionIndex)
    : [];
  const priorSeparationAtr = separationWindow.length
    ? Math.max(...separationWindow.map((candle) => direction === "long"
        ? (Number(candle.close) - levelPrice) / atrValue
        : (levelPrice - Number(candle.close)) / atrValue
      ))
    : null;
  const interactionExtreme = direction === "long"
    ? Number(interactionCandle.low)
    : Number(interactionCandle.high);
  const interactionDistanceAtr = Math.abs(interactionExtreme - levelPrice) / atrValue;
  const zoneTolerance = atrValue * SUPPORT_RESISTANCE_RETEST_TOLERANCE_ATR;
  const interacted = interactionExtreme >= levelPrice - zoneTolerance &&
    interactionExtreme <= levelPrice + zoneTolerance;
  const heldLevel = interacted && (direction === "long"
    ? Number(interactionCandle.close) >= levelPrice
    : Number(interactionCandle.close) <= levelPrice);
  const confirmation = heldLevel && isDirectionalCandle(interactionCandle, direction);

  return {
    ...baseEvidence,
    levelAgeCandles: levelPredatesInteraction ? interactionIndex - levelIndex : null,
    priorSeparationAtr,
    interactionCandle: serializeStrategyCandle(interactionCandle),
    interactionDistanceAtr,
    heldLevel,
    confirmationCandle: serializeStrategyCandle(interactionCandle),
    confirmationDirection: confirmation ? direction : null,
    ageCandles: 0,
    invalidationLevel: interacted ? interactionExtreme : null,
    levelPredatesInteraction,
    priorSeparated: Number(priorSeparationAtr) >= SUPPORT_RESISTANCE_RETEST_MIN_SEPARATION_ATR
  };
}

export function evaluateMeanReversionSetup(direction, candles, indicators, levels, regime) {
  const atrValue = Number(indicators?.atr14);
  const meanReferencePrice = Number(indicators?.ema20);
  const rsi = Number(indicators?.rsi14);
  const structuralLevel = direction === "long" ? levels?.nearestSupport : levels?.nearestResistance;
  const structuralLevelPrice = Number(structuralLevel?.price);
  const levelStrength = Number(direction === "long" ? levels?.supportStrength : levels?.resistanceStrength);
  const rsiSupported = direction === "long"
    ? rsi >= 32 && rsi <= 48
    : rsi >= 52 && rsi <= 68;
  const regimeAllowed = !["Trend Up", "Trend Down", "Breakout"].includes(regime?.label);
  const baseEvidence = {
    strategy: "Mean reversion",
    direction,
    qualified: false,
    meanReferenceType: "EMA20",
    meanReferencePrice: Number.isFinite(meanReferencePrice) ? meanReferencePrice : null,
    distanceFromMeanAtr: null,
    currentDistanceFromMeanAtr: null,
    rsi: Number.isFinite(rsi) ? rsi : null,
    rsiSupported,
    structuralLevel: Number.isFinite(structuralLevelPrice) ? structuralLevelPrice : null,
    levelStrength: Number.isFinite(levelStrength) ? levelStrength : null,
    reversalCandle: null,
    movedTowardMean: false,
    confirmationCandle: null,
    confirmationDirection: null,
    ageCandles: null,
    invalidationLevel: null,
    regimeAllowed
  };

  if (
    !["long", "short"].includes(direction) ||
    !Array.isArray(candles) ||
    candles.length < 2 ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0 ||
    !Number.isFinite(meanReferencePrice) ||
    !Number.isFinite(rsi) ||
    !Number.isFinite(structuralLevelPrice) ||
    !Number.isFinite(levelStrength) ||
    levelStrength < 2 ||
    !rsiSupported ||
    !regimeAllowed
  ) {
    return baseEvidence;
  }

  const latestIndex = candles.length - 1;
  const latest = candles[latestIndex];
  const currentDistanceFromMeanAtr = Math.abs(Number(latest.close) - meanReferencePrice) / atrValue;
  const latestRemainsBeforeMean = direction === "long"
    ? Number(latest.close) < meanReferencePrice
    : Number(latest.close) > meanReferencePrice;
  const reversalIndexes = [latestIndex, latestIndex - 1];

  for (const reversalIndex of reversalIndexes) {
    const reversalCandle = candles[reversalIndex];
    const confirmationCandle = latest;
    const ageCandles = latestIndex - reversalIndex;
    if (ageCandles > MEAN_REVERSION_MAX_AGE_CANDLES) continue;

    const extensionPrice = direction === "long"
      ? Number(reversalCandle.low)
      : Number(reversalCandle.high);
    const distanceFromMeanAtr = direction === "long"
      ? (meanReferencePrice - extensionPrice) / atrValue
      : (extensionPrice - meanReferencePrice) / atrValue;
    const extended = distanceFromMeanAtr >= MEAN_REVERSION_MIN_EXTENSION_ATR;
    const structureDistanceAtr = Math.abs(extensionPrice - structuralLevelPrice) / atrValue;
    const interactedWithStructure = structureDistanceAtr <= MEAN_REVERSION_STRUCTURE_TOLERANCE_ATR;
    const heldStructure = interactedWithStructure && (direction === "long"
      ? Number(reversalCandle.close) >= structuralLevelPrice
      : Number(reversalCandle.close) <= structuralLevelPrice);
    const reversalMovedTowardMean = isDirectionalCandle(reversalCandle, direction) &&
      Math.abs(meanReferencePrice - Number(reversalCandle.close)) <
        Math.abs(meanReferencePrice - Number(reversalCandle.open));
    const followThrough = reversalIndex === latestIndex || (
      isDirectionalCandle(confirmationCandle, direction) &&
      Math.abs(meanReferencePrice - Number(confirmationCandle.close)) <
        Math.abs(meanReferencePrice - Number(reversalCandle.close))
    );
    const movedTowardMean = reversalMovedTowardMean && followThrough;
    const qualified = extended &&
      heldStructure &&
      movedTowardMean &&
      latestRemainsBeforeMean;

    if (qualified) {
      return {
        ...baseEvidence,
        qualified: true,
        distanceFromMeanAtr,
        currentDistanceFromMeanAtr,
        structuralDistanceAtr: structureDistanceAtr,
        reversalCandle: serializeStrategyCandle(reversalCandle),
        movedTowardMean,
        confirmationCandle: serializeStrategyCandle(confirmationCandle),
        confirmationDirection: direction,
        ageCandles,
        invalidationLevel: extensionPrice
      };
    }
  }

  const reversalCandle = latest;
  const extensionPrice = direction === "long" ? Number(latest.low) : Number(latest.high);
  const distanceFromMeanAtr = direction === "long"
    ? (meanReferencePrice - extensionPrice) / atrValue
    : (extensionPrice - meanReferencePrice) / atrValue;
  const structureDistanceAtr = Math.abs(extensionPrice - structuralLevelPrice) / atrValue;
  const movedTowardMean = isDirectionalCandle(latest, direction) &&
    Math.abs(meanReferencePrice - Number(latest.close)) <
      Math.abs(meanReferencePrice - Number(latest.open));

  return {
    ...baseEvidence,
    distanceFromMeanAtr,
    currentDistanceFromMeanAtr,
    structuralDistanceAtr: structureDistanceAtr,
    reversalCandle: serializeStrategyCandle(latest),
    movedTowardMean,
    confirmationCandle: serializeStrategyCandle(latest),
    confirmationDirection: movedTowardMean ? direction : null,
    ageCandles: 0,
    invalidationLevel: extensionPrice
  };
}

export function evaluateRangeBounceSetup(direction, candles, indicators, levels, regime) {
  const atrValue = Number(indicators?.atr14);
  const rangeLow = Number(levels?.nearestSupport?.price);
  const rangeHigh = Number(levels?.nearestResistance?.price);
  const lowerStrength = Number(levels?.supportStrength);
  const upperStrength = Number(levels?.resistanceStrength);
  const rangeWidth = rangeHigh - rangeLow;
  const rangeWidthAtr = rangeWidth / atrValue;
  const rangeMidpoint = (rangeLow + rangeHigh) / 2;
  const baseEvidence = {
    strategy: "Range bounce",
    direction,
    qualified: false,
    rangeLow: Number.isFinite(rangeLow) ? rangeLow : null,
    rangeHigh: Number.isFinite(rangeHigh) ? rangeHigh : null,
    rangeMidpoint: Number.isFinite(rangeMidpoint) ? rangeMidpoint : null,
    rangeWidthAtr: Number.isFinite(rangeWidthAtr) ? rangeWidthAtr : null,
    lowerStrength: Number.isFinite(lowerStrength) ? lowerStrength : null,
    upperStrength: Number.isFinite(upperStrength) ? upperStrength : null,
    rangeLowConfirmationIndex: null,
    rangeLowConfirmationTime: null,
    rangeHighConfirmationIndex: null,
    rangeHighConfirmationTime: null,
    rangeAgeCandles: null,
    lowerInteractionCount: 0,
    upperInteractionCount: 0,
    recentInsideRatio: null,
    approachedFromInterior: false,
    boundaryTested: direction === "long" ? "lower" : "upper",
    interactionCandle: null,
    interactionDistanceAtr: null,
    interactionToleranceAtr: RANGE_BOUNCE_INTERACTION_TOLERANCE_ATR,
    closedInsideRange: false,
    ambiguousDualBoundaryTest: false,
    confirmationCandle: null,
    confirmationDirection: null,
    movedTowardInterior: false,
    ageCandles: null,
    invalidationLevel: null
  };

  if (
    !["long", "short"].includes(direction) ||
    !Array.isArray(candles) ||
    candles.length < 6 ||
    regime?.label !== "Range" ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0 ||
    !Number.isFinite(rangeLow) ||
    !Number.isFinite(rangeHigh) ||
    rangeHigh <= rangeLow ||
    !Number.isFinite(rangeWidthAtr) ||
    rangeWidthAtr < RANGE_BOUNCE_MIN_WIDTH_ATR ||
    lowerStrength < 2 ||
    upperStrength < 2 ||
    levels?.nearestSupport?.time == null ||
    levels?.nearestResistance?.time == null
  ) {
    return baseEvidence;
  }

  const rangeLowIndex = candles.findIndex((candle) => sameCandleTime(
    candle.time ?? candle.timestamp,
    levels.nearestSupport.time
  ));
  const rangeHighIndex = candles.findIndex((candle) => sameCandleTime(
    candle.time ?? candle.timestamp,
    levels.nearestResistance.time
  ));
  if (rangeLowIndex < 0 || rangeHighIndex < 0) return baseEvidence;

  const latestIndex = candles.length - 1;
  const interactionIndexes = [latestIndex, latestIndex - 1];
  const tolerance = atrValue * RANGE_BOUNCE_INTERACTION_TOLERANCE_ATR;

  const evaluateInteraction = (interactionIndex) => {
    const interactionCandle = candles[interactionIndex];
    const confirmationCandle = candles[latestIndex];
    const ageCandles = latestIndex - interactionIndex;
    const rangeLowConfirmationIndex = rangeLowIndex + 2;
    const rangeHighConfirmationIndex = rangeHighIndex + 2;
    const boundariesPredateBounce = rangeLowConfirmationIndex < interactionIndex &&
      rangeHighConfirmationIndex < interactionIndex;
    const priorCandle = candles[interactionIndex - 2];
    const approachCandle = candles[interactionIndex - 1];
    const priorInside = priorCandle && Number(priorCandle.close) > rangeLow && Number(priorCandle.close) < rangeHigh;
    const approachInside = approachCandle && Number(approachCandle.close) > rangeLow && Number(approachCandle.close) < rangeHigh;
    const testedBoundary = direction === "long" ? rangeLow : rangeHigh;
    const approachedFromInterior = Boolean(
      priorInside &&
      approachInside &&
      Math.abs(Number(approachCandle.close) - testedBoundary) <
        Math.abs(Number(priorCandle.close) - testedBoundary)
    );
    const qualityStart = Math.max(
      rangeLowConfirmationIndex,
      rangeHighConfirmationIndex,
      interactionIndex - 12
    );
    const qualityWindow = candles.slice(qualityStart, interactionIndex);
    const structureWindow = candles.slice(Math.min(rangeLowIndex, rangeHighIndex), interactionIndex);
    const recentInsideRatio = qualityWindow.length
      ? qualityWindow.filter((candle) => Number(candle.close) >= rangeLow && Number(candle.close) <= rangeHigh).length /
        qualityWindow.length
      : 0;
    const lowerInteractionCount = structureWindow.filter((candle) =>
      Math.abs(Number(candle.low) - rangeLow) <= tolerance
    ).length;
    const upperInteractionCount = structureWindow.filter((candle) =>
      Math.abs(Number(candle.high) - rangeHigh) <= tolerance
    ).length;
    const lowerTested = Number(interactionCandle.low) >= rangeLow - tolerance &&
      Number(interactionCandle.low) <= rangeLow + tolerance;
    const upperTested = Number(interactionCandle.high) >= rangeHigh - tolerance &&
      Number(interactionCandle.high) <= rangeHigh + tolerance;
    const ambiguousDualBoundaryTest = lowerTested && upperTested;
    const boundaryInteracted = direction === "long" ? lowerTested : upperTested;
    const interactionExtreme = direction === "long"
      ? Number(interactionCandle.low)
      : Number(interactionCandle.high);
    const interactionDistanceAtr = Math.abs(interactionExtreme - testedBoundary) / atrValue;
    const closedInsideRange = Number(interactionCandle.close) >= rangeLow &&
      Number(interactionCandle.close) <= rangeHigh;
    const confirmationInsideRange = Number(confirmationCandle.close) >= rangeLow &&
      Number(confirmationCandle.close) <= rangeHigh;
    const sameCandleBounce = interactionIndex === latestIndex &&
      isDirectionalCandle(interactionCandle, direction) &&
      Math.abs(Number(interactionCandle.close) - rangeMidpoint) <
        Math.abs(Number(interactionCandle.open) - rangeMidpoint);
    const followingCandleBounce = interactionIndex !== latestIndex &&
      isDirectionalCandle(confirmationCandle, direction) &&
      Math.abs(Number(confirmationCandle.close) - rangeMidpoint) <
        Math.abs(Number(interactionCandle.close) - rangeMidpoint);
    const movedTowardInterior = sameCandleBounce || followingCandleBounce;
    const qualified = boundariesPredateBounce &&
      ageCandles <= RANGE_BOUNCE_MAX_AGE_CANDLES &&
      recentInsideRatio >= RANGE_BOUNCE_MIN_INSIDE_RATIO &&
      approachedFromInterior &&
      boundaryInteracted &&
      !ambiguousDualBoundaryTest &&
      closedInsideRange &&
      confirmationInsideRange &&
      movedTowardInterior;

    return {
      ...baseEvidence,
      qualified,
      rangeLowConfirmationIndex,
      rangeLowConfirmationTime: candles[rangeLowConfirmationIndex]?.time ?? candles[rangeLowConfirmationIndex]?.timestamp ?? null,
      rangeHighConfirmationIndex,
      rangeHighConfirmationTime: candles[rangeHighConfirmationIndex]?.time ?? candles[rangeHighConfirmationIndex]?.timestamp ?? null,
      rangeAgeCandles: interactionIndex - Math.max(rangeLowConfirmationIndex, rangeHighConfirmationIndex),
      lowerInteractionCount,
      upperInteractionCount,
      recentInsideRatio,
      approachedFromInterior,
      interactionCandle: serializeStrategyCandle(interactionCandle),
      interactionDistanceAtr,
      closedInsideRange,
      ambiguousDualBoundaryTest,
      confirmationCandle: serializeStrategyCandle(confirmationCandle),
      confirmationDirection: movedTowardInterior ? direction : null,
      movedTowardInterior,
      ageCandles,
      invalidationLevel: interactionExtreme
    };
  };

  const evaluations = interactionIndexes.map(evaluateInteraction);
  return evaluations.find((evaluation) => evaluation.qualified) || evaluations[0];
}

function serializeStrategyCandle(candle) {
  if (!candle) return null;
  return {
    time: candle.time ?? candle.timestamp ?? null,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close)
  };
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

function noSetup(message, marketData, timeframe, candidates, fallbackCodes = [], detectedPatterns = []) {
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
      patternContext: detectedPatterns[0] || null,
      detectedPatterns,
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
  analyst = null,
  patternContext = null,
  strategyEvidence = null
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
    analystAdaptiveFactors: analyst?.adaptive?.factors || [],
    patternContext,
    strategyEvidence
  };
}

export function attachRelevantPatternContext(candidate, detectedPatterns, direction, context = {}) {
  const wantedBias = direction === "long" ? "bullish" : "bearish";
  const patternContext = detectedPatterns.find((pattern) => (
    pattern.bias === wantedBias &&
    pattern.confirmed === true &&
    isPatternAssociatedWithSetup(pattern, candidate, direction, context)
  )) || null;
  return { ...candidate, patternContext };
}

function isPatternAssociatedWithSetup(pattern, candidate, direction, context) {
  const ageCandles = Number(pattern.ageCandles ?? pattern.evidence?.ageCandles);
  if (!Number.isInteger(ageCandles) || ageCandles < 0 || ageCandles > PATTERN_ASSOCIATION_MAX_AGE_CANDLES) return false;
  const setupType = candidate?.setupType;
  if (["Momentum breakout", "Breakout retest"].includes(setupType)) {
    const trigger = getBreakoutTrigger(direction, context.candles);
    const neckline = Number(pattern.evidence?.neckline ?? pattern.keyLevels?.neckline);
    const atrValue = Number(context.indicators?.atr14);
    if (!Number.isFinite(trigger) || !Number.isFinite(neckline) || !Number.isFinite(atrValue) || atrValue <= 0) return false;
    const levelTolerance = Math.max(atrValue * 0.75, Math.abs(trigger) * 0.0025);
    if (Math.abs(neckline - trigger) > levelTolerance) return false;
    if (setupType === "Breakout retest" && ageCandles !== 1) return false;
    return true;
  }
  if (setupType === "Liquidity sweep reversal") {
    const sweep = context.smcState?.liquiditySweep;
    const finalPivotTime = pattern.evidence?.finalPivot?.time;
    return Boolean(
      sweep?.confirmed &&
      sweep.direction === direction &&
      sameCandleTime(sweep.time, finalPivotTime)
    );
  }
  return false;
}

function getBreakoutTrigger(direction, candles = []) {
  const priorWindow = candles.slice(-24, -3);
  if (!priorWindow.length) return null;
  return direction === "long"
    ? Math.max(...priorWindow.map((candle) => Number(candle.high)))
    : Math.min(...priorWindow.map((candle) => Number(candle.low)));
}

function sameCandleTime(left, right) {
  const normalize = (value) => {
    if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  };
  const leftTime = normalize(left);
  const rightTime = normalize(right);
  return leftTime != null && rightTime != null && leftTime === rightTime;
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
