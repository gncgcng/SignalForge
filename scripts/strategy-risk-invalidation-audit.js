import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { generateMarketDataSetup } from "../src/modules/signals/signalGenerator.js";
import { analyzeMarketRegime } from "../src/modules/market-data/marketRegimeService.js";
import { analyzeAdvancedMarketStructure } from "../src/modules/market-data/advancedMarketStructureService.js";
import { timeframeDurationSeconds } from "../src/modules/market-data/candleIntegrity.js";
import { buildDynamicRiskPlan, minimumRiskReward } from "../src/modules/risk/riskEngineService.js";
import { candleOutcome } from "../src/modules/admin-signals/generatedSignalService.js";
import { getSignalValidityMs } from "../src/modules/signals/signalValidityService.js";

export const STRUCTURAL_ALIGNMENT_TOLERANCE_ATR = 0.1;
export const strategyInventory = [
  "Momentum breakout",
  "Breakout retest",
  "Liquidity sweep reversal",
  "VWAP reclaim/rejection",
  "Multi-timeframe continuation",
  "Pullback bounce",
  "Support/resistance retest",
  "Trend continuation",
  "Range bounce",
  "Mean reversion"
];

export const naturalInvalidationInventory = {
  "Momentum breakout": {
    status: "PARTIAL",
    evidence: "strategyEvidence.referenceLevel",
    meaning: "The fresh-breakout boundary is stored, but no explicit buffered failure price or trigger-candle extreme is designated as invalidation. The audit uses the reference level only as a labeled proxy."
  },
  "Breakout retest": {
    status: "USABLE",
    evidence: "strategyEvidence.invalidationLevel plus retestExtreme and breakoutLevel",
    meaning: "The failed-side edge of the +/-0.35 ATR retest zone is explicit; the interaction wick is retained for a second comparison."
  },
  "Liquidity sweep reversal": {
    status: "USABLE",
    evidence: "strategyEvidence.invalidationLevel",
    meaning: "The sweep candle extreme is the explicit invalidation price."
  },
  "VWAP reclaim/rejection": {
    status: "USABLE",
    evidence: "strategyEvidence.invalidationLevel",
    meaning: "The reclaim/rejection interaction candle extreme is explicit."
  },
  "Multi-timeframe continuation": {
    status: "MISSING",
    evidence: "none",
    meaning: "The evidence stores directional regime/EMA/HTF agreement, not a local price invalidation. Generic support/resistance remains separate and is not strategy-specific evidence."
  },
  "Pullback bounce": {
    status: "USABLE",
    evidence: "strategyEvidence.invalidationLevel",
    meaning: "The pullback interaction extreme is explicit."
  },
  "Support/resistance retest": {
    status: "USABLE",
    evidence: "strategyEvidence.invalidationLevel",
    meaning: "The retest interaction extreme is explicit alongside the tested level."
  },
  "Trend continuation": {
    status: "USABLE",
    evidence: "strategyEvidence.invalidationLevel",
    meaning: "The pause/base low or high is explicit."
  },
  "Range bounce": {
    status: "USABLE",
    evidence: "strategyEvidence.invalidationLevel",
    meaning: "The tested boundary interaction extreme is explicit."
  },
  "Mean reversion": {
    status: "USABLE",
    evidence: "strategyEvidence.invalidationLevel",
    meaning: "The reversal extension extreme is explicit."
  }
};

export function classifyStructuralStop({ direction, entry, productionStop, naturalInvalidation, atr, toleranceAtr = STRUCTURAL_ALIGNMENT_TOLERANCE_ATR }) {
  if (naturalInvalidation == null || naturalInvalidation === "") {
    return {
      available: false,
      classification: "MISSING_INVALIDATION",
      structuralStopClearanceAtr: null,
      stopVsInvalidationAtr: null,
      entryToSLAtr: null,
      entryToInvalidationAtr: null
    };
  }
  const values = [entry, productionStop, naturalInvalidation, atr].map(Number);
  if (!values.every(Number.isFinite) || values[3] <= 0 || !["long", "short"].includes(direction)) {
    return {
      available: false,
      classification: "MISSING_INVALIDATION",
      structuralStopClearanceAtr: null,
      stopVsInvalidationAtr: null,
      entryToSLAtr: null,
      entryToInvalidationAtr: null
    };
  }
  const [entryValue, stopValue, invalidationValue, atrValue] = values;
  const structuralStopClearanceAtr = direction === "long"
    ? (invalidationValue - stopValue) / atrValue
    : (stopValue - invalidationValue) / atrValue;
  const classification = structuralStopClearanceAtr < -toleranceAtr
    ? "INSIDE_STRUCTURE"
    : structuralStopClearanceAtr > toleranceAtr
      ? "BEYOND_INVALIDATION"
      : "NEAR_INVALIDATION";
  return {
    available: true,
    classification,
    structuralStopClearanceAtr: round(structuralStopClearanceAtr),
    stopVsInvalidationAtr: round(-structuralStopClearanceAtr),
    entryToSLAtr: round(Math.abs(entryValue - stopValue) / atrValue),
    entryToInvalidationAtr: round(Math.abs(entryValue - invalidationValue) / atrValue)
  };
}

export function auditEventOrdering({ signal, candles, naturalInvalidation = null, validUntil = Infinity }) {
  const direction = signal.direction;
  const entry = Number(signal.entryPrice ?? signal.entry);
  const stopLoss = Number(signal.stopLoss);
  const takeProfit = Number(signal.takeProfit);
  const atr = Number(signal.atr ?? signal.indicators?.atr14);
  const risk = Math.abs(entry - stopLoss);
  const invalidation = finiteNullable(naturalInvalidation);
  let invalidationTime = null;
  let terminal = null;
  let sameCandleAmbiguity = false;
  let mfePrice = 0;
  let maePrice = 0;
  let cutoffReason = null;

  for (const candle of candles) {
    const time = candleTime(candle);
    if (!Number.isFinite(time) || time >= validUntil) continue;
    if (cutoffReason == null) {
      const favorable = direction === "long" ? Number(candle.high) - entry : entry - Number(candle.low);
      const adverse = direction === "long" ? entry - Number(candle.low) : Number(candle.high) - entry;
      mfePrice = Math.max(mfePrice, favorable, 0);
      maePrice = Math.max(maePrice, adverse, 0);
    }
    const invalidationHit = invalidation == null ? false : direction === "long"
      ? Number(candle.low) <= invalidation
      : Number(candle.high) >= invalidation;
    const hit = candleOutcome({ direction, stopLoss, takeProfit }, candle);
    if (invalidationHit && invalidationTime == null) invalidationTime = time;
    if (hit) {
      terminal = { ...hit, time };
      sameCandleAmbiguity = invalidationHit && invalidationTime === time;
      if (cutoffReason == null) cutoffReason = hit.status;
      break;
    }
    if (invalidationHit) {
      if (cutoffReason == null) cutoffReason = "Natural invalidation";
    }
  }

  if (!terminal) {
    terminal = { status: "Expired", time: null, reason: "Validity window ended without TP or SL." };
    if (cutoffReason == null) cutoffReason = "Expired";
  }
  const invalidationBeforeTerminal = invalidationTime != null && (terminal?.time == null || invalidationTime < terminal.time);
  const slBeforeInvalidation = terminal?.status === "Hit SL" && invalidation != null && invalidationTime == null;
  return {
    status: terminal?.status || "Structurally invalidated",
    terminalTime: terminal?.time ?? null,
    invalidationTime,
    cutoffReason,
    sameCandleAmbiguity,
    prematureStructuralStop: slBeforeInvalidation,
    delayedStructuralExit: invalidationBeforeTerminal,
    tpBeforeInvalidation: terminal?.status === "Hit TP" && invalidationTime == null,
    mfeAtr: Number.isFinite(atr) && atr > 0 ? round(mfePrice / atr) : null,
    maeAtr: Number.isFinite(atr) && atr > 0 ? round(maePrice / atr) : null,
    mfeR: risk > 0 ? round(mfePrice / risk) : null,
    maeR: risk > 0 ? round(maePrice / risk) : null
  };
}

export function classifyTargetStructure({ direction, entry, takeProfit, opposingStructure, atr, toleranceAtr = STRUCTURAL_ALIGNMENT_TOLERANCE_ATR }) {
  if (opposingStructure == null || opposingStructure === "") {
    return { available: false, classification: "OPPOSING_STRUCTURE_UNAVAILABLE", distanceAtr: null };
  }
  const values = [entry, takeProfit, opposingStructure, atr].map(Number);
  if (!values.every(Number.isFinite) || values[3] <= 0) return { available: false, classification: "OPPOSING_STRUCTURE_UNAVAILABLE", distanceAtr: null };
  const [, target, opposing, atrValue] = values;
  const signedDistance = direction === "long" ? (target - opposing) / atrValue : (opposing - target) / atrValue;
  return {
    available: true,
    classification: signedDistance > toleranceAtr
      ? "TARGET_BEYOND_OPPOSING_STRUCTURE"
      : signedDistance < -toleranceAtr
        ? "STRUCTURALLY_CLEAR_TARGET"
        : "TARGET_NEAR_OPPOSING_STRUCTURE",
    distanceAtr: round(signedDistance)
  };
}

export async function runStrategyRiskInvalidationAudit(options = {}) {
  const dataFolder = resolve(options.dataFolder || argument("--data-folder") || "C:\\Users\\monge\\Documents\\SignalForgeData");
  const audit = JSON.parse(await readFile(join(dataFolder, "cross-period-signal-stability-audit.json"), "utf8"));
  assert.equal(audit.signals?.length, 99, "Expected the complete 99-signal cross-period cohort.");
  const manifestCache = new Map();
  const records = [];
  const skipped = [];

  for (const stored of audit.signals) {
    const manifest = await loadManifest(stored, dataFolder, manifestCache);
    const setupTime = Number(String(stored.setupKey).split(":").at(-1));
    const baseCandles = (manifest.candles[stored.timeframe] || []).filter((candle) => candle.time <= setupTime);
    if (baseCandles.length < 60 || baseCandles.at(-1)?.time !== setupTime) {
      skipped.push({ signalIdentifier: stored.signalIdentifier, reason: "missing_base_warmup_or_setup_candle" });
      continue;
    }
    const generated = generateMarketDataSetup(buildMarketData(stored, manifest, baseCandles, setupTime), stored.timeframe);
    if (!generated.valid || !strategyInventory.includes(generated.signal?.setupType)) continue;
    const signal = generated.signal;
    const atr = Number(signal.indicators?.atr14);
    const invalidation = resolveNaturalInvalidation(signal);
    const stopComparison = classifyStructuralStop({
      direction: signal.direction,
      entry: signal.entryPrice,
      productionStop: signal.stopLoss,
      naturalInvalidation: invalidation.price,
      atr
    });
    const interval = timeframeDurationSeconds[stored.timeframe];
    const createdAt = setupTime + interval;
    const validUntil = createdAt + getSignalValidityMs(stored.timeframe) / 1000;
    const future = (manifest.candles[stored.timeframe] || []).filter((candle) => candle.time >= createdAt && candle.time < validUntil);
    const coverageComplete = (manifest.candles[stored.timeframe] || []).at(-1)?.time + interval >= validUntil;
    const eventAudit = coverageComplete
      ? auditEventOrdering({ signal: { ...signal, atr }, candles: future, naturalInvalidation: invalidation.price, validUntil })
      : null;
    const opposingStructure = signal.direction === "long"
      ? finiteNullable(signal.indicators?.resistance)
      : finiteNullable(signal.indicators?.support);
    const protectiveStructure = signal.direction === "long"
      ? finiteNullable(signal.indicators?.support)
      : finiteNullable(signal.indicators?.resistance);
    const targetAudit = classifyTargetStructure({
      direction: signal.direction,
      entry: signal.entryPrice,
      takeProfit: signal.takeProfit,
      opposingStructure,
      atr
    });
    const triggerClose = Number(baseCandles.at(-1).close);
    const outcome = eventAudit?.status === "Structurally invalidated"
      ? replayTerminalOutcome(signal, future, validUntil)
      : eventAudit;
    records.push({
      signalIdentifier: stored.signalIdentifier,
      source: stored.source || null,
      period: stored.period,
      symbol: stored.symbol,
      timeframe: stored.timeframe,
      setupTime,
      strategy: signal.setupType,
      direction: signal.direction,
      confidence: Number(signal.confidenceScore),
      entry: Number(signal.entryPrice),
      triggerClose,
      entryDeltaAtr: atr > 0 ? round(Math.abs(Number(signal.entryPrice) - triggerClose) / atr) : null,
      stopLoss: Number(signal.stopLoss),
      takeProfit: Number(signal.takeProfit),
      atr,
      ema20: finiteNullable(signal.indicators?.ema20),
      ema50: finiteNullable(signal.indicators?.ema50),
      riskReward: Number(signal.riskRewardRatio),
      requestedTargetR: finiteNullable(signal.riskPlan?.targetMultiple),
      opposingStructure,
      protectiveStructure,
      opposingRoomR: opposingStructure == null ? null : round(Math.abs(opposingStructure - Number(signal.entryPrice)) / Math.abs(Number(signal.entryPrice) - Number(signal.stopLoss))),
      invalidation,
      stopComparison,
      targetAudit,
      eventAudit,
      outcomeStatus: outcome?.status || null,
      realizedR: outcome?.status === "Hit TP" ? Number(signal.riskRewardRatio) : outcome?.status === "Hit SL" ? -1 : outcome?.status === "Expired" ? 0 : null,
      breakoutRetestWickComparison: signal.setupType === "Breakout retest"
        ? classifyStructuralStop({ direction: signal.direction, entry: signal.entryPrice, productionStop: signal.stopLoss, naturalInvalidation: signal.strategyEvidence?.retestExtreme, atr })
        : null,
      strategyEvidence: signal.strategyEvidence || null,
      createdAt,
      validUntil,
      triggerCandle: options.includeRecords ? { ...baseCandles.at(-1) } : undefined,
      futureCandles: options.includeRecords ? future.map((candle) => ({ ...candle })) : undefined
    });
  }

  const deterministicRiskFixtures = buildDeterministicRiskFixtures();
  const report = buildReport({ audit, records, skipped, deterministicRiskFixtures });
  if (options.includeRecords) report.records = records;
  if (options.print !== false) printReport(report);
  return report;
}

function buildReport({ audit, records, skipped, deterministicRiskFixtures }) {
  const completed = records.filter((item) => item.outcomeStatus);
  const comparable = records.filter((item) => item.stopComparison.available);
  const strictUsable = comparable.filter((item) => item.invalidation.status === "USABLE");
  const highConfidence = records.filter((item) => item.confidence >= 90);
  const strategyTable = Object.fromEntries(strategyInventory.map((strategy) => {
    const selected = records.filter((item) => item.strategy === strategy);
    return [strategy, summarizeGroup(selected)];
  }));
  const stopBuckets = bucketPerformance(records, stopDistanceBucket);
  const invalidationBucketsByStrategy = Object.fromEntries(strategyInventory.map((strategy) => [
    strategy,
    bucketCounts(records.filter((item) => item.strategy === strategy && item.stopComparison.available), (item) => invalidationDistanceBucket(item.stopComparison.entryToInvalidationAtr))
  ]));
  const timeframeBreakdown = Object.fromEntries(["5m", "15m", "1h", "4h"].map((timeframe) => [timeframe, summarizeGroup(records.filter((item) => item.timeframe === timeframe))]));
  const sourceValues = [...new Set(records.map((item) => item.source).filter(Boolean))];
  const sourceBreakdown = Object.fromEntries(sourceValues.map((source) => [source, summarizeGroup(records.filter((item) => item.source === source))]));
  const highConfidenceSummary = summarizeGroup(highConfidence);
  highConfidenceSummary.stopInsideStructurePercent = percent(
    highConfidence.filter((item) => item.stopComparison.classification === "INSIDE_STRUCTURE").length,
    highConfidence.filter((item) => item.stopComparison.available).length
  );
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    auditType: "read_only_strategy_risk_invalidation_characterization",
    productionBehaviorChanged: false,
    methodology: {
      sourceCohort: "99 stored cross-period replay anchors, regenerated through current generateMarketDataSetup",
      historicalCandles: "genuine deterministic manifests; no live provider and no database",
      acceptedSignals: records.length,
      completedOutcomeSignals: completed.length,
      sameCandleOrdering: "canonical candleOutcome is stop-first for TP/SL; SL and natural invalidation in one OHLC candle are separately marked ambiguous",
      structuralToleranceAtr: STRUCTURAL_ALIGNMENT_TOLERANCE_ATR,
      entryActivation: "Production entry is the latest completed trigger candle close, rounded only; no separate pending-entry activation is modeled.",
      excursionCutoff: "MFE/MAE includes OHLC extremes through the first terminal or natural-invalidation candle; intrabar sequence on that candle is unavailable.",
      feesSpreadSlippage: "not modeled or stored",
      futureLeakage: false
    },
    productionRiskPipeline: {
      entry: "signalGenerator uses latest completed candle close; final price rounding is 2 decimals above 1000 and 4 decimals otherwise",
      preliminaryStop: "nearest support/resistance +/-0.2 ATR when within 3 ATR, otherwise 1.4 ATR; high-volatility preliminary candidates widen risk 1.25x",
      finalStop: "Dynamic Risk Engine replaces preliminary levels with max(regime ATR floor, generic nearest support/resistance +/-0.2 ATR), ignoring structural candidates beyond 3.5 ATR",
      stopMultipliers: { highVolatility: 1.9, breakout: 1.65, range: 1.15, lowVolatility: 1.25, strongTrend: 1.55, default: 1.4 },
      target: "risk distance multiplied by regime target R and capped at generic opposing support/resistance room",
      targetMultiples: { range: 1.8, breakoutOrBreakoutRetest: 2.5, trendStrengthAtLeastPoint8: 2.6, trendStrengthAtLeastPoint65: 2.3, default: 2.0 },
      minimumRiskReward: minimumRiskReward,
      validationMinimumRiskReward: 1.5,
      strategyAwareness: "PARTIAL: setupType affects target only for Breakout retest; regime affects stop and target. strategyEvidence never affects stop, target, R/R, or risk tier.",
      persistence: "Generated-signal upsert stores the immutable accepted Entry/SL/TP/RR snapshot and compact full_analysis; duplicate saves only extend source_history. Outcome updates are separate."
    },
    naturalInvalidationInventory,
    cohort: {
      sourceSignals: audit.signals.length,
      acceptedCurrentSignals: records.length,
      skipped: skipped.length,
      dateRange: dateRange(records),
      symbols: [...new Set(records.map((item) => item.symbol))].sort(),
      timeframes: [...new Set(records.map((item) => item.timeframe))].sort(),
      sourceMetadata: sourceValues,
      manualVsWatcherAvailable: sourceValues.some((source) => ["manual_scan", "auto_crypto_watcher"].includes(source))
    },
    overall: summarizeGroup(records),
    strictUsableInvalidation: summarizeGroup(strictUsable),
    partialOrUsableInvalidation: summarizeGroup(comparable),
    perStrategy: strategyTable,
    stopDistanceDistribution: stopBuckets,
    naturalInvalidationDistanceByStrategy: invalidationBucketsByStrategy,
    targetStructure: countBy(records, (item) => item.targetAudit.classification),
    targetStructureExamples: records
      .filter((item) => item.targetAudit.classification === "TARGET_BEYOND_OPPOSING_STRUCTURE")
      .slice(0, 10)
      .map((item) => ({
        signalIdentifier: item.signalIdentifier,
        strategy: item.strategy,
        direction: item.direction,
        entry: item.entry,
        takeProfit: item.takeProfit,
        opposingStructure: item.opposingStructure,
        atr: item.atr,
        distanceAtr: item.targetAudit.distanceAtr,
        requestedTargetR: item.requestedTargetR,
        actualR: item.riskReward
      })),
    targetReachability: reachability(records),
    eventOrdering: {
      prematureStructuralStops: comparable.filter((item) => item.eventAudit?.prematureStructuralStop).length,
      delayedStructuralExits: comparable.filter((item) => item.eventAudit?.delayedStructuralExit).length,
      ambiguousSameCandle: comparable.filter((item) => item.eventAudit?.sameCandleAmbiguity).length,
      delayedByStrategy: Object.fromEntries(strategyInventory.map((strategy) => {
        const delayed = records.filter((item) => item.strategy === strategy && item.eventAudit?.delayedStructuralExit);
        return [strategy, {
          count: delayed.length,
          medianExcessStopClearanceAtr: median(delayed.map((item) => item.stopComparison.structuralStopClearanceAtr)),
          maximumExcessStopClearanceAtr: maximum(delayed.map((item) => item.stopComparison.structuralStopClearanceAtr)),
          eventualOutcomes: countBy(delayed, (item) => item.outcomeStatus || "Unavailable")
        }];
      }))
    },
    excursionByStrategy: Object.fromEntries(strategyInventory.map((strategy) => [strategy, excursionSummary(records.filter((item) => item.strategy === strategy))])),
    winnersVsLosers: Object.fromEntries(strategyInventory.map((strategy) => [strategy, winnerLoser(records.filter((item) => item.strategy === strategy))])),
    momentum: momentumSummary(records.filter((item) => item.strategy === "Momentum breakout")),
    breakoutRetest: breakoutSummary(records.filter((item) => item.strategy === "Breakout retest")),
    liquiditySweep: {
      historical: summarizeGroup(records.filter((item) => item.strategy === "Liquidity sweep reversal")),
      deterministicFixture: deterministicRiskFixtures["Liquidity sweep reversal"]
    },
    deterministicRiskFixtures,
    highConfidence: highConfidenceSummary,
    timeframeBreakdown,
    sourceBreakdown,
    entryAudit: {
      count: records.length,
      maximumAbsoluteEntryDeltaAtr: maximum(records.map((item) => item.entryDeltaAtr)),
      nonZeroAfterRounding: records.filter((item) => item.entryDeltaAtr > 0).length,
      slippageAssumption: "none; the completed trigger close is used as entry"
    },
    findings: buildFindings({ records, comparable, strictUsable, highConfidence }),
    limitations: [
      "The 99 records are historical replay anchors, not every setup the current strategy engine could discover across every candle.",
      "Only current accepted signals at those anchors are audited; rejected/no-setup anchors are not risk plans.",
      "Momentum referenceLevel is a PARTIAL proxy, not an explicit production invalidation.",
      "Multi-timeframe continuation has no defensible strategy-specific price invalidation in current evidence.",
      "OHLC cannot establish intrabar order; event-candle MFE/MAE are bounds.",
      "Manual Scan versus Auto Watcher cannot be inferred from independent_holdout source metadata."
    ],
    safeguards: { databaseWrites: false, sourceWrites: false, strategyChanges: false, riskChanges: false, confidenceChanges: false },
    skipped
  };
}

function resolveNaturalInvalidation(signal) {
  const inventory = naturalInvalidationInventory[signal.setupType];
  const evidence = signal.strategyEvidence || signal.indicators?.strategyEvidence || {};
  if (signal.setupType === "Momentum breakout") {
    return { status: inventory.status, price: finiteNullable(evidence.referenceLevel), source: "referenceLevel_proxy", explicit: false };
  }
  if (signal.setupType === "Multi-timeframe continuation") {
    return { status: inventory.status, price: null, source: null, explicit: false };
  }
  return { status: inventory.status, price: finiteNullable(evidence.invalidationLevel), source: "strategyEvidence.invalidationLevel", explicit: true };
}

function replayTerminalOutcome(signal, candles, validUntil) {
  for (const candle of candles) {
    if (candleTime(candle) >= validUntil) break;
    const hit = candleOutcome(signal, candle);
    if (hit) return { ...hit, time: candleTime(candle) };
  }
  return { status: "Expired", time: null };
}

function summarizeGroup(items) {
  const outcomes = countBy(items, (item) => item.outcomeStatus || "Unavailable");
  const usable = items.filter((item) => item.stopComparison.available);
  const realized = items.map((item) => item.realizedR).filter(Number.isFinite);
  return {
    signals: items.length,
    signalsWithUsableOrPartialInvalidation: usable.length,
    explicitUsableInvalidation: usable.filter((item) => item.invalidation.status === "USABLE").length,
    medianEntryToSLAtr: median(items.map((item) => item.stopComparison.entryToSLAtr)),
    medianEntryToInvalidationAtr: median(usable.map((item) => item.stopComparison.entryToInvalidationAtr)),
    medianStructuralStopClearanceAtr: median(usable.map((item) => item.stopComparison.structuralStopClearanceAtr)),
    insideStructure: usable.filter((item) => item.stopComparison.classification === "INSIDE_STRUCTURE").length,
    nearInvalidation: usable.filter((item) => item.stopComparison.classification === "NEAR_INVALIDATION").length,
    beyondInvalidation: usable.filter((item) => item.stopComparison.classification === "BEYOND_INVALIDATION").length,
    prematureStructuralStops: usable.filter((item) => item.eventAudit?.prematureStructuralStop).length,
    delayedStructuralExits: usable.filter((item) => item.eventAudit?.delayedStructuralExit).length,
    ambiguousSameCandle: usable.filter((item) => item.eventAudit?.sameCandleAmbiguity).length,
    tp: outcomes["Hit TP"] || 0,
    sl: outcomes["Hit SL"] || 0,
    expired: outcomes.Expired || 0,
    outcomeUnavailable: outcomes.Unavailable || 0,
    netR: round(realized.reduce((sum, value) => sum + value, 0)),
    expectancyR: realized.length ? round(realized.reduce((sum, value) => sum + value, 0) / realized.length) : null
  };
}

function bucketPerformance(items, bucketFn) {
  const labels = ["below_1_0", "1_0_to_1_24", "1_25_to_1_49", "1_5_to_1_74", "1_75_to_1_99", "2_0_to_2_49", "2_5_plus"];
  return Object.fromEntries(labels.map((label) => [label, summarizeGroup(items.filter((item) => bucketFn(item) === label))]));
}

function bucketCounts(items, bucketFn) {
  const output = {};
  for (const item of items) output[bucketFn(item)] = (output[bucketFn(item)] || 0) + 1;
  return output;
}

function stopDistanceBucket(item) { return invalidationDistanceBucket(item.stopComparison.entryToSLAtr); }
function invalidationDistanceBucket(value) {
  if (!Number.isFinite(value)) return "unavailable";
  if (value < 1) return "below_1_0";
  if (value < 1.25) return "1_0_to_1_24";
  if (value < 1.5) return "1_25_to_1_49";
  if (value < 1.75) return "1_5_to_1_74";
  if (value < 2) return "1_75_to_1_99";
  if (value < 2.5) return "2_0_to_2_49";
  return "2_5_plus";
}

function reachability(items) {
  const available = items.filter((item) => Number.isFinite(item.eventAudit?.mfeR));
  return {
    sample: available.length,
    reachedPoint5R: available.filter((item) => item.eventAudit.mfeR >= 0.5).length,
    reached1R: available.filter((item) => item.eventAudit.mfeR >= 1).length,
    reached1Point5R: available.filter((item) => item.eventAudit.mfeR >= 1.5).length,
    reached2R: available.filter((item) => item.eventAudit.mfeR >= 2).length,
    reachedProductionTP: available.filter((item) => item.eventAudit.mfeR >= item.riskReward).length
  };
}

function excursionSummary(items) {
  return {
    n: items.filter((item) => Number.isFinite(item.eventAudit?.mfeR)).length,
    medianMfeR: median(items.map((item) => item.eventAudit?.mfeR)),
    medianMaeR: median(items.map((item) => item.eventAudit?.maeR)),
    medianMaeAtr: median(items.map((item) => item.eventAudit?.maeAtr)),
    maximumMfeR: maximum(items.map((item) => item.eventAudit?.mfeR)),
    maximumMaeR: maximum(items.map((item) => item.eventAudit?.maeR))
  };
}

function winnerLoser(items) {
  const select = (status) => {
    const chosen = items.filter((item) => item.outcomeStatus === status);
    return {
      n: chosen.length,
      medianEntryToSLAtr: median(chosen.map((item) => item.stopComparison.entryToSLAtr)),
      medianEntryToInvalidationAtr: median(chosen.map((item) => item.stopComparison.entryToInvalidationAtr)),
      medianStructuralStopClearanceAtr: median(chosen.map((item) => item.stopComparison.structuralStopClearanceAtr)),
      medianTargetR: median(chosen.map((item) => item.riskReward)),
      medianOpposingRoomR: median(chosen.map((item) => item.opposingRoomR)),
      medianMaeR: median(chosen.map((item) => item.eventAudit?.maeR)),
      medianMfeR: median(chosen.map((item) => item.eventAudit?.mfeR))
    };
  };
  return { tp: select("Hit TP"), sl: select("Hit SL"), reliability: reliability(items.length) };
}

function momentumSummary(items) {
  return {
    ...summarizeGroup(items),
    invalidationEvidence: "PARTIAL reference-level proxy",
    genericStopInsideReferenceProxy: items.filter((item) => item.stopComparison.classification === "INSIDE_STRUCTURE").length,
    genericStopBeyondReferenceProxy: items.filter((item) => item.stopComparison.classification === "BEYOND_INVALIDATION").length,
    losingTradesInvalidatedBeforeStop: items.filter((item) => item.outcomeStatus === "Hit SL" && item.eventAudit?.delayedStructuralExit).length,
    winnersNeedingAdverseMovementBeyondStop: items.filter((item) => item.outcomeStatus === "Hit TP" && item.eventAudit?.maeR > 1).length,
    prospectiveDiagnosticAgreement: "Unavailable: the existing prospective entry-quality report does not store a stop-clearance metric."
  };
}

function breakoutSummary(items) {
  const wickComparable = items.filter((item) => item.breakoutRetestWickComparison?.available);
  return {
    failedSideZoneComparison: summarizeGroup(items),
    retestWickComparison: {
      n: wickComparable.length,
      insideWick: wickComparable.filter((item) => item.breakoutRetestWickComparison.classification === "INSIDE_STRUCTURE").length,
      nearWick: wickComparable.filter((item) => item.breakoutRetestWickComparison.classification === "NEAR_INVALIDATION").length,
      beyondWick: wickComparable.filter((item) => item.breakoutRetestWickComparison.classification === "BEYOND_INVALIDATION").length,
      medianClearanceAtr: median(wickComparable.map((item) => item.breakoutRetestWickComparison.structuralStopClearanceAtr))
    }
  };
}

function buildDeterministicRiskFixtures() {
  const definitions = {
    "Momentum breakout": { natural: 99, status: "PARTIAL", protective: 96.5, regime: { label: "Breakout", trendStrength: 0.7 } },
    "Breakout retest": { natural: 98.3, status: "USABLE", protective: 98.3, regime: { label: "Breakout", trendStrength: 0.7 } },
    "Liquidity sweep reversal": { natural: 97, status: "USABLE", protective: 97, regime: { label: "Range", trendStrength: 0.2 } },
    "VWAP reclaim/rejection": { natural: 97.8, status: "USABLE", protective: 97.8, regime: { label: "Trend Up", trendStrength: 0.7 } },
    "Multi-timeframe continuation": { natural: null, status: "MISSING", protective: 97, regime: { label: "Trend Up", trendStrength: 0.8 } },
    "Pullback bounce": { natural: 98, status: "USABLE", protective: 98, regime: { label: "Trend Up", trendStrength: 0.8 } },
    "Support/resistance retest": { natural: 98.5, status: "USABLE", protective: 98.5, regime: { label: "Trend Up", trendStrength: 0.6 } },
    "Trend continuation": { natural: 98, status: "USABLE", protective: 98, regime: { label: "Trend Up", trendStrength: 0.8 } },
    "Range bounce": { natural: 98.8, status: "USABLE", protective: 98.8, regime: { label: "Range", trendStrength: 0.2 } },
    "Mean reversion": { natural: 98.5, status: "USABLE", protective: 98.5, regime: { label: "Range", trendStrength: 0.2 } }
  };
  return Object.fromEntries(Object.entries(definitions).map(([strategy, definition]) => {
    const entry = 100;
    const atr = 2;
    const opposing = 110;
    const risk = buildDynamicRiskPlan({
      direction: "long",
      entry,
      atr,
      regime: definition.regime,
      setupType: strategy,
      qualityScore: 90,
      protectiveLevel: { price: definition.protective },
      opposingLevel: { price: opposing }
    });
    const comparison = classifyStructuralStop({ direction: "long", entry, productionStop: risk.stopLoss, naturalInvalidation: definition.natural, atr });
    return [strategy, {
      fixtureType: "deterministic risk-compatibility characterization; not profitability evidence",
      direction: "long",
      entry,
      atr,
      naturalInvalidationStatus: definition.status,
      naturalInvalidation: definition.natural,
      productionStop: round(risk.stopLoss),
      structuralStopClearanceAtr: comparison.structuralStopClearanceAtr,
      stopClassification: comparison.classification,
      takeProfit: round(risk.takeProfit),
      riskReward: round(risk.riskRewardRatio),
      requestedTargetR: risk.targetMultiple,
      opposingStructure: opposing,
      stopStyle: risk.stopStyle,
      tradeAllowed: risk.tradeAllowed
    }];
  }));
}

function buildFindings({ records, comparable, strictUsable, highConfidence }) {
  const inside = comparable.filter((item) => item.stopComparison.classification === "INSIDE_STRUCTURE");
  const beyond = comparable.filter((item) => item.stopComparison.classification === "BEYOND_INVALIDATION");
  const targetBeyond = records.filter((item) => item.targetAudit.classification === "TARGET_BEYOND_OPPOSING_STRUCTURE");
  const targetUnavailable = records.filter((item) => item.targetAudit.classification === "OPPOSING_STRUCTURE_UNAVAILABLE");
  const delayed = comparable.filter((item) => item.eventAudit?.delayedStructuralExit);
  return {
    CRITICAL: [
      ...(percent(inside.length, comparable.length) >= 30 ? [`${inside.length}/${comparable.length} comparable stops (${percent(inside.length, comparable.length)}%) lie inside explicit/proxy structure.`] : []),
      ...(targetBeyond.length ? [`${targetBeyond.length} targets lie materially beyond the stored nearest opposing structure.`] : [])
    ],
    HIGH: [
      "The generic stop ignores strategyEvidence for every strategy.",
      "Multi-timeframe continuation has no stored strategy-specific price invalidation.",
      ...(percent(
        highConfidence.filter((item) => item.stopComparison.classification === "INSIDE_STRUCTURE").length,
        highConfidence.filter((item) => item.stopComparison.available).length
      ) >= 30 ? ["High-confidence signals are disproportionately affected by stops inside explicit/proxy structure."] : [])
    ],
    MEDIUM: [
      ...(beyond.length ? [`${beyond.length}/${comparable.length} comparable stops lie beyond natural invalidation by more than 0.1 ATR.`] : []),
      ...(delayed.length ? [`${delayed.length}/${comparable.length} comparable structures failed before the eventual production outcome (Momentum reference-level cases remain proxy-based).`] : []),
      ...(targetUnavailable.length ? [`${targetUnavailable.length}/${records.length} signals have no stored nearest opposing structure, so target construction falls back to the regime R multiple.`] : []),
      ...(strictUsable.length < records.length ? ["Natural invalidation coverage is incomplete, limiting cross-strategy comparison."] : [])
    ],
    LOW: ["Final price precision is decimal-count based rather than provider tick-size based."],
    note: "Severity is audit triage only, not a recommended production rule or tuned threshold."
  };
}

function buildMarketData(stored, manifest, candles, setupTime) {
  const order = ["5m", "15m", "1h", "4h"];
  const decisionTime = setupTime + timeframeDurationSeconds[stored.timeframe];
  const higherTimeframes = order.slice(order.indexOf(stored.timeframe) + 1).map((timeframe) => {
    const higherCandles = (manifest.candles[timeframe] || []).filter((candle) => candle.time + timeframeDurationSeconds[timeframe] <= decisionTime);
    return higherCandles.length >= 60
      ? { timeframe, available: true, regime: analyzeMarketRegime(higherCandles) }
      : { timeframe, available: false };
  });
  return {
    pair: { symbol: stored.symbol, assetClass: "Crypto", category: "Crypto" },
    source: "strategy-risk-invalidation-audit",
    candles,
    volumeAvailable: true,
    advancedStructure: analyzeAdvancedMarketStructure(candles, { volumeAvailable: true }),
    confluence: { symbol: stored.symbol, lowerTimeframe: stored.timeframe, higherTimeframes },
    intelligence: null,
    correlation: null
  };
}

async function loadManifest(signal, dataFolder, cache) {
  const prefix = signal.symbol.split("-")[0].toLowerCase();
  const suffix = signal.period === "2024"
    ? "2024-historical-manifest.json"
    : signal.period === "2026 YTD"
      ? "2026-ytd-historical-manifest.json"
      : signal.sourcePeriod === "H2"
        ? "h2-2025-historical-manifest.json"
        : "historical-manifest.json";
  const path = join(dataFolder, `${prefix}-${suffix}`);
  if (!cache.has(path)) {
    const raw = JSON.parse(await readFile(path, "utf8"));
    cache.set(path, { candles: Object.fromEntries(Object.entries(raw.candles || {}).map(([timeframe, candles]) => [timeframe, candles.map(normalizeCandle)])) });
  }
  return cache.get(path);
}

function normalizeCandle(item) {
  return {
    time: Number.isFinite(Number(item.time)) ? Number(item.time) : new Date(item.timestamp).getTime() / 1000,
    open: Number(item.open), high: Number(item.high), low: Number(item.low), close: Number(item.close), volume: Number(item.volume)
  };
}

function printReport(report) {
  console.log("\nStrategy risk/invalidation audit (read-only)\n");
  console.table(Object.entries(report.perStrategy).map(([strategy, value]) => ({ strategy, ...value })));
  console.log("\nStop distance distribution");
  console.table(Object.entries(report.stopDistanceDistribution).map(([bucket, value]) => ({ bucket, count: value.signals, tp: value.tp, sl: value.sl, expired: value.expired, expectancyR: value.expectancyR })));
  console.log("\nTarget structure");
  console.table(Object.entries(report.targetStructure).map(([classification, count]) => ({ classification, count })));
  console.log("\nDeterministic risk compatibility fixtures");
  console.table(Object.entries(report.deterministicRiskFixtures).map(([strategy, value]) => ({ strategy, ...value })));
  console.log("\nAUDIT_JSON");
  console.log(JSON.stringify(report, null, 2));
}

function countBy(items, selector) {
  const output = {};
  for (const item of items) { const key = selector(item); output[key] = (output[key] || 0) + 1; }
  return output;
}
function dateRange(items) {
  const values = items.map((item) => item.setupTime).filter(Number.isFinite).sort((a, b) => a - b);
  return values.length ? { from: new Date(values[0] * 1000).toISOString(), to: new Date(values.at(-1) * 1000).toISOString() } : null;
}
function median(values) {
  const finite = values.filter((value) => value != null && value !== "").map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  return round(finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2);
}
function maximum(values) { const finite = values.filter((value) => value != null && value !== "").map(Number).filter(Number.isFinite); return finite.length ? round(Math.max(...finite)) : null; }
function percent(value, total) { return total ? round(value / total * 100) : null; }
function reliability(n) { return n < 5 ? "anecdotal" : n < 10 ? "very small" : n < 20 ? "small" : "more meaningful but historical only"; }
function candleTime(candle) { const value = Number(candle?.time); return Number.isFinite(value) ? value : new Date(candle?.timestamp).getTime() / 1000; }
function finiteNullable(value) { if (value == null || value === "") return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function round(value) { return Number(Number(value).toFixed(6)); }
function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runStrategyRiskInvalidationAudit().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
