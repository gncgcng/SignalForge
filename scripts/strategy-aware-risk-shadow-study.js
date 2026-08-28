import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { candleOutcome } from "../src/modules/admin-signals/generatedSignalService.js";
import { minimumRiskReward } from "../src/modules/risk/riskEngineService.js";
import {
  classifyStructuralStop,
  runStrategyRiskInvalidationAudit,
  strategyInventory
} from "./strategy-risk-invalidation-audit.js";

export const SHADOW_BUFFER_ATR = 0.2;
const baselineExpectation = {
  signals: 68,
  tp: 13,
  sl: 38,
  expired: 17,
  netR: -5.41,
  expectancyR: -0.079559,
  winRateExcludingExpired: 25.490196
};

export function buildStructuralShadowStop({ direction, naturalInvalidation, atr, bufferAtr = SHADOW_BUFFER_ATR }) {
  const invalidation = finiteNullable(naturalInvalidation);
  const atrValue = Number(atr);
  if (invalidation == null || !Number.isFinite(atrValue) || atrValue <= 0 || !["long", "short"].includes(direction)) return null;
  return round(direction === "long"
    ? invalidation - atrValue * bufferAtr
    : invalidation + atrValue * bufferAtr);
}

export function buildShadowPolicies({ direction, entry, productionTakeProfit, shadowStop, targetMultiple, opposingStructure = null }) {
  const entryValue = Number(entry);
  const stopValue = Number(shadowStop);
  const productionTarget = Number(productionTakeProfit);
  const requestedR = Number(targetMultiple);
  const risk = Math.abs(entryValue - stopValue);
  if (![entryValue, stopValue, productionTarget, requestedR, risk].every(Number.isFinite) || risk <= 0) return null;
  const originalReward = direction === "long" ? productionTarget - entryValue : entryValue - productionTarget;
  const originalTpR = originalReward / risk;
  const opposing = finiteNullable(opposingStructure);
  const availableR = opposing == null ? requestedR : Math.abs(opposing - entryValue) / risk;
  const preservedR = Math.min(requestedR, availableR);
  const preservedTarget = direction === "long"
    ? entryValue + risk * preservedR
    : entryValue - risk * preservedR;
  return {
    risk: round(risk),
    originalTp: {
      stopLoss: stopValue,
      takeProfit: productionTarget,
      riskReward: round(originalTpR),
      wouldRemainEligible: originalTpR >= minimumRiskReward,
      wouldFailRR: originalTpR < minimumRiskReward
    },
    preservedTargetMultiple: {
      stopLoss: stopValue,
      takeProfit: round(preservedTarget),
      requestedRiskReward: requestedR,
      availableRiskReward: round(availableR),
      riskReward: round(preservedR),
      opposingStructureApplied: opposing != null,
      wouldRemainEligible: preservedR >= minimumRiskReward,
      wouldFailRR: preservedR < minimumRiskReward
    }
  };
}

export function simulateTrade({ direction, entry, stopLoss, takeProfit, riskReward, candles, validUntil = Infinity }) {
  const entryValue = Number(entry);
  const stopValue = Number(stopLoss);
  const targetValue = Number(takeProfit);
  const risk = Math.abs(entryValue - stopValue);
  let mfePrice = 0;
  let maePrice = 0;
  let terminalIndex = null;
  let terminalTime = null;
  let sameCandleAmbiguity = false;
  let status = "Expired";
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const time = candleTime(candle);
    if (!Number.isFinite(time) || time >= validUntil) continue;
    mfePrice = Math.max(mfePrice, direction === "long" ? Number(candle.high) - entryValue : entryValue - Number(candle.low), 0);
    maePrice = Math.max(maePrice, direction === "long" ? entryValue - Number(candle.low) : Number(candle.high) - entryValue, 0);
    const hitTp = direction === "long" ? Number(candle.high) >= targetValue : Number(candle.low) <= targetValue;
    const hitSl = direction === "long" ? Number(candle.low) <= stopValue : Number(candle.high) >= stopValue;
    const hit = candleOutcome({ direction, stopLoss: stopValue, takeProfit: targetValue }, candle);
    if (!hit) continue;
    status = hit.status;
    terminalIndex = index;
    terminalTime = time;
    sameCandleAmbiguity = hitTp && hitSl;
    break;
  }
  const realizedR = status === "Hit TP" ? Number(riskReward) : status === "Hit SL" ? -1 : 0;
  return {
    status,
    realizedR: round(realizedR),
    terminalIndex,
    terminalTime,
    sameCandleAmbiguity,
    mfePrice: round(mfePrice),
    maePrice: round(maePrice),
    mfeR: risk > 0 ? round(mfePrice / risk) : null,
    maeR: risk > 0 ? round(maePrice / risk) : null
  };
}

export async function runStrategyAwareRiskShadowStudy(options = {}) {
  const prior = await runStrategyRiskInvalidationAudit({
    dataFolder: options.dataFolder,
    includeRecords: true,
    print: false
  });
  const records = prior.records;
  const modeled = records.map(buildModeledRecord);
  const baseline = summarizeModel(modeled, "current");
  assertBaseline(baseline);
  const modelB = summarizeModel(modeled, "structuralOriginalTp");
  const modelC = summarizeModel(modeled, "structuralPreservedR");
  const eligible = modeled.filter((item) => item.shadowEligible);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    studyType: "strategy_aware_risk_shadow_read_only",
    productionBehaviorChanged: false,
    baselineReproduced: true,
    predefinedRule: {
      bufferAtr: SHADOW_BUFFER_ATR,
      long: "natural invalidation - 0.20 ATR",
      short: "natural invalidation + 0.20 ATR",
      optimized: false
    },
    cohort: {
      totalSignals: modeled.length,
      shadowEligibleSignals: eligible.length,
      ineligibleMomentumPartial: modeled.filter((item) => item.strategy === "Momentum breakout").length,
      ineligibleMtfMissing: modeled.filter((item) => item.strategy === "Multi-timeframe continuation").length
    },
    overall: { modelA_Current: baseline, modelB_StructuralOriginalTp: modelB, modelC_StructuralPreservedR: modelC },
    eligibleSubset: {
      current: summarizeItems(eligible.map((item) => item.current)),
      structuralOriginalTp: summarizeItems(eligible.map((item) => item.structuralOriginalTp)),
      structuralPreservedR: summarizeItems(eligible.map((item) => item.structuralPreservedR))
    },
    eligibilityImpact: {
      evaluated: eligible.length,
      modelBWouldRemainEligible: eligible.filter((item) => item.policyA.wouldRemainEligible).length,
      modelBWouldFailRR: eligible.filter((item) => item.policyA.wouldFailRR).length,
      modelCWouldRemainEligible: eligible.filter((item) => item.policyB.wouldRemainEligible).length,
      modelCWouldFailRR: eligible.filter((item) => item.policyB.wouldFailRR).length,
      note: "Signals are not removed from shadow outcome comparisons."
    },
    perStrategy: Object.fromEntries(strategyInventory.map((strategy) => [strategy, strategySummary(modeled.filter((item) => item.strategy === strategy))])),
    breakoutRetestDetails: modeled.filter((item) => item.strategy === "Breakout retest").map(detailRecord),
    liquiditySweep: {
      historical: modeled.filter((item) => item.strategy === "Liquidity sweep reversal").map(detailRecord),
      deterministicFixture: buildFixtureShadow(prior.deterministicRiskFixtures["Liquidity sweep reversal"])
    },
    zeroSampleFixtures: Object.fromEntries([
      "VWAP reclaim/rejection",
      "Pullback bounce",
      "Support/resistance retest",
      "Trend continuation",
      "Range bounce",
      "Mean reversion"
    ].map((strategy) => [strategy, buildFixtureShadow(prior.deterministicRiskFixtures[strategy])])),
    delayedExitRecovery: delayedRecovery(modeled),
    breakoutRetestRecovery: recoverySummary(modeled.filter((item) => item.strategy === "Breakout retest")),
    momentumRecovery: recoverySummary(modeled.filter((item) => item.strategy === "Momentum breakout"), true),
    momentumInvalidationConcepts: momentumConcepts(modeled.filter((item) => item.strategy === "Momentum breakout")),
    mtfInvalidationConcepts: mtfConcepts(modeled.filter((item) => item.strategy === "Multi-timeframe continuation")),
    shadowRiskDistanceDistribution: bucketRisk(eligible),
    immediateStopNoise: immediateNoise(eligible),
    excursionComparison: excursionComparison(eligible),
    highConfidence: modelComparison(modeled.filter((item) => item.confidence >= 90)),
    timeframe: Object.fromEntries(["5m", "15m", "1h", "4h"].map((timeframe) => [timeframe, modelComparison(modeled.filter((item) => item.timeframe === timeframe))])),
    decisionFramework: buildDecisionFramework(modeled),
    limitations: [
      "Only 13 historical signals have USABLE invalidation in this replay cohort: 12 Breakout Retests and one Liquidity Sweep.",
      "Six strategies rely on deterministic semantic fixtures because the historical anchor cohort generated zero accepted examples.",
      "Momentum concepts are diagnostic only and are not included in Models B/C.",
      "MTF has no explicit price invalidation and remains on production generic risk in Models B/C.",
      "OHLC uses stop-first ordering and cannot resolve intrabar sequence.",
      "Fees, spread, and slippage are not modeled."
    ],
    safeguards: {
      databaseWrites: false,
      outcomeWrites: false,
      productionSourceChanges: false,
      riskChanges: false,
      strategyChanges: false,
      confidenceChanges: false,
      parameterSweep: false
    }
  };
  if (options.includeRecords) report.records = modeled;
  if (options.print !== false) printReport(report);
  return report;
}

function buildModeledRecord(record) {
  const current = simulateTrade({
    direction: record.direction,
    entry: record.entry,
    stopLoss: record.stopLoss,
    takeProfit: record.takeProfit,
    riskReward: record.riskReward,
    candles: record.futureCandles,
    validUntil: record.validUntil
  });
  const shadowEligible = record.invalidation?.status === "USABLE" && finiteNullable(record.invalidation?.price) != null;
  if (!shadowEligible) {
    return {
      ...record,
      shadowEligible,
      current,
      structuralOriginalTp: { ...current },
      structuralPreservedR: { ...current },
      shadowStop: null,
      policyA: null,
      policyB: null
    };
  }
  const shadowStop = buildStructuralShadowStop({ direction: record.direction, naturalInvalidation: record.invalidation.price, atr: record.atr });
  const policies = buildShadowPolicies({
    direction: record.direction,
    entry: record.entry,
    productionTakeProfit: record.takeProfit,
    shadowStop,
    targetMultiple: record.requestedTargetR,
    opposingStructure: record.opposingStructure
  });
  const structuralOriginalTp = simulateTrade({
    direction: record.direction,
    entry: record.entry,
    stopLoss: shadowStop,
    takeProfit: policies.originalTp.takeProfit,
    riskReward: policies.originalTp.riskReward,
    candles: record.futureCandles,
    validUntil: record.validUntil
  });
  const structuralPreservedR = simulateTrade({
    direction: record.direction,
    entry: record.entry,
    stopLoss: shadowStop,
    takeProfit: policies.preservedTargetMultiple.takeProfit,
    riskReward: policies.preservedTargetMultiple.riskReward,
    candles: record.futureCandles,
    validUntil: record.validUntil
  });
  return {
    ...record,
    shadowEligible,
    current,
    shadowStop,
    shadowRiskAtr: round(Math.abs(record.entry - shadowStop) / record.atr),
    policyA: policies.originalTp,
    policyB: policies.preservedTargetMultiple,
    structuralOriginalTp,
    structuralPreservedR
  };
}

function assertBaseline(actual) {
  for (const [key, expected] of Object.entries(baselineExpectation)) {
    assert.ok(Math.abs(Number(actual[key]) - expected) <= 0.000001, `Baseline mismatch for ${key}: expected ${expected}, received ${actual[key]}`);
  }
}

function summarizeModel(items, key) { return summarizeItems(items.map((item) => item[key])); }
function summarizeItems(items) {
  const tp = items.filter((item) => item.status === "Hit TP").length;
  const sl = items.filter((item) => item.status === "Hit SL").length;
  const expired = items.filter((item) => item.status === "Expired").length;
  const netR = round(items.reduce((sum, item) => sum + Number(item.realizedR || 0), 0));
  const winners = items.filter((item) => item.status === "Hit TP").map((item) => Number(item.realizedR));
  const losers = items.filter((item) => item.status === "Hit SL").map((item) => Number(item.realizedR));
  return {
    signals: items.length,
    tp,
    sl,
    expired,
    netR,
    expectancyR: items.length ? round(netR / items.length) : null,
    winRateExcludingExpired: tp + sl ? round(tp / (tp + sl) * 100) : null,
    averageWinnerR: average(winners),
    averageLoserR: average(losers)
  };
}

function strategySummary(items) {
  return {
    historicalCount: items.length,
    usableInvalidationCount: items.filter((item) => item.shadowEligible).length,
    current: summarizeItems(items.map((item) => item.current)),
    modelB: summarizeItems(items.map((item) => item.structuralOriginalTp)),
    modelC: summarizeItems(items.map((item) => item.structuralPreservedR))
  };
}

function detailRecord(item) {
  return {
    signalIdentifier: item.signalIdentifier,
    entry: item.entry,
    atr: item.atr,
    productionStop: item.stopLoss,
    naturalInvalidation: item.invalidation?.price ?? null,
    structuralShadowStop: item.shadowStop,
    productionTakeProfit: item.takeProfit,
    originalRiskReward: item.riskReward,
    structuralOriginalTpRiskReward: item.policyA?.riskReward ?? null,
    structuralPreservedTargetRiskReward: item.policyB?.riskReward ?? null,
    structuralPreservedTarget: item.policyB?.takeProfit ?? null,
    currentOutcome: item.current.status,
    modelBOutcome: item.structuralOriginalTp.status,
    modelCOutcome: item.structuralPreservedR.status
  };
}

function buildFixtureShadow(fixture) {
  const shadowStop = buildStructuralShadowStop({
    direction: fixture.direction,
    naturalInvalidation: fixture.naturalInvalidation,
    atr: fixture.atr
  });
  if (shadowStop == null) return { ...fixture, structuralShadowStop: null, status: "invalidation_unavailable" };
  const policies = buildShadowPolicies({
    direction: fixture.direction,
    entry: fixture.entry,
    productionTakeProfit: fixture.takeProfit,
    shadowStop,
    targetMultiple: fixture.requestedTargetR,
    opposingStructure: fixture.opposingStructure
  });
  return {
    entry: fixture.entry,
    atr: fixture.atr,
    naturalInvalidation: fixture.naturalInvalidation,
    currentStop: fixture.productionStop,
    structuralShadowStop: shadowStop,
    stopDifferenceAtr: round(Math.abs(fixture.productionStop - shadowStop) / fixture.atr),
    currentTakeProfit: fixture.takeProfit,
    candidateTakeProfitSameR: policies.preservedTargetMultiple.takeProfit,
    currentRiskReward: fixture.riskReward,
    originalTpShadowRiskReward: policies.originalTp.riskReward,
    preservedTargetRiskReward: policies.preservedTargetMultiple.riskReward,
    opposingStructure: fixture.opposingStructure,
    semanticOnly: true
  };
}

function delayedRecovery(items) {
  const delayed = items.filter((item) => item.eventAudit?.delayedStructuralExit);
  const ambiguous = items.filter((item) => item.eventAudit?.sameCandleAmbiguity);
  return {
    delayedSignals: delayed.length,
    invalidatedThenSl: delayed.filter((item) => item.current.status === "Hit SL").length,
    invalidatedThenRecoveredToTp: delayed.filter((item) => item.current.status === "Hit TP").length,
    invalidatedThenExpired: delayed.filter((item) => item.current.status === "Expired").length,
    sameCandleAmbiguous: ambiguous.length
  };
}

function recoverySummary(items, proxy = false) {
  const delayed = items.filter((item) => item.eventAudit?.delayedStructuralExit);
  const excursions = delayed.map((item) => postInvalidationMfeR(item));
  return {
    invalidationType: proxy ? "PARTIAL breakout-reference proxy" : "USABLE natural invalidation",
    delayedSignals: delayed.length,
    laterTp: delayed.filter((item) => item.current.status === "Hit TP").length,
    laterSl: delayed.filter((item) => item.current.status === "Hit SL").length,
    laterExpired: delayed.filter((item) => item.current.status === "Expired").length,
    maximumFavorableExcursionAfterInvalidationR: maximum(excursions),
    medianFavorableExcursionAfterInvalidationR: median(excursions)
  };
}

function postInvalidationMfeR(item) {
  const start = item.eventAudit?.invalidationTime;
  if (start == null) return null;
  const end = item.current.terminalTime ?? item.validUntil;
  const risk = Math.abs(item.entry - item.stopLoss);
  let favorable = 0;
  for (const candle of item.futureCandles) {
    const time = candleTime(candle);
    if (time < start || time > end) continue;
    favorable = Math.max(favorable, item.direction === "long" ? Number(candle.high) - item.entry : item.entry - Number(candle.low), 0);
  }
  return risk > 0 ? round(favorable / risk) : null;
}

function momentumConcepts(items) {
  return {
    recommendation: "NEEDS INVALIDATION DEFINITION. None of the existing concepts is explicitly associated and buffered as the production Momentum failure price.",
    referenceLevel: conceptSummary(items, (item) => item.invalidation?.price, "PARTIAL", "A close back through the breakout boundary can invalidate acceptance, but a raw intrabar touch is not an approved stop definition."),
    triggerDirectionalExtreme: conceptSummary(items, (item) => item.direction === "long" ? item.triggerCandle?.low : item.triggerCandle?.high, "PARTIAL", "The trigger extreme is an immediate impulse-failure boundary, but crossing it does not always invalidate the broader breakout structure."),
    nearestLocalStructuralSwing: conceptSummary(items, (item) => item.protectiveStructure, "REJECT", "The nearest generic swing/order-block/profile level is not linked to the breakout trigger and cannot be called strategy-specific invalidation.")
  };
}

function conceptSummary(items, selector, semanticStatus, explanation) {
  const available = items.map((item) => ({ item, price: finiteNullable(selector(item)) })).filter((entry) => entry.price != null);
  const comparisons = available.map(({ item, price }) => classifyStructuralStop({
    direction: item.direction,
    entry: item.entry,
    productionStop: item.stopLoss,
    naturalInvalidation: price,
    atr: item.atr
  }));
  return {
    semanticStatus,
    explanation,
    available: available.length,
    total: items.length,
    medianDistanceAtr: median(available.map(({ item, price }) => Math.abs(item.entry - price) / item.atr)),
    productionStopInside: comparisons.filter((value) => value.classification === "INSIDE_STRUCTURE").length,
    productionStopNear: comparisons.filter((value) => value.classification === "NEAR_INVALIDATION").length,
    productionStopBeyond: comparisons.filter((value) => value.classification === "BEYOND_INVALIDATION").length,
    outcomes: outcomeCounts(available.map(({ item }) => item.current))
  };
}

function mtfConcepts(items) {
  const priceConcept = (name, selector, status, explanation) => ({ name, ...conceptSummary(items, selector, status, explanation) });
  return {
    conclusion: "NEEDS INVALIDATION DEFINITION. No current MTF evidence field is a defensible explicit price invalidation.",
    candidates: [
      priceConcept("latest swing/support-resistance", (item) => item.protectiveStructure, "PARTIAL", "Available generic local structure, but not linked to the MTF continuation base."),
      priceConcept("EMA20", (item) => item.ema20, "PARTIAL", "A cross weakens immediate continuation but does not necessarily invalidate the multi-timeframe thesis."),
      priceConcept("EMA50", (item) => item.ema50, "PARTIAL", "A broader trend-failure proxy, but lagging and not tied to the trigger structure."),
      { name: "continuation base", semanticStatus: "REJECT", available: 0, total: items.length, explanation: "No continuation-base price is stored in current MTF strategy evidence." },
      { name: "base-timeframe regime structure", semanticStatus: "REJECT", available: 0, total: items.length, explanation: "Regime direction is a state, not a price stop." }
    ]
  };
}

function bucketRisk(items) {
  const labels = ["below_0_5", "0_5_to_0_74", "0_75_to_0_99", "1_0_to_1_24", "1_25_to_1_49", "1_5_plus"];
  return Object.fromEntries(labels.map((label) => [label, items.filter((item) => shadowRiskBucket(item.shadowRiskAtr) === label).length]));
}

function shadowRiskBucket(value) {
  if (value < 0.5) return "below_0_5";
  if (value < 0.75) return "0_5_to_0_74";
  if (value < 1) return "0_75_to_0_99";
  if (value < 1.25) return "1_0_to_1_24";
  if (value < 1.5) return "1_25_to_1_49";
  return "1_5_plus";
}

function immediateNoise(items) {
  return Object.fromEntries(strategyInventory.map((strategy) => {
    const selected = items.filter((item) => item.strategy === strategy);
    return [strategy, {
      signals: selected.length,
      triggerCandleOverlap: selected.filter((item) => stopTouched(item.direction, item.shadowStop, item.triggerCandle)).length,
      firstPostTriggerStop: selected.filter((item) => item.structuralOriginalTp.status === "Hit SL" && item.structuralOriginalTp.terminalIndex === 0).length,
      laterStop: selected.filter((item) => item.structuralOriginalTp.status === "Hit SL" && item.structuralOriginalTp.terminalIndex > 0).length,
      neverStopped: selected.filter((item) => item.structuralOriginalTp.status !== "Hit SL").length
    }];
  }));
}

function excursionComparison(items) {
  const comparisons = items.map((item) => {
    const productionRisk = Math.abs(item.entry - item.stopLoss);
    const shadowRisk = Math.abs(item.entry - item.shadowStop);
    const common = commonWindowExcursion(item, item.current.terminalIndex);
    return {
      commonMfePrice: common.mfe,
      commonMaePrice: common.mae,
      commonMfeProductionR: common.mfe / productionRisk,
      commonMfeShadowR: common.mfe / shadowRisk,
      commonMaeProductionR: common.mae / productionRisk,
      commonMaeShadowR: common.mae / shadowRisk,
      modelBMfeR: item.structuralOriginalTp.mfeR,
      modelBMaeR: item.structuralOriginalTp.maeR,
      modelCMfeR: item.structuralPreservedR.mfeR,
      modelCMaeR: item.structuralPreservedR.maeR
    };
  });
  return {
    sample: comparisons.length,
    note: "Common-window price excursion is identical; only the denominator changes. Model-specific values use each model's own terminal candle.",
    medianCommonMfePrice: median(comparisons.map((item) => item.commonMfePrice)),
    medianCommonMaePrice: median(comparisons.map((item) => item.commonMaePrice)),
    medianCommonMfeProductionR: median(comparisons.map((item) => item.commonMfeProductionR)),
    medianCommonMfeShadowR: median(comparisons.map((item) => item.commonMfeShadowR)),
    medianCommonMaeProductionR: median(comparisons.map((item) => item.commonMaeProductionR)),
    medianCommonMaeShadowR: median(comparisons.map((item) => item.commonMaeShadowR)),
    modelBMedianMfeR: median(comparisons.map((item) => item.modelBMfeR)),
    modelBMedianMaeR: median(comparisons.map((item) => item.modelBMaeR)),
    modelCMedianMfeR: median(comparisons.map((item) => item.modelCMfeR)),
    modelCMedianMaeR: median(comparisons.map((item) => item.modelCMaeR))
  };
}

function commonWindowExcursion(item, terminalIndex) {
  const end = terminalIndex == null ? item.futureCandles.length - 1 : terminalIndex;
  let mfe = 0;
  let mae = 0;
  for (let index = 0; index <= end; index += 1) {
    const candle = item.futureCandles[index];
    if (!candle || candleTime(candle) >= item.validUntil) continue;
    mfe = Math.max(mfe, item.direction === "long" ? Number(candle.high) - item.entry : item.entry - Number(candle.low), 0);
    mae = Math.max(mae, item.direction === "long" ? item.entry - Number(candle.low) : Number(candle.high) - item.entry, 0);
  }
  return { mfe, mae };
}

function modelComparison(items) {
  return {
    signals: items.length,
    shadowEligible: items.filter((item) => item.shadowEligible).length,
    current: summarizeItems(items.map((item) => item.current)),
    modelB: summarizeItems(items.map((item) => item.structuralOriginalTp)),
    modelC: summarizeItems(items.map((item) => item.structuralPreservedR))
  };
}

function buildDecisionFramework(items) {
  const count = (strategy) => items.filter((item) => item.strategy === strategy).length;
  return {
    READY_FOR_STRATEGY_AWARE_SL: [],
    NEEDS_MORE_PROSPECTIVE_DATA: [
      { strategy: "Breakout retest", reason: `Explicit invalidation exists, but historical n=${count("Breakout retest")} is small and some failed structures later recovered.` },
      { strategy: "Liquidity sweep reversal", reason: `Explicit invalidation exists, but historical n=${count("Liquidity sweep reversal")} is anecdotal.` },
      { strategy: "VWAP reclaim/rejection", reason: "Explicit semantic invalidation exists; historical sample is zero." },
      { strategy: "Pullback bounce", reason: "Explicit semantic invalidation exists; historical sample is zero." },
      { strategy: "Support/resistance retest", reason: "Explicit semantic invalidation exists; historical sample is zero." },
      { strategy: "Trend continuation", reason: "Explicit semantic invalidation exists; historical sample is zero." },
      { strategy: "Range bounce", reason: "Explicit semantic invalidation exists; historical sample is zero." },
      { strategy: "Mean reversion", reason: "Explicit semantic invalidation exists; historical sample is zero." }
    ],
    NEEDS_INVALIDATION_DEFINITION: ["Momentum breakout", "Multi-timeframe continuation"],
    GENERIC_SL_SHOULD_REMAIN_FOR_NOW: [...strategyInventory],
    note: "No live change is supported by this shadow study alone."
  };
}

function outcomeCounts(items) {
  return {
    tp: items.filter((item) => item.status === "Hit TP").length,
    sl: items.filter((item) => item.status === "Hit SL").length,
    expired: items.filter((item) => item.status === "Expired").length
  };
}

function stopTouched(direction, stop, candle) {
  if (!candle || stop == null) return false;
  return direction === "long" ? Number(candle.low) <= stop : Number(candle.high) >= stop;
}

function printReport(report) {
  console.log("\nStrategy-aware risk shadow study (read-only)\n");
  console.table(Object.entries(report.overall).map(([model, value]) => ({ model, ...value })));
  console.log("\nPer strategy");
  console.table(Object.entries(report.perStrategy).map(([strategy, value]) => ({
    strategy,
    count: value.historicalCount,
    usable: value.usableInvalidationCount,
    currentNetR: value.current.netR,
    modelBNetR: value.modelB.netR,
    modelCNetR: value.modelC.netR,
    current: `${value.current.tp}/${value.current.sl}/${value.current.expired}`,
    modelB: `${value.modelB.tp}/${value.modelB.sl}/${value.modelB.expired}`,
    modelC: `${value.modelC.tp}/${value.modelC.sl}/${value.modelC.expired}`
  })));
  console.log("\nShadow risk distance buckets");
  console.table(Object.entries(report.shadowRiskDistanceDistribution).map(([bucket, count]) => ({ bucket, count })));
  console.log("\nSHADOW_STUDY_JSON");
  console.log(JSON.stringify(report, null, 2));
}

function average(values) { const finite = values.filter((value) => Number.isFinite(Number(value))).map(Number); return finite.length ? round(finite.reduce((sum, value) => sum + value, 0) / finite.length) : null; }
function median(values) { const finite = values.filter((value) => value != null && Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b); if (!finite.length) return null; const middle = Math.floor(finite.length / 2); return round(finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2); }
function maximum(values) { const finite = values.filter((value) => value != null && Number.isFinite(Number(value))).map(Number); return finite.length ? round(Math.max(...finite)) : null; }
function finiteNullable(value) { if (value == null || value === "") return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function candleTime(candle) { const numeric = Number(candle?.time); return Number.isFinite(numeric) ? numeric : new Date(candle?.timestamp).getTime() / 1000; }
function round(value) { return Number(Number(value).toFixed(6)); }

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runStrategyAwareRiskShadowStudy().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
