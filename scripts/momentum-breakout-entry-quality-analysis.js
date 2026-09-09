import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeSmartMoneyConcepts } from "../src/modules/market-data/smartMoneyConceptsService.js";

const CANDLE_LIMIT = 120;
const MAXIMUM_HOLDING_BARS = 20;
const REQUEST_GRANULARITY_SECONDS = Object.freeze({ "5m": 300, "15m": 900, "1h": 3600, "4h": 21600 });
const CANDLE_INTERVAL_SECONDS = Object.freeze({ "5m": 300, "15m": 900, "1h": 3600, "4h": 14400 });
const PERIOD_ORDER = ["2024", "2025", "2026 YTD"];
const EPSILON = 1e-12;

const COMPARISON_FEATURES = Object.freeze([
  "breakoutDistanceAtr",
  "ema20DistanceAtr",
  "ema50DistanceAtr",
  "latestCandleRangeAtr",
  "latestBodyAtr",
  "bodyToRangeRatio",
  "closeLocation",
  "closeBeyondLevelAtr",
  "bodyBeyondLevelFraction",
  "rangeBeyondLevelFraction",
  "rsi14",
  "previous2BarMoveAtr",
  "previous3BarMoveAtr",
  "previous5BarMoveAtr",
  "directionalExpansionCount3",
  "directionalExpansionCount5",
  "volumeRatio20",
  "zeroOrNearZeroRangeFraction",
  "maxRangeToMedianRange",
  "maxVolumeToMedianVolume",
  "rangeCoefficientOfVariation",
  "volumeCoefficientOfVariation",
  "stopDistanceAtr",
  "stopBeyondBreakoutLevelAtr",
  "stopBeyondBreakoutCandleAtr",
  "stopDistanceToNearestSwingAtr",
  "opposingStructureDistanceAtr",
  "structuralRoomConsumedFraction"
]);

const OUTCOME_COMPARISON_FEATURES = Object.freeze([
  "mfeRBeforeTerminalCandle",
  "maeRBeforeTerminalCandle",
  "candlesToTerminal"
]);

const BUCKET_DEFINITIONS = Object.freeze({
  breakoutDistanceAtr: [0.25, 0.5, 0.75, 1, 1.5],
  ema20DistanceAtr: [0.5, 1, 1.5, 2, 3],
  latestCandleRangeAtr: [0.75, 1, 1.25, 1.5, 1.8],
  previous3BarMoveAtr: [0, 0.75, 1.25, 2, 3],
  volumeRatio20: [1.05, 1.2, 1.5, 2, 3],
  stopDistanceAtr: [1.25, 1.5, 1.75, 2, 2.5],
  maxRangeToMedianRange: [2, 3, 4, 6, 10]
});

const COUNTERFACTUALS = Object.freeze([
  { feature: "breakoutDistanceAtr", operator: "<=", thresholds: [0.25, 0.5, 0.75, 1, 1.25] },
  { feature: "ema20DistanceAtr", operator: "<=", thresholds: [0.5, 1, 1.5, 2, 2.5] },
  { feature: "latestCandleRangeAtr", operator: "<=", thresholds: [0.75, 1, 1.25, 1.5, 1.8] },
  { feature: "previous3BarMoveAtr", operator: "<=", thresholds: [1, 1.5, 2, 2.5, 3] },
  { feature: "maxRangeToMedianRange", operator: "<=", thresholds: [3, 4, 5, 6, 8] },
  { feature: "stopDistanceAtr", operator: ">=", thresholds: [1.25, 1.5, 1.75, 2] }
]);

export async function loadMomentumReplayInputs(dataFolder) {
  const absoluteFolder = resolve(dataFolder);
  const names = await readdir(absoluteFolder);
  const resultNames = names.filter((name) => name.endsWith("-risk-replay-results.txt")).sort();
  if (!resultNames.length) throw new Error(`No production-parity replay outputs found in ${absoluteFolder}.`);

  const inputs = [];
  for (const resultName of resultNames) {
    const manifestName = resultName.replace("-risk-replay-results.txt", "-historical-manifest.json");
    if (!names.includes(manifestName)) continue;
    const [resultBuffer, manifestText] = await Promise.all([
      readFile(join(absoluteFolder, resultName)),
      readFile(join(absoluteFolder, manifestName), "utf8")
    ]);
    const resultText = decodeText(resultBuffer);
    const replay = extractJsonDocument(resultText, (value) => Array.isArray(value?.policies?.baseline?.records));
    const manifest = JSON.parse(manifestText);
    validateInputPair(replay, manifest, resultName, manifestName);
    inputs.push({ resultName, manifestName, replay, manifest });
  }
  if (!inputs.length) throw new Error("No replay output had a matching historical manifest.");
  return inputs;
}

export function extractJsonDocument(text, predicate = null) {
  const source = String(text || "");
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const parsed = JSON.parse(source.slice(start, index + 1));
          if (!predicate || predicate(parsed)) return parsed;
        } catch {
          // Replay logs may contain brace-delimited diagnostics before the report.
        }
        break;
      }
    }
  }
  throw new Error(predicate
    ? "Replay output does not contain the required JSON report."
    : "Replay output does not contain a complete JSON document.");
}

export function analyzeMomentumInputs(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error("At least one replay input is required.");
  const records = [];
  const seen = new Set();
  const sourceFiles = [];
  for (const input of inputs) {
    validateInputPair(input.replay, input.manifest, input.resultName, input.manifestName);
    sourceFiles.push({ result: input.resultName, manifest: input.manifestName });
    const observations = new Map((input.replay.observations || [])
      .filter((item) => item?.setupKey)
      .map((item) => [String(item.setupKey).toLowerCase(), item]));
    const momentum = (input.replay.policies?.baseline?.records || [])
      .filter((record) => normalizeStrategy(record.strategy) === "momentum breakout");
    for (const record of momentum) {
      const key = String(record.setupKey || "").toLowerCase();
      if (!key) throw new Error("Momentum replay record is missing setupKey.");
      if (seen.has(key)) continue;
      const observation = observations.get(key);
      if (!observation?.signal) throw new Error(`Replay observation is missing for ${record.setupKey}.`);
      records.push(analyzeMomentumRecord(record, observation, input.manifest));
      seen.add(key);
    }
  }
  records.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.setupKey.localeCompare(right.setupKey));
  if (!records.length) throw new Error("No Momentum Breakout signals were found in the replay inputs.");

  const outcomeMismatches = records.filter((record) => record.outcomeReplay !== record.outcomeReconstructed);
  const atrMismatches = records.filter((record) => record.atrParity.relativeDifference > 0.00001 && record.atrParity.absoluteDifference > 0.00011);
  const comparison = buildWinnerLoserComparison(records);
  const featureRanking = rankFeatures(comparison, COMPARISON_FEATURES);
  const topFeatures = featureRanking.slice(0, 6).map((item) => item.feature);
  const periodSummary = Object.fromEntries(PERIOD_ORDER.map((period) => [period, summarizeOutcomes(records.filter((record) => record.period === period))]));

  return {
    methodology: {
      purpose: "Shadow-only Momentum Breakout entry-quality analysis",
      setupFeaturesUseFutureCandles: false,
      setupSnapshot: "Historical manifest candles at or before replayTimestamp, using the production request window.",
      outcomeJoin: "Completed production-parity baseline outcome, independently reconstructed with stop-first ordering.",
      productionCandleLimit: CANDLE_LIMIT,
      maximumHoldingBars: MAXIMUM_HOLDING_BARS,
      marketQualityWindow: "40 candles strictly before entry",
      expansionDefinition: "Consecutive candles ending at entry with directional close-to-close movement, directional body, and body/range >= 0.50.",
      acceptanceLabels: {
        clean_body_acceptance: "At least 75% of body beyond level and directional close location >= 0.70.",
        barely_closed_beyond: "Close <= 0.10 ATR beyond level or less than 25% of body beyond level.",
        mixed_straddling_level: "All other accepted one-close breakouts."
      },
      abnormalMarketDiagnostics: "Descriptive only; no production threshold or decision is changed.",
      feesIncluded: false,
      spreadIncluded: false,
      slippageIncluded: false
    },
    sources: sourceFiles,
    sample: {
      total: records.length,
      symbols: [...new Set(records.map((record) => record.symbol))].sort(),
      timeframes: [...new Set(records.map((record) => record.timeframe))].sort(),
      dateRange: { from: records[0].timestamp, to: records.at(-1).timestamp },
      periods: periodSummary,
      combined: summarizeOutcomes(records)
    },
    dataQuality: {
      duplicateSignalsRemoved: inputs.reduce((sum, input) => sum + (input.replay.policies?.baseline?.records || []).filter((record) => normalizeStrategy(record.strategy) === "momentum breakout").length, 0) - records.length,
      outcomeReconstructionMismatches: outcomeMismatches.map((record) => record.setupKey),
      atrParityMismatches: atrMismatches.map((record) => ({ setupKey: record.setupKey, ...record.atrParity })),
      exactIntracandleMfeMaeAvailable: false,
      mfeMaeNote: "MFE/MAE before the terminal candle is exact from OHLC bars. Through-terminal values are bounds because intrabar ordering is unavailable."
    },
    winnerLoserComparison: comparison,
    acceptanceComparison: buildCategoricalOutcomeComparison(records, "breakoutAcceptance"),
    featureRanking,
    bucketAnalysis: Object.fromEntries(Object.entries(BUCKET_DEFINITIONS).map(([feature, boundaries]) => [feature, buildBucketAnalysis(records, feature, boundaries)])),
    crossPeriod: Object.fromEntries(topFeatures.map((feature) => [feature, buildCrossPeriodComparison(records, feature)])),
    counterfactuals: COUNTERFACTUALS.map((definition) => buildCounterfactualRange(records, definition)),
    combinations: buildCombinationAnalysis(records),
    diagnosticFailureCategories: buildFailureCategories(records),
    prospectiveShadow: {
      feasibleWithoutSchemaMigration: true,
      preferredLocation: "generated signal full_analysis.indicators.momentumEntryDiagnostics",
      fields: ["breakoutDistanceAtr", "ema20DistanceAtr", "latestCandleRangeAtr", "previous3BarMoveAtr", "volumeRatio20", "marketQuality", "stopDistanceAtr", "stopBeyondBreakoutCandleAtr"],
      productionChangeImplemented: false,
      behaviorDependencyAllowed: false
    },
    conclusions: buildConclusions(records, featureRanking),
    records
  };
}

export function analyzeMomentumRecord(record, observation, manifest) {
  const signal = observation.signal;
  const timestampMs = parseTimestamp(record.replayTimestamp || observation.replayTimestamp);
  const timeframe = String(record.timeframe || observation.timeframe || signal.timeframe);
  const direction = String(record.direction || signal.direction).toLowerCase();
  const candles = normalizeCandles(manifest.candles?.[timeframe], timeframe);
  const entryIndex = candles.findIndex((candle) => candle.time * 1000 === timestampMs);
  if (entryIndex < 0) throw new Error(`${record.setupKey}: trigger candle is absent from ${timeframe} manifest data.`);
  const requestStartMs = timestampMs - REQUEST_GRANULARITY_SECONDS[timeframe] * CANDLE_LIMIT * 1000;
  const productionWindow = candles.filter((candle) => candle.time * 1000 >= requestStartMs && candle.time * 1000 <= timestampMs);
  if (productionWindow.length < 60) throw new Error(`${record.setupKey}: fewer than 60 setup-time candles are available.`);
  const indicators = calculateIndicators(productionWindow);
  const storedAtr = Number(signal.atr);
  const atr = Number.isFinite(storedAtr) && storedAtr > 0 ? storedAtr : indicators.atr14;
  const latest = productionWindow.at(-1);
  const priorWindow = productionWindow.slice(-24, -3);
  if (priorWindow.length !== 21) throw new Error(`${record.setupKey}: production breakout reference window is incomplete.`);
  const breakoutLevel = direction === "long"
    ? Math.max(...priorWindow.map((candle) => candle.high))
    : Math.min(...priorWindow.map((candle) => candle.low));
  const levels = detectProductionStructure(productionWindow, latest.close);
  const features = calculateSetupFeatures({
    signal: {
      ...signal,
      entryPrice: Number(record.entryPrice ?? signal.entry),
      stopLoss: Number(record.stopLoss ?? signal.stopLoss),
      takeProfit: Number(record.takeProfit ?? signal.takeProfit),
      riskRewardRatio: Number(record.riskRewardRatio ?? signal.riskRewardRatio),
      direction
    },
    candles: productionWindow,
    indicators: { ...indicators, atr14: atr },
    breakoutLevel,
    levels
  });
  const path = evaluateOutcomePath({
    signal: {
      timeframe,
      direction,
      entryPrice: Number(record.entryPrice ?? signal.entry),
      stopLoss: Number(record.stopLoss ?? signal.stopLoss),
      takeProfit: Number(record.takeProfit ?? signal.takeProfit),
      riskRewardRatio: Number(record.riskRewardRatio ?? signal.riskRewardRatio),
      validUntil: signal.validUntil
    },
    candles: candles.slice(entryIndex + 1),
    entryTimestampMs: timestampMs,
    atr
  });
  const period = periodForTimestamp(timestampMs);
  const outcomeReplay = normalizeOutcome(record.outcome);
  const diagnostics = classifyStoppedTrade({ ...features, ...path, outcomeReplay });
  return {
    setupKey: record.setupKey,
    symbol: String(record.symbol || manifest.symbol),
    timeframe,
    direction,
    strategy: record.strategy,
    confidence: Number(observation.signal.confidence),
    timestamp: new Date(timestampMs).toISOString(),
    period,
    entryPrice: Number(record.entryPrice),
    stopLoss: Number(record.stopLoss),
    takeProfit: Number(record.takeProfit),
    riskRewardRatio: Number(record.riskRewardRatio),
    atr,
    ema20: indicators.ema20,
    ema50: indicators.ema50,
    rsi14: indicators.rsi14,
    volume: latest.volume,
    volumeMa20: indicators.volumeMa20,
    breakoutLevel,
    ...features,
    outcomeReplay,
    realizedR: Number(record.realizedR),
    ...path,
    outcomeDiagnostic: diagnostics,
    atrParity: {
      stored: storedAtr,
      reconstructed: indicators.atr14,
      absoluteDifference: round(Math.abs(storedAtr - indicators.atr14), 8),
      relativeDifference: round(Math.abs(storedAtr - indicators.atr14) / Math.max(Math.abs(storedAtr), EPSILON), 8)
    }
  };
}

export function calculateSetupFeatures({ signal, candles, indicators, breakoutLevel, levels = null }) {
  if (!Array.isArray(candles) || candles.length < 60) throw new Error("Setup diagnostics require at least 60 candles.");
  const latest = candles.at(-1);
  const direction = String(signal.direction).toLowerCase();
  const entry = finite(signal.entryPrice, "entryPrice");
  const stop = finite(signal.stopLoss, "stopLoss");
  const target = finite(signal.takeProfit, "takeProfit");
  const atr = finite(indicators.atr14, "atr14");
  if (atr <= 0 || !["long", "short"].includes(direction)) throw new Error("Valid ATR and direction are required.");
  const directional = (value) => direction === "long" ? value : -value;
  const range = Math.max(latest.high - latest.low, EPSILON);
  const body = Math.abs(latest.close - latest.open);
  const closeBeyond = directional(latest.close - breakoutLevel);
  const bodyLow = Math.min(latest.open, latest.close);
  const bodyHigh = Math.max(latest.open, latest.close);
  const bodyBeyond = direction === "long"
    ? Math.max(0, bodyHigh - Math.max(bodyLow, breakoutLevel))
    : Math.max(0, Math.min(bodyHigh, breakoutLevel) - bodyLow);
  const rangeBeyond = direction === "long"
    ? Math.max(0, latest.high - Math.max(latest.low, breakoutLevel))
    : Math.max(0, Math.min(latest.high, breakoutLevel) - latest.low);
  const bodyBeyondFraction = body > EPSILON ? bodyBeyond / body : 0;
  const rangeBeyondFraction = rangeBeyond / range;
  const closeLocation = direction === "long" ? (latest.close - latest.low) / range : (latest.high - latest.close) / range;
  const preEntry = candles.slice(0, -1);
  const qualityWindow = preEntry.slice(-40);
  const marketQuality = calculateMarketQuality(qualityWindow);
  const expansion = calculateExpansionFeatures(candles, direction, atr);
  const volumeWindow = candles.slice(-20).map((candle) => candle.volume);
  const preVolumeWindow = preEntry.slice(-20).map((candle) => candle.volume);
  const olderVolumeWindow = preEntry.slice(-80, -20).map((candle) => candle.volume);
  const volumeMa20 = finite(indicators.volumeMa20, "volumeMa20");
  const nearestSwing = direction === "long" ? levels?.nearestSwingLow : levels?.nearestSwingHigh;
  const opposing = direction === "long" ? levels?.nearestResistance : levels?.nearestSupport;
  const stopBeyondLevel = direction === "long" ? breakoutLevel - stop : stop - breakoutLevel;
  const stopBeyondCandle = direction === "long" ? latest.low - stop : stop - latest.high;
  const stopBeyondSwing = nearestSwing
    ? (direction === "long" ? nearestSwing.price - stop : stop - nearestSwing.price)
    : null;
  const totalStructureRoom = opposing
    ? directional(opposing.price - breakoutLevel)
    : null;
  const consumedRoom = directional(entry - breakoutLevel);
  const acceptance = closeBeyond / atr <= 0.1 || bodyBeyondFraction < 0.25
    ? "barely_closed_beyond"
    : bodyBeyondFraction >= 0.75 && closeLocation >= 0.7
      ? "clean_body_acceptance"
      : "mixed_straddling_level";

  return {
    breakoutDistanceAtr: round(Math.abs(entry - breakoutLevel) / atr),
    ema20DistanceAtr: round(Math.abs(entry - indicators.ema20) / atr),
    ema50DistanceAtr: round(Math.abs(entry - indicators.ema50) / atr),
    latestCandleRangeAtr: round(range / atr),
    latestBodyAtr: round(body / atr),
    bodyToRangeRatio: round(body / range),
    closeLocation: round(closeLocation),
    closeBeyondLevelAtr: round(closeBeyond / atr),
    closeBeyondLevelPercent: round((closeBeyond / Math.max(Math.abs(breakoutLevel), EPSILON)) * 100),
    bodyBeyondLevelFraction: round(bodyBeyondFraction),
    rangeBeyondLevelFraction: round(rangeBeyondFraction),
    breakoutCandleOpenBeyondLevel: direction === "long" ? latest.open > breakoutLevel : latest.open < breakoutLevel,
    breakoutCandleExtremeReentersPriorRange: direction === "long" ? latest.low < breakoutLevel : latest.high > breakoutLevel,
    breakoutAcceptance: acceptance,
    ...expansion,
    volumeRatio20: round(latest.volume / Math.max(volumeMa20, EPSILON)),
    absoluteCurrentVolume: latest.volume,
    medianVolume20: median(volumeWindow),
    preEntryMedianVolume20: median(preVolumeWindow),
    volumeCoefficientOfVariation20: coefficientOfVariation(volumeWindow),
    volumeBaselineToOlderMedian: olderVolumeWindow.length ? round(median(preVolumeWindow) / Math.max(median(olderVolumeWindow), EPSILON)) : null,
    extremelySmallVolumeBaseline: olderVolumeWindow.length ? median(preVolumeWindow) <= median(olderVolumeWindow) * 0.1 : false,
    ...marketQuality,
    stopDistanceAtr: round(Math.abs(entry - stop) / atr),
    stopBeyondBreakoutLevelAtr: round(stopBeyondLevel / atr),
    stopBeyondBreakoutCandleAtr: round(stopBeyondCandle / atr),
    stopDistanceToEma20Atr: round(Math.abs(stop - indicators.ema20) / atr),
    stopDistanceToNearestSwingAtr: nearestSwing ? round(Math.abs(stop - nearestSwing.price) / atr) : null,
    stopBeyondNearestSwingAtr: nearestSwing ? round(stopBeyondSwing / atr) : null,
    stopInsideBreakoutCandleRange: stop >= latest.low && stop <= latest.high,
    stopInsidePriorLevelRegion: Math.abs(stop - breakoutLevel) <= atr * 0.25,
    stopBeyondBreakoutBase: stopBeyondLevel > 0,
    stopBeyondRecentStructuralSwing: stopBeyondSwing == null ? null : stopBeyondSwing > 0,
    nearestStructuralSwing: nearestSwing?.price ?? null,
    nearestOpposingStructure: opposing?.price ?? null,
    opposingStructureDistanceAtr: opposing ? round(directional(opposing.price - entry) / atr) : null,
    structuralRoomConsumedFraction: totalStructureRoom > 0 ? round(consumedRoom / totalStructureRoom) : null,
    targetDistanceAtr: round(Math.abs(target - entry) / atr),
    reconstructedRiskReward: round(Math.abs(target - entry) / Math.max(Math.abs(entry - stop), EPSILON))
  };
}

export function calculateExpansionFeatures(candles, direction, atr) {
  const latestIndex = candles.length - 1;
  const oriented = (value) => direction === "long" ? value : -value;
  const move = (bars) => {
    const start = candles[latestIndex - bars];
    return start ? round(oriented(candles[latestIndex].close - start.close) / atr) : null;
  };
  const count = (limit) => {
    let total = 0;
    for (let index = latestIndex; index > 0 && total < limit; index -= 1) {
      const candle = candles[index];
      const range = Math.max(candle.high - candle.low, EPSILON);
      const directionalBody = oriented(candle.close - candle.open) > 0;
      const directionalClose = oriented(candle.close - candles[index - 1].close) > 0;
      if (!directionalBody || !directionalClose || Math.abs(candle.close - candle.open) / range < 0.5) break;
      total += 1;
    }
    return total;
  };
  return {
    previous1BarMoveAtr: move(1),
    previous2BarMoveAtr: move(2),
    previous3BarMoveAtr: move(3),
    previous5BarMoveAtr: move(5),
    directionalExpansionCount3: Math.min(3, count(3)),
    directionalExpansionCount5: Math.min(5, count(5))
  };
}

export function calculateMarketQuality(candles) {
  if (!Array.isArray(candles) || !candles.length) throw new Error("Market-quality diagnostics require candles.");
  const ranges = candles.map((candle) => Math.max(0, candle.high - candle.low));
  const volumes = candles.map((candle) => Math.max(0, candle.volume));
  const medianRange = median(ranges);
  const medianVolume = median(volumes);
  const nearZeroCutoff = Math.max(medianRange * 0.05, median(candles.map((candle) => candle.close)) * 1e-8);
  const maxRange = Math.max(...ranges);
  const maxVolume = Math.max(...volumes);
  return {
    marketQualityWindow: candles.length,
    zeroOrNearZeroRangeFraction: round(ranges.filter((value) => value <= nearZeroCutoff).length / candles.length),
    medianCandleRange: medianRange,
    maxRangeToMedianRange: round(maxRange / Math.max(medianRange, EPSILON)),
    maxVolumeToMedianVolume: round(maxVolume / Math.max(medianVolume, EPSILON)),
    rangeCoefficientOfVariation: coefficientOfVariation(ranges),
    volumeCoefficientOfVariation: coefficientOfVariation(volumes),
    severeIsolatedRangeSpikes: ranges.filter((value) => value > medianRange * 5).length,
    severeIsolatedVolumeSpikes: volumes.filter((value) => value > medianVolume * 8).length,
    oneCandleDominatesRange: maxRange / Math.max(sum(ranges), EPSILON) >= 0.35,
    oneCandleDominatesVolume: maxVolume / Math.max(sum(volumes), EPSILON) >= 0.5
  };
}

export function evaluateOutcomePath({ signal, candles, entryTimestampMs, atr }) {
  const intervalMs = CANDLE_INTERVAL_SECONDS[signal.timeframe] * 1000;
  const validityMs = Number.isFinite(new Date(signal.validUntil).getTime())
    ? new Date(signal.validUntil).getTime()
    : entryTimestampMs + MAXIMUM_HOLDING_BARS * intervalMs;
  const forward = candles
    .filter((candle) => candle.time * 1000 > entryTimestampMs && candle.time * 1000 <= validityMs)
    .slice(0, MAXIMUM_HOLDING_BARS);
  const risk = Math.abs(signal.entryPrice - signal.stopLoss);
  let terminalIndex = -1;
  let outcome = "Expired";
  let sameCandleAmbiguity = false;
  for (let index = 0; index < forward.length; index += 1) {
    const candle = forward[index];
    const hitStop = signal.direction === "long" ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
    const hitTarget = signal.direction === "long" ? candle.high >= signal.takeProfit : candle.low <= signal.takeProfit;
    if (!hitStop && !hitTarget) continue;
    terminalIndex = index;
    sameCandleAmbiguity = hitStop && hitTarget;
    outcome = hitStop ? "Hit SL" : "Hit TP";
    break;
  }
  const beforeTerminal = terminalIndex >= 0 ? forward.slice(0, terminalIndex) : forward;
  const throughTerminal = terminalIndex >= 0 ? forward.slice(0, terminalIndex + 1) : forward;
  const excursions = calculateExcursions(beforeTerminal, signal, atr, risk);
  const upperBounds = calculateExcursions(throughTerminal, signal, atr, risk);
  let laterTpIndex = -1;
  if (outcome === "Hit SL") {
    for (let index = terminalIndex + 1; index < forward.length; index += 1) {
      const hit = signal.direction === "long" ? forward[index].high >= signal.takeProfit : forward[index].low <= signal.takeProfit;
      if (hit) { laterTpIndex = index; break; }
    }
  }
  return {
    outcomeReconstructed: outcome,
    sameCandleAmbiguity,
    candlesToTerminal: terminalIndex >= 0 ? terminalIndex + 1 : forward.length,
    mfePriceBeforeTerminalCandle: excursions.mfePrice,
    maePriceBeforeTerminalCandle: excursions.maePrice,
    mfeAtrBeforeTerminalCandle: excursions.mfeAtr,
    maeAtrBeforeTerminalCandle: excursions.maeAtr,
    mfeRBeforeTerminalCandle: excursions.mfeR,
    maeRBeforeTerminalCandle: excursions.maeR,
    mfeRThroughTerminalCandleUpperBound: upperBounds.mfeR,
    maeRThroughTerminalCandleUpperBound: upperBounds.maeR,
    tpReachedLaterAfterSl: laterTpIndex >= 0,
    candlesFromSlToLaterTp: laterTpIndex >= 0 ? laterTpIndex - terminalIndex : null
  };
}

export function buildBucketAnalysis(records, feature, boundaries) {
  const buckets = boundaries.map((upper, index) => ({ lower: index ? boundaries[index - 1] : Number.NEGATIVE_INFINITY, upper }))
    .concat([{ lower: boundaries.at(-1), upper: Number.POSITIVE_INFINITY }]);
  return buckets.map((bucket) => {
    const values = records.filter((record) => {
      const value = Number(record[feature]);
      return Number.isFinite(value) && value > bucket.lower && value <= bucket.upper;
    });
    return {
      label: bucketLabel(bucket.lower, bucket.upper),
      ...summarizeOutcomes(values)
    };
  });
}

export function buildCounterfactualRange(records, definition) {
  return {
    feature: definition.feature,
    operator: definition.operator,
    thresholds: definition.thresholds.map((threshold) => {
      const retained = records.filter((record) => compare(Number(record[definition.feature]), definition.operator, threshold));
      const removed = records.filter((record) => !retained.includes(record));
      return {
        threshold,
        retained: summarizeOutcomes(retained),
        removed: summarizeOutcomes(removed),
        supplyRetainedPercent: round((retained.length / Math.max(records.length, 1)) * 100),
        periods: Object.fromEntries(PERIOD_ORDER.map((period) => [period, summarizeOutcomes(retained.filter((record) => record.period === period))]))
      };
    })
  };
}

export function summarizeOutcomes(records) {
  const tp = records.filter((record) => normalizeOutcome(record.outcomeReplay) === "Hit TP").length;
  const sl = records.filter((record) => normalizeOutcome(record.outcomeReplay) === "Hit SL").length;
  const expired = records.filter((record) => normalizeOutcome(record.outcomeReplay) === "Expired").length;
  const netR = sum(records.map((record) => Number(record.realizedR)).filter(Number.isFinite));
  return {
    signals: records.length,
    tp,
    sl,
    expired,
    winRate: tp + sl ? round((tp / (tp + sl)) * 100) : null,
    netR: round(netR),
    expectancyR: records.length ? round(netR / records.length) : null
  };
}

export async function writeMomentumAnalysisOutputs(report, dataFolder) {
  const absoluteFolder = resolve(dataFolder);
  await mkdir(absoluteFolder, { recursive: true });
  const jsonPath = join(absoluteFolder, "momentum-breakout-entry-quality-analysis.json");
  const csvPath = join(absoluteFolder, "momentum-breakout-entry-quality-signals.csv");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(csvPath, toCsv(report.records), "utf8");
  return { jsonPath, csvPath };
}

function calculateIndicators(candles) {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  return {
    ema20: latestValue(ema(closes, 20)),
    ema50: latestValue(ema(closes, 50)),
    rsi14: latestValue(rsi(closes, 14)),
    atr14: latestValue(sma(trueRanges(candles), 14)),
    volumeMa20: latestValue(sma(volumes, 20))
  };
}

function detectProductionStructure(candles, latestClose) {
  const recent = candles.slice(-80);
  const swingHighs = [];
  const swingLows = [];
  for (let index = 2; index < recent.length - 2; index += 1) {
    const candle = recent[index];
    const before = recent.slice(index - 2, index);
    const after = recent.slice(index + 1, index + 3);
    if (before.every((item) => candle.high > item.high) && after.every((item) => candle.high > item.high)) swingHighs.push({ price: candle.high, time: candle.time });
    if (before.every((item) => candle.low < item.low) && after.every((item) => candle.low < item.low)) swingLows.push({ price: candle.low, time: candle.time });
  }
  const smc = analyzeSmartMoneyConcepts(candles);
  const bullishBlocks = smc.orderBlocks.active.filter((block) => block.upper < latestClose).map((block) => ({ price: block.upper, time: block.time, source: "Bullish order block" }));
  const bearishBlocks = smc.orderBlocks.active.filter((block) => block.lower > latestClose).map((block) => ({ price: block.lower, time: block.time, source: "Bearish order block" }));
  const supports = [...swingLows, ...bullishBlocks].filter((level) => level.price < latestClose);
  const resistances = [...swingHighs, ...bearishBlocks].filter((level) => level.price > latestClose);
  return {
    nearestSupport: nearestLevel(supports, latestClose),
    nearestResistance: nearestLevel(resistances, latestClose),
    nearestSwingLow: nearestLevel(swingLows.filter((level) => level.price < latestClose), latestClose),
    nearestSwingHigh: nearestLevel(swingHighs.filter((level) => level.price > latestClose), latestClose)
  };
}

function calculateExcursions(candles, signal, atr, risk) {
  if (!candles.length) return { mfePrice: 0, maePrice: 0, mfeAtr: 0, maeAtr: 0, mfeR: 0, maeR: 0 };
  const favorable = signal.direction === "long"
    ? Math.max(0, ...candles.map((candle) => candle.high - signal.entryPrice))
    : Math.max(0, ...candles.map((candle) => signal.entryPrice - candle.low));
  const adverse = signal.direction === "long"
    ? Math.max(0, ...candles.map((candle) => signal.entryPrice - candle.low))
    : Math.max(0, ...candles.map((candle) => candle.high - signal.entryPrice));
  return {
    mfePrice: round(favorable),
    maePrice: round(adverse),
    mfeAtr: round(favorable / Math.max(atr, EPSILON)),
    maeAtr: round(adverse / Math.max(atr, EPSILON)),
    mfeR: round(favorable / Math.max(risk, EPSILON)),
    maeR: round(adverse / Math.max(risk, EPSILON))
  };
}

function buildWinnerLoserComparison(records) {
  return Object.fromEntries([...COMPARISON_FEATURES, ...OUTCOME_COMPARISON_FEATURES].map((feature) => {
    const tp = records.filter((record) => record.outcomeReplay === "Hit TP").map((record) => Number(record[feature])).filter(Number.isFinite);
    const sl = records.filter((record) => record.outcomeReplay === "Hit SL").map((record) => Number(record[feature])).filter(Number.isFinite);
    return [feature, {
      tp: describe(tp),
      sl: describe(sl),
      medianDifferenceSlMinusTp: tp.length && sl.length ? round(median(sl) - median(tp)) : null,
      meanDifferenceSlMinusTp: tp.length && sl.length ? round(average(sl) - average(tp)) : null
    }];
  }));
}

function rankFeatures(comparison, features) {
  return features.map((feature) => [feature, comparison[feature]]).map(([feature, value]) => {
    const combinedIqr = interquartileRange([...value.tp.values, ...value.sl.values]);
    const separation = value.medianDifferenceSlMinusTp == null ? 0 : Math.abs(value.medianDifferenceSlMinusTp) / Math.max(combinedIqr, EPSILON);
    return {
      feature,
      direction: value.medianDifferenceSlMinusTp > 0 ? "higher_in_sl" : value.medianDifferenceSlMinusTp < 0 ? "lower_in_sl" : "no_median_difference",
      medianDifferenceSlMinusTp: value.medianDifferenceSlMinusTp,
      normalizedMedianSeparation: round(separation),
      tpSample: value.tp.count,
      slSample: value.sl.count
    };
  }).sort((left, right) => right.normalizedMedianSeparation - left.normalizedMedianSeparation || left.feature.localeCompare(right.feature));
}

function buildCategoricalOutcomeComparison(records, feature) {
  return Object.fromEntries([...new Set(records.map((record) => String(record[feature] || "unknown")))].sort().map((value) => [value, summarizeOutcomes(records.filter((record) => String(record[feature] || "unknown") === value))]));
}

function buildCrossPeriodComparison(records, feature) {
  return Object.fromEntries(PERIOD_ORDER.map((period) => {
    const periodRecords = records.filter((record) => record.period === period);
    const tp = periodRecords.filter((record) => record.outcomeReplay === "Hit TP").map((record) => record[feature]).filter(Number.isFinite);
    const sl = periodRecords.filter((record) => record.outcomeReplay === "Hit SL").map((record) => record[feature]).filter(Number.isFinite);
    return [period, {
      tp: describe(tp, false),
      sl: describe(sl, false),
      medianDifferenceSlMinusTp: tp.length && sl.length ? round(median(sl) - median(tp)) : null,
      reliability: reliabilityLabel(tp.length + sl.length)
    }];
  }));
}

function buildCombinationAnalysis(records) {
  const definitions = [
    { key: "not_overextended", description: "breakout <= 0.75 ATR, EMA20 <= 1.5 ATR, and 3-bar move <= 2 ATR", keep: (record) => record.breakoutDistanceAtr <= 0.75 && record.ema20DistanceAtr <= 1.5 && record.previous3BarMoveAtr <= 2 },
    { key: "reasonable_market_quality", description: "max/median range <= 6, near-zero range <= 25%, and range CV <= 1.5", keep: (record) => record.maxRangeToMedianRange <= 6 && record.zeroOrNearZeroRangeFraction <= 0.25 && record.rangeCoefficientOfVariation <= 1.5 },
    { key: "not_overextended_and_reasonable_market_quality", description: "The two illustrative diagnostics combined", keep: (record) => record.breakoutDistanceAtr <= 0.75 && record.ema20DistanceAtr <= 1.5 && record.previous3BarMoveAtr <= 2 && record.maxRangeToMedianRange <= 6 && record.zeroOrNearZeroRangeFraction <= 0.25 && record.rangeCoefficientOfVariation <= 1.5 }
  ];
  return definitions.map((definition) => {
    const retained = records.filter(definition.keep);
    return {
      key: definition.key,
      description: definition.description,
      status: "illustrative_shadow_counterfactual_only",
      retained: summarizeOutcomes(retained),
      removed: summarizeOutcomes(records.filter((record) => !definition.keep(record))),
      periods: Object.fromEntries(PERIOD_ORDER.map((period) => [period, summarizeOutcomes(retained.filter((record) => record.period === period))]))
    };
  });
}

function buildFailureCategories(records) {
  const stopped = records.filter((record) => record.outcomeReplay === "Hit SL");
  const groups = new Map();
  for (const record of stopped) {
    if (!groups.has(record.outcomeDiagnostic.category)) groups.set(record.outcomeDiagnostic.category, []);
    groups.get(record.outcomeDiagnostic.category).push(record);
  }
  return Object.fromEntries([...groups.entries()].map(([category, values]) => [category, {
    signals: values.length,
    setupKeys: values.map((record) => record.setupKey),
    reasons: countValues(values.flatMap((record) => record.outcomeDiagnostic.reasons))
  }]));
}

function classifyStoppedTrade(record) {
  if (record.outcomeReplay !== "Hit SL") return { category: "NOT_APPLICABLE", reasons: [] };
  const chased = record.breakoutDistanceAtr >= 1 || record.ema20DistanceAtr >= 2 || record.previous3BarMoveAtr >= 2.5 || record.latestCandleRangeAtr >= 1.5;
  const fragile = record.stopDistanceAtr < 1.5 || record.stopInsideBreakoutCandleRange || !record.stopBeyondBreakoutBase || record.tpReachedLaterAfterSl;
  const abnormal = record.zeroOrNearZeroRangeFraction >= 0.3 || record.maxRangeToMedianRange >= 6 || record.rangeCoefficientOfVariation >= 1.5 || record.oneCandleDominatesRange || record.oneCandleDominatesVolume;
  const reasons = [];
  if (chased) reasons.push("entry_extension_or_expansion");
  if (fragile) reasons.push("fragile_stop_relation");
  if (abnormal) reasons.push("abnormal_market_quality");
  if (!reasons.length && record.mfeRBeforeTerminalCandle < 0.5 && !record.tpReachedLaterAfterSl) reasons.push("low_favorable_excursion");
  return {
    category: reasons.length > 1 ? "MIXED" : reasons[0] === "entry_extension_or_expansion" ? "LIKELY_CHASED_ENTRY" : reasons[0] === "fragile_stop_relation" ? "LIKELY_FRAGILE_STOP" : reasons[0] === "abnormal_market_quality" ? "LIKELY_ABNORMAL_MARKET" : "LIKELY_DIRECTIONAL_FAILURE",
    reasons,
    status: "diagnostic_only"
  };
}

function buildConclusions(records, ranking) {
  const top = ranking[0] || null;
  const second = ranking[1] || null;
  const chasedSl = records.filter((record) => record.outcomeReplay === "Hit SL" && record.outcomeDiagnostic.reasons.includes("entry_extension_or_expansion")).length;
  const abnormalSl = records.filter((record) => record.outcomeReplay === "Hit SL" && record.outcomeDiagnostic.reasons.includes("abnormal_market_quality")).length;
  const fragileSl = records.filter((record) => record.outcomeReplay === "Hit SL" && record.outcomeDiagnostic.reasons.includes("fragile_stop_relation")).length;
  const totalSl = records.filter((record) => record.outcomeReplay === "Hit SL").length;
  return {
    strongestObservedDiscriminator: top,
    secondStrongestObservedDiscriminator: second,
    entryChasingHypothesis: { diagnosticSlCount: chasedSl, totalSl, supported: chasedSl > totalSl / 2, caveat: "Descriptive thresholds and a small historical sample; not a production rule." },
    abnormalThinMarketHypothesis: { diagnosticSlCount: abnormalSl, totalSl, supported: abnormalSl > totalSl / 2, caveat: "BTC/ETH/SOL replay data cannot represent the thinnest production markets." },
    fragileStopHypothesis: { diagnosticSlCount: fragileSl, totalSl, supported: fragileSl > totalSl / 2, caveat: "OHLC data cannot establish intrabar ordering and later TP does not invalidate canonical SL." },
    bestProspectiveShadowCandidate: top ? `${top.feature} recorded as a non-blocking generated-signal diagnostic` : null,
    productionRuleSupported: false,
    productionRuleReason: "No rule is supported until an individual relationship is directionally stable across periods and confirmed prospectively on a broader symbol set.",
    moreForwardDataNecessary: true
  };
}

function validateInputPair(replay, manifest, resultName = "replay", manifestName = "manifest") {
  if (!replay?.policies?.baseline?.records || !Array.isArray(replay.policies.baseline.records)) throw new Error(`${resultName}: baseline replay records are missing.`);
  if (!Array.isArray(replay.observations)) throw new Error(`${resultName}: replay observations are missing.`);
  if (!manifest?.symbol || !manifest?.candles || !manifest?.source) throw new Error(`${manifestName}: malformed historical manifest.`);
  const replaySymbols = new Set(replay.policies.baseline.records.map((record) => String(record.symbol || "").toUpperCase()).filter(Boolean));
  if (replaySymbols.size && !replaySymbols.has(String(manifest.symbol).toUpperCase())) throw new Error(`${resultName} does not match ${manifestName}.`);
}

function normalizeCandles(raw, timeframe) {
  if (!Array.isArray(raw) || !raw.length) throw new Error(`Missing ${timeframe} candles.`);
  const candles = raw.map((candle) => {
    const timestampMs = parseTimestamp(candle.timestamp ?? candle.time);
    const normalized = { time: timestampMs / 1000, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume) };
    if (![normalized.open, normalized.high, normalized.low, normalized.close, normalized.volume].every(Number.isFinite)) throw new Error(`Malformed ${timeframe} candle at ${timestampMs}.`);
    if (normalized.high < Math.max(normalized.open, normalized.close, normalized.low) || normalized.low > Math.min(normalized.open, normalized.close, normalized.high)) throw new Error(`Incoherent ${timeframe} OHLC candle at ${timestampMs}.`);
    return normalized;
  }).sort((left, right) => left.time - right.time);
  for (let index = 1; index < candles.length; index += 1) if (candles[index].time <= candles[index - 1].time) throw new Error(`${timeframe} candles must have unique increasing timestamps.`);
  return candles;
}

export function decodeText(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer || "");
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    for (let index = 0; index + 1 < swapped.length; index += 2) [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8");
}

function toCsv(records) {
  const columns = ["setupKey", "symbol", "period", "timestamp", "timeframe", "direction", "confidence", "entryPrice", "stopLoss", "takeProfit", "riskRewardRatio", "outcomeReplay", "realizedR", ...COMPARISON_FEATURES, "closeBeyondLevelAtr", "bodyBeyondLevelFraction", "rangeBeyondLevelFraction", "breakoutAcceptance", "stopInsideBreakoutCandleRange", "stopBeyondBreakoutBase", "stopBeyondRecentStructuralSwing", "tpReachedLaterAfterSl", "candlesFromSlToLaterTp", "mfeRBeforeTerminalCandle", "maeRBeforeTerminalCandle", "candlesToTerminal", "outcomeDiagnostic"];
  const rows = [columns.join(",")];
  for (const record of records) rows.push(columns.map((column) => csvValue(column === "outcomeDiagnostic" ? record.outcomeDiagnostic.category : record[column])).join(","));
  return `${rows.join("\n")}\n`;
}

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  const output = [];
  let previous = null;
  values.forEach((value, index) => {
    if (index < period - 1) { output.push(null); return; }
    previous = previous === null ? average(values.slice(0, period)) : (value - previous) * multiplier + previous;
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
  output.push(rsiValue(averageGain, averageLoss));
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    output.push(rsiValue(averageGain, averageLoss));
  }
  return output;
}

function rsiValue(gain, loss) { return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
function trueRanges(candles) { return candles.map((candle, index) => index === 0 ? candle.high - candle.low : Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index - 1].close), Math.abs(candle.low - candles[index - 1].close))); }
function sma(values, period) { return values.map((_, index) => index < period - 1 ? null : average(values.slice(index - period + 1, index + 1))); }
function latestValue(values) { return values.findLast((value) => value !== null && Number.isFinite(value)); }
function nearestLevel(levels, price) { return [...levels].sort((left, right) => Math.abs(left.price - price) - Math.abs(right.price - price))[0] || null; }
function normalizeStrategy(value) { return String(value || "").trim().toLowerCase(); }
function normalizeOutcome(value) { const text = String(value || "").toLowerCase(); return text.includes("tp") ? "Hit TP" : text.includes("sl") ? "Hit SL" : "Expired"; }
function periodForTimestamp(timestampMs) { const year = new Date(timestampMs).getUTCFullYear(); return year === 2026 ? "2026 YTD" : String(year); }
function parseTimestamp(value) { const numeric = Number(value); const timestamp = Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : new Date(value).getTime(); if (!Number.isFinite(timestamp)) throw new Error(`Invalid timestamp: ${value}`); return timestamp; }
function finite(value, field) { const number = Number(value); if (!Number.isFinite(number)) throw new Error(`${field} must be finite.`); return number; }
function compare(value, operator, threshold) { return Number.isFinite(value) && (operator === "<=" ? value <= threshold : value >= threshold); }
function bucketLabel(lower, upper) { if (!Number.isFinite(lower)) return `<=${upper}`; if (!Number.isFinite(upper)) return `>${lower}`; return `>${lower} to <=${upper}`; }
function reliabilityLabel(count) { return count < 5 ? "anecdotal" : count < 10 ? "very small" : count < 20 ? "small" : "more meaningful, historical only"; }
function countValues(values) { return values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] || 0) + 1 }), {}); }
function describe(values, includeValues = true) { const finiteValues = values.map(Number).filter(Number.isFinite); return { count: finiteValues.length, mean: average(finiteValues), median: median(finiteValues), minimum: finiteValues.length ? round(Math.min(...finiteValues)) : null, maximum: finiteValues.length ? round(Math.max(...finiteValues)) : null, ...(includeValues ? { values: finiteValues } : {}) }; }
function coefficientOfVariation(values) { const mean = average(values); if (!Number.isFinite(mean) || Math.abs(mean) <= EPSILON) return null; return round(Math.sqrt(average(values.map((value) => (value - mean) ** 2))) / Math.abs(mean)); }
function interquartileRange(values) { const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? percentile(sorted, 0.75) - percentile(sorted, 0.25) : 0; }
function percentile(sorted, value) { const index = (sorted.length - 1) * value; const lower = Math.floor(index); const fraction = index - lower; return sorted[lower + 1] == null ? sorted[lower] : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]); }
function median(values) { const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return null; const middle = Math.floor(sorted.length / 2); return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2); }
function average(values) { const finiteValues = values.map(Number).filter(Number.isFinite); return finiteValues.length ? finiteValues.reduce((total, value) => total + value, 0) / finiteValues.length : null; }
function sum(values) { return values.reduce((total, value) => total + Number(value || 0), 0); }
function round(value, digits = 6) { if (!Number.isFinite(Number(value))) return null; const factor = 10 ** digits; return Math.round(Number(value) * factor) / factor; }
function csvValue(value) { if (value == null) return ""; const text = typeof value === "object" ? JSON.stringify(value) : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }

async function runCli() {
  const folderIndex = process.argv.indexOf("--data-folder");
  const dataFolder = resolve(folderIndex >= 0 ? process.argv[folderIndex + 1] : "C:/Users/monge/Documents/SignalForgeData");
  const inputs = await loadMomentumReplayInputs(dataFolder);
  const report = analyzeMomentumInputs(inputs);
  const outputs = await writeMomentumAnalysisOutputs(report, dataFolder);
  console.log(JSON.stringify({
    sample: report.sample,
    dataQuality: report.dataQuality,
    strongestObservedDiscriminator: report.conclusions.strongestObservedDiscriminator,
    secondStrongestObservedDiscriminator: report.conclusions.secondStrongestObservedDiscriminator,
    hypotheses: {
      entryChasing: report.conclusions.entryChasingHypothesis,
      abnormalMarket: report.conclusions.abnormalThinMarketHypothesis,
      fragileStop: report.conclusions.fragileStopHypothesis
    },
    prospectiveShadow: report.prospectiveShadow,
    outputs
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(`[momentum-breakout-entry-quality] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
