import { minimumRiskReward } from "../risk/riskEngineService.js";

export const STRATEGY_RISK_SHADOW_VERSION = "strategy_risk_shadow_v1";
export const STRATEGY_RISK_SHADOW_STARTED_AT = "2026-08-28T00:00:00.000Z";
export const STRATEGY_RISK_SHADOW_BUFFER_ATR = 0.2;

export const strategyRiskShadowEligibleStrategies = Object.freeze([
  "Breakout retest",
  "Liquidity sweep reversal",
  "VWAP reclaim/rejection",
  "Pullback bounce",
  "Support/resistance retest",
  "Trend continuation",
  "Range bounce",
  "Mean reversion"
]);

const eligibleStrategies = new Set(strategyRiskShadowEligibleStrategies);

export function calculateStrategyRiskShadowDiagnostics(signal = {}, context = {}) {
  const strategy = String(signal.setupType || context.strategy || "");
  const direction = String(signal.direction || "").toLowerCase();
  const indicators = signal.indicators || {};
  const evidence = signal.strategyEvidence || indicators.strategyEvidence || {};
  const atr = positiveNumber(indicators.atr14 ?? signal.riskPlan?.atr);
  const entry = finiteNumber(signal.entryPrice);
  const productionSL = finiteNumber(signal.stopLoss);
  const productionTP = finiteNumber(signal.takeProfit);
  const productionRR = positiveNumber(signal.riskRewardRatio);
  const generatedAt = validTimestamp(signal.generatedAt) || new Date().toISOString();
  const productionRisk = entry == null || productionSL == null ? null : Math.abs(entry - productionSL);
  const opposingStructure = opposingStructureFor(direction, indicators);
  const localStructure = localStructureFor(direction, indicators);
  const base = {
    version: STRATEGY_RISK_SHADOW_VERSION,
    studyStartedAt: STRATEGY_RISK_SHADOW_STARTED_AT,
    generatedAt,
    observationalOnly: true,
    strategy,
    symbol: signal.symbol || context.symbol || null,
    timeframe: signal.timeframe || context.timeframe || null,
    direction,
    confidence: finiteNumber(signal.confidenceScore),
    productionEntry: entry,
    productionSL,
    productionTP,
    productionRR,
    productionTargetR: positiveNumber(signal.riskPlan?.targetMultiple ?? indicators.targetMultiple ?? productionRR),
    productionPlan: {
      entry,
      stopLoss: productionSL,
      takeProfit: productionTP,
      riskReward: productionRR,
      targetMultiple: positiveNumber(signal.riskPlan?.targetMultiple ?? indicators.targetMultiple ?? productionRR)
    },
    atr,
    entryToProductionSLAtr: ratio(productionRisk, atr),
    nearestOpposingStructure: opposingStructure,
    opposingStructureDistanceAtr: opposingStructure == null || entry == null ? null : ratio(Math.abs(opposingStructure - entry), atr),
    opposingStructureDistanceProductionR: opposingStructure == null || entry == null ? null : ratio(Math.abs(opposingStructure - entry), productionRisk),
    shadowSL: null,
    shadowRiskDistance: null,
    originalTpShadowRR: null,
    sameRShadowTP: null,
    sameRShadowRR: null,
    shadowWouldPassRR: null,
    opposingStructure: buildOpposingStructureDiagnostics(opposingStructure, entry, atr, productionRisk),
    evidenceSnapshot: cloneJson(evidence),
    triggerCandle: extractTriggerCandle(strategy, evidence)
  };

  if (strategy === "Momentum breakout") {
    return {
      ...base,
      invalidationStatus: "PARTIAL",
      naturalInvalidation: null,
      shadowPlan: null,
      momentumCandidates: {
        breakoutReferenceLevel: finiteNumber(evidence.referenceLevel),
        triggerDirectionalExtreme: triggerDirectionalExtreme(direction, evidence.triggerCandle),
        localStructuralSwing: localStructure
      }
    };
  }

  if (strategy === "Multi-timeframe continuation") {
    return {
      ...base,
      invalidationStatus: "MISSING",
      naturalInvalidation: null,
      shadowPlan: null,
      multiTimeframeContext: {
        baseRegime: evidence.baseRegimeDirection || indicators.regime || null,
        ema20: finiteNumber(indicators.ema20),
        ema50: finiteNumber(indicators.ema50),
        nearestSupport: finiteNumber(indicators.support),
        nearestResistance: finiteNumber(indicators.resistance),
        recentSwing: localStructure,
        higherTimeframeAgreement: cloneJson(evidence.higherTimeframes || indicators.higherTimeframes || []),
        alignedCount: finiteNumber(evidence.alignedCount),
        opposingCount: finiteNumber(evidence.opposingCount),
        unavailableCount: finiteNumber(evidence.unavailableCount)
      }
    };
  }

  if (!eligibleStrategies.has(strategy)) {
    return { ...base, invalidationStatus: "NOT_APPLICABLE", naturalInvalidation: null, shadowPlan: null };
  }

  const naturalInvalidation = evidence.qualified === true ? finiteNumber(evidence.invalidationLevel) : null;
  const shadowSL = buildStructuralShadowStop({ direction, naturalInvalidation, atr });
  const usable = isValidRiskPlan({ direction, entry, stopLoss: shadowSL }) && productionTP != null && productionRR != null;
  if (!usable) {
    return { ...base, invalidationStatus: "UNAVAILABLE", naturalInvalidation, shadowPlan: null };
  }

  const shadowRiskDistance = Math.abs(entry - shadowSL);
  const originalTpShadowRR = Math.abs(productionTP - entry) / shadowRiskDistance;
  const selectedTargetR = positiveNumber(signal.riskPlan?.targetMultiple ?? indicators.targetMultiple ?? productionRR);
  const opposingDistance = opposingStructure == null ? null : Math.abs(opposingStructure - entry);
  const opposingAvailableR = opposingDistance == null ? null : opposingDistance / shadowRiskDistance;
  const sameRShadowRR = opposingAvailableR == null
    ? selectedTargetR
    : Math.min(selectedTargetR, opposingAvailableR);
  const sameRShadowTP = direction === "long"
    ? entry + shadowRiskDistance * sameRShadowRR
    : entry - shadowRiskDistance * sameRShadowRR;

  return {
    ...base,
    invalidationStatus: "USABLE",
    naturalInvalidation,
    shadowSL: round(shadowSL, 10),
    shadowRiskDistance: round(shadowRiskDistance, 10),
    originalTpShadowRR: round(originalTpShadowRR),
    sameRShadowTP: round(sameRShadowTP, 10),
    sameRShadowRR: round(sameRShadowRR),
    shadowWouldPassRR: originalTpShadowRR >= minimumRiskReward,
    sameRShadowWouldPassRR: sameRShadowRR >= minimumRiskReward,
    entryToNaturalInvalidationAtr: ratio(Math.abs(entry - naturalInvalidation), atr),
    entryToShadowSLAtr: ratio(shadowRiskDistance, atr),
    productionStopClearanceFromInvalidationAtr: ratio(
      direction === "long" ? naturalInvalidation - productionSL : productionSL - naturalInvalidation,
      atr
    ),
    distances: {
      entryToProductionSLAtr: ratio(productionRisk, atr),
      entryToNaturalInvalidationAtr: ratio(Math.abs(entry - naturalInvalidation), atr),
      entryToShadowSLAtr: ratio(shadowRiskDistance, atr),
      productionStopClearanceFromInvalidationAtr: ratio(
        direction === "long" ? naturalInvalidation - productionSL : productionSL - naturalInvalidation,
        atr
      )
    },
    shadowPlan: {
      bufferAtr: STRATEGY_RISK_SHADOW_BUFFER_ATR,
      stopLoss: round(shadowSL, 10),
      riskDistance: round(shadowRiskDistance, 10),
      modelB: {
        takeProfit: productionTP,
        riskReward: round(originalTpShadowRR),
        wouldPassRR: originalTpShadowRR >= minimumRiskReward
      },
      modelC: {
        selectedTargetR,
        takeProfit: round(sameRShadowTP, 10),
        riskReward: round(sameRShadowRR),
        wouldPassRR: sameRShadowRR >= minimumRiskReward,
        opposingStructureCapApplied: opposingAvailableR != null && opposingAvailableR < selectedTargetR
      }
    }
  };
}

export function buildStructuralShadowStop({ direction, naturalInvalidation, atr }) {
  const level = finiteNumber(naturalInvalidation);
  const atrValue = positiveNumber(atr);
  if (level == null || atrValue == null || !["long", "short"].includes(direction)) return null;
  return direction === "long"
    ? round(level - atrValue * STRATEGY_RISK_SHADOW_BUFFER_ATR, 10)
    : round(level + atrValue * STRATEGY_RISK_SHADOW_BUFFER_ATR, 10);
}

export function evaluateStrategyRiskShadowOutcomes({ diagnostics, candles, validUntil, productionOutcome = null } = {}) {
  if (diagnostics?.version !== STRATEGY_RISK_SHADOW_VERSION) return null;
  const generatedAtMs = timestampMs(diagnostics.generatedAt);
  const validUntilMs = timestampMs(validUntil);
  const future = normalizeCandles(candles).filter((candle) => (
    candle.timestamp >= generatedAtMs && candle.timestamp < validUntilMs
  ));
  const result = {
    version: STRATEGY_RISK_SHADOW_VERSION,
    productionOutcome: productionOutcome || null,
    shadowOriginalTpOutcome: null,
    shadowSameRTargetOutcome: null,
    sameCandleAmbiguity: false,
    outcomeCoverageComplete: Number.isFinite(validUntilMs) && future.some((candle) => candle.timestamp >= validUntilMs - timeframeMs(diagnostics.timeframe)),
    immediateShadowStopTouch: immediateStopTouch(diagnostics, future),
    postInvalidation: evaluatePostInvalidation(diagnostics, future, productionOutcome)
  };
  if (diagnostics.invalidationStatus !== "USABLE" || !diagnostics.shadowPlan) return result;
  const modelB = simulateOutcome({
    direction: diagnostics.direction,
    stopLoss: diagnostics.shadowPlan.stopLoss,
    takeProfit: diagnostics.shadowPlan.modelB.takeProfit,
    candles: future
  });
  const modelC = simulateOutcome({
    direction: diagnostics.direction,
    stopLoss: diagnostics.shadowPlan.stopLoss,
    takeProfit: diagnostics.shadowPlan.modelC.takeProfit,
    candles: future
  });
  result.shadowOriginalTpOutcome = modelB.status === "Expired" && !result.outcomeCoverageComplete ? null : modelB.status;
  result.shadowSameRTargetOutcome = modelC.status === "Expired" && !result.outcomeCoverageComplete ? null : modelC.status;
  result.sameCandleAmbiguity = modelB.sameCandleAmbiguity || modelC.sameCandleAmbiguity;
  return result;
}

function simulateOutcome({ direction, stopLoss, takeProfit, candles }) {
  for (const candle of candles) {
    const hitSl = direction === "long" ? candle.low <= stopLoss : candle.high >= stopLoss;
    const hitTp = direction === "long" ? candle.high >= takeProfit : candle.low <= takeProfit;
    if (hitSl) return { status: "Hit SL", sameCandleAmbiguity: hitTp };
    if (hitTp) return { status: "Hit TP", sameCandleAmbiguity: false };
  }
  return { status: "Expired", sameCandleAmbiguity: false };
}

function immediateStopTouch(diagnostics, future) {
  const stop = finiteNumber(diagnostics.shadowPlan?.stopLoss);
  if (stop == null) return null;
  const trigger = normalizeCandle(diagnostics.triggerCandle);
  if (trigger && touchesStop(trigger, diagnostics.direction, stop)) return "trigger_candle";
  const hitIndex = future.findIndex((candle) => touchesStop(candle, diagnostics.direction, stop));
  if (hitIndex < 0) return "not_touched";
  if (hitIndex === 0) return "first_completed_candle_afterward";
  if (hitIndex <= 2) return "candles_2_to_3";
  return "later";
}

function evaluatePostInvalidation(diagnostics, future, productionOutcome) {
  const invalidation = finiteNumber(diagnostics.naturalInvalidation);
  const entry = finiteNumber(diagnostics.productionPlan?.entry);
  const productionStop = finiteNumber(diagnostics.productionPlan?.stopLoss);
  const productionRisk = entry == null || productionStop == null ? null : Math.abs(entry - productionStop);
  if (invalidation == null) return { occurred: false };
  const index = future.findIndex((candle) => touchesStop(candle, diagnostics.direction, invalidation));
  if (index < 0) return { occurred: false };
  const after = future.slice(index);
  const productionTP = finiteNumber(diagnostics.productionPlan?.takeProfit);
  const productionSL = finiteNumber(diagnostics.productionPlan?.stopLoss);
  const later = productionTP == null || productionSL == null
    ? null
    : simulateOutcome({ direction: diagnostics.direction, stopLoss: productionSL, takeProfit: productionTP, candles: after });
  const excursions = priceExcursions(after, diagnostics.direction, entry);
  return {
    occurred: true,
    firstOccurrenceTime: new Date(future[index].timestamp).toISOString(),
    laterProductionPathOutcome: later?.status || productionOutcome || null,
    sameCandleAmbiguity: Boolean(later?.sameCandleAmbiguity),
    maximumFavorableExcursionPrice: excursions.mfe,
    maximumAdverseExcursionPrice: excursions.mae,
    maximumFavorableExcursionProductionR: ratio(excursions.mfe, productionRisk),
    maximumAdverseExcursionProductionR: ratio(excursions.mae, productionRisk)
  };
}

function priceExcursions(candles, direction, entry) {
  if (entry == null || !candles.length) return { mfe: null, mae: null };
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  return direction === "long"
    ? { mfe: Math.max(0, Math.max(...highs) - entry), mae: Math.max(0, entry - Math.min(...lows)) }
    : { mfe: Math.max(0, entry - Math.min(...lows)), mae: Math.max(0, Math.max(...highs) - entry) };
}

function extractTriggerCandle(strategy, evidence) {
  return cloneJson(
    strategy === "Breakout retest" ? evidence.retestCandle
      : strategy === "Liquidity sweep reversal" ? evidence.confirmationCandle
        : strategy === "VWAP reclaim/rejection" ? evidence.interactionCandle
          : strategy === "Trend continuation" ? evidence.continuationCandle
            : strategy === "Momentum breakout" ? evidence.triggerCandle
              : evidence.confirmationCandle || evidence.interactionCandle || evidence.reversalCandle || null
  );
}

function triggerDirectionalExtreme(direction, candle) {
  return finiteNumber(direction === "long" ? candle?.low : candle?.high);
}

function opposingStructureFor(direction, indicators) {
  return finiteNumber(direction === "long" ? indicators.resistance : indicators.support);
}

function localStructureFor(direction, indicators) {
  return finiteNumber(direction === "long" ? indicators.support : indicators.resistance);
}

function buildOpposingStructureDiagnostics(price, entry, atr, productionRisk) {
  if (price == null || entry == null) return null;
  const distance = Math.abs(price - entry);
  return {
    price,
    distanceAtr: ratio(distance, atr),
    distanceProductionR: ratio(distance, productionRisk)
  };
}

function isValidRiskPlan({ direction, entry, stopLoss }) {
  if (entry == null || stopLoss == null) return false;
  return direction === "long" ? stopLoss < entry : direction === "short" && stopLoss > entry;
}

function normalizeCandles(candles) {
  const selected = new Map();
  for (const candle of Array.isArray(candles) ? candles : []) {
    const normalized = normalizeCandle(candle);
    if (normalized) selected.set(normalized.timestamp, normalized);
  }
  return [...selected.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function normalizeCandle(candle) {
  const timestamp = timestampMs(candle?.time ?? candle?.timestamp);
  const open = finiteNumber(candle?.open);
  const high = finiteNumber(candle?.high);
  const low = finiteNumber(candle?.low);
  const close = finiteNumber(candle?.close);
  if (![timestamp, open, high, low, close].every(Number.isFinite) || high < low) return null;
  return { timestamp, open, high, low, close };
}

function touchesStop(candle, direction, price) {
  return direction === "long" ? candle.low <= price : candle.high >= price;
}

function timeframeMs(timeframe) {
  return { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 }[timeframe] || 0;
}

function timestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  return new Date(value).getTime();
}

function validTimestamp(value) {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
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

function ratio(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? round(numerator / denominator)
    : null;
}

function round(value, precision = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(precision)) : null;
}

function cloneJson(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}
