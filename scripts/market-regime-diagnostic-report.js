import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { diagnoseMarketRegimeClassification } from "../src/modules/market-data/marketRegimeDiagnostics.js";

// analyzeMarketRegime's own minimum; a window shorter than this can't produce a real diagnosis.
const MINIMUM_CANDLES = 60;
const DEFAULT_WINDOW_SIZE = 90;
const DEFAULT_TARGET_SAMPLES = 150;
// Coinbase historical candles hard-caps a single request at 2400 candles (see
// getHistoricalCandlesFromCoinbase); stay under that with margin.
const SAFE_MAX_CANDLES_PER_REQUEST = 2300;
const CANDLES_PER_DAY = { "5m": 288, "15m": 96, "1h": 24, "4h": 6 };
// "A few months" scaled down for the noisier intraday timeframes so a single run doesn't need
// tens of thousands of 5m candles; override uniformly with --lookback-days if a longer history
// is wanted for every timeframe.
const DEFAULT_LOOKBACK_DAYS = { "5m": 14, "15m": 30, "1h": 90, "4h": 180 };
const BUCKET_NAMES = ["ema", "adx", "rsi", "structure"];

export function parseMarketRegimeDiagnosticArguments(argv) {
  const knownFlags = ["--output", "--lookback-days", "--window-size", "--target-samples", "--symbols", "--timeframes", "--no-reload"];
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!knownFlags.includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (argument === "--no-reload") {
      values.noReload = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  return {
    output: values.output ? resolve(values.output) : null,
    lookbackDays: values["lookback-days"] ? Number(values["lookback-days"]) : null,
    windowSize: values["window-size"] ? Number(values["window-size"]) : DEFAULT_WINDOW_SIZE,
    targetSamples: values["target-samples"] ? Number(values["target-samples"]) : DEFAULT_TARGET_SAMPLES,
    symbols: values.symbols ? values.symbols.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean) : null,
    timeframes: values.timeframes ? values.timeframes.split(",").map((timeframe) => timeframe.trim()).filter(Boolean) : null,
    noReload: Boolean(values.noReload)
  };
}

/**
 * Splits a completed candle series into overlapping evaluation windows, sampled at a stride
 * that targets roughly `targetSamples` evaluations per series instead of one per candle -- this
 * is what gives the aggregate report a real distribution across the lookback period rather than
 * a single end-of-history snapshot, without evaluating every single candle.
 */
export function slideDiagnosticWindows(candles, windowSize = DEFAULT_WINDOW_SIZE, targetSamples = DEFAULT_TARGET_SAMPLES) {
  if (!Array.isArray(candles) || candles.length < MINIMUM_CANDLES) return [];
  const effectiveWindow = Math.min(windowSize, candles.length);
  const maxStart = candles.length - effectiveWindow;
  const stride = Math.max(1, Math.floor(maxStart / Math.max(1, targetSamples - 1)));
  const windows = [];
  for (let start = 0; start <= maxStart; start += stride) {
    windows.push(candles.slice(start, start + effectiveWindow));
  }
  if (!windows.length) windows.push(candles.slice(-effectiveWindow));
  return windows;
}

function bucketsFor(subConditions, direction) {
  return direction === "up"
    ? { ema: subConditions.emaAlignedUp && subConditions.priceAboveEma20, adx: subConditions.adxPass, rsi: subConditions.rsiPassUp, structure: subConditions.structureUp }
    : { ema: subConditions.emaAlignedDown && subConditions.priceBelowEma20, adx: subConditions.adxPass, rsi: subConditions.rsiPassDown, structure: subConditions.structureDown };
}

/**
 * For a single Range diagnosis, picks whichever direction (up or down) came closest to
 * qualifying as a trend, then names the single condition that blocked it -- or
 * "multipleConditionsFailed" when more than one condition broke the chain.
 */
export function classifyRangeBlocker(diagnosis) {
  const up = bucketsFor(diagnosis.subConditions, "up");
  const down = bucketsFor(diagnosis.subConditions, "down");
  const failedUp = BUCKET_NAMES.filter((name) => !up[name]);
  const failedDown = BUCKET_NAMES.filter((name) => !down[name]);
  const chosen = failedUp.length <= failedDown.length
    ? { direction: "up", failed: failedUp }
    : { direction: "down", failed: failedDown };
  const blocker = chosen.failed.length === 1 ? `${chosen.failed[0]}OnlyBlocker` : "multipleConditionsFailed";
  return { direction: chosen.direction, blocker };
}

/**
 * For each of the four trend-up (and trend-down) conditions, isolates the "near miss" sample --
 * Range scans where the OTHER three conditions already held -- and reports how often that one
 * condition was the thing that still blocked a trend label. This is the direct test of "is
 * structure really the dominant bottleneck, or is it ADX/RSI/EMA": if structure's blockedRate is
 * far higher than the others', the structure check is doing most of the work of keeping the
 * classifier in Range.
 */
export function conditionNearMissAnalysis(rangeRecords, direction) {
  const result = {};
  for (const name of BUCKET_NAMES) {
    const others = BUCKET_NAMES.filter((candidate) => candidate !== name);
    const nearMiss = rangeRecords.filter((record) => {
      const buckets = bucketsFor(record.diagnosis.subConditions, direction);
      return others.every((other) => buckets[other]);
    });
    const blockedByThisCondition = nearMiss.filter((record) => !bucketsFor(record.diagnosis.subConditions, direction)[name]).length;
    result[name] = {
      nearMissSample: nearMiss.length,
      blockedByThisCondition,
      blockedRatePercent: nearMiss.length ? round((blockedByThisCondition / nearMiss.length) * 100) : null
    };
  }
  return result;
}

/**
 * Pure aggregation over already-computed diagnoses -- no network or DB access. Takes
 * records shaped as { symbol, timeframe, diagnosis } where diagnosis is the return value of
 * diagnoseMarketRegimeClassification, and produces the full report.
 */
export function buildMarketRegimeDiagnosticReport(records, { generatedAt = new Date(), skipped = [], methodology = {} } = {}) {
  const totalScans = records.length;
  const symbolsAnalyzed = new Set(records.map((record) => record.symbol)).size;

  const labelDistribution = { Range: 0, "Trend Up": 0, "Trend Down": 0, Breakout: 0, "High Volatility": 0, "Low Volatility": 0 };
  const unknownLabels = new Set();
  for (const record of records) {
    const label = record.diagnosis.finalLabel;
    if (Object.prototype.hasOwnProperty.call(labelDistribution, label)) {
      labelDistribution[label] += 1;
    } else {
      unknownLabels.add(label);
    }
  }
  const labelDistributionPercent = Object.fromEntries(
    Object.entries(labelDistribution).map(([label, count]) => [label, totalScans ? round((count / totalScans) * 100) : null])
  );

  const validRecords = records.filter((record) => !record.diagnosis.insufficientCandles);
  const insufficientCandleScans = totalScans - validRecords.length;
  const disagreements = validRecords.filter((record) => !record.diagnosis.agreesWithProduction);

  const rangeRecords = validRecords.filter((record) => record.diagnosis.finalLabel === "Range");

  const rangeBreakdown = { structureOnlyBlocker: 0, adxOnlyBlocker: 0, rsiOnlyBlocker: 0, emaOnlyBlocker: 0, multipleConditionsFailed: 0 };
  const rangeBreakdownByDirection = {
    up: { structureOnlyBlocker: 0, adxOnlyBlocker: 0, rsiOnlyBlocker: 0, emaOnlyBlocker: 0, multipleConditionsFailed: 0 },
    down: { structureOnlyBlocker: 0, adxOnlyBlocker: 0, rsiOnlyBlocker: 0, emaOnlyBlocker: 0, multipleConditionsFailed: 0 }
  };
  for (const record of rangeRecords) {
    const { direction, blocker } = classifyRangeBlocker(record.diagnosis);
    rangeBreakdown[blocker] += 1;
    rangeBreakdownByDirection[direction][blocker] += 1;
  }
  const rangeBreakdownPercent = Object.fromEntries(
    Object.entries(rangeBreakdown).map(([blocker, count]) => [blocker, rangeRecords.length ? round((count / rangeRecords.length) * 100) : null])
  );

  const structureIgnoredWouldQualify = {
    up: rangeRecords.filter((record) => record.diagnosis.trendUpConditionsMetCount === 4 && !record.diagnosis.subConditions.structureUp).length,
    down: rangeRecords.filter((record) => record.diagnosis.trendDownConditionsMetCount === 4 && !record.diagnosis.subConditions.structureDown).length
  };

  return {
    reportType: "market_regime_diagnostic",
    generatedAt: new Date(generatedAt).toISOString(),
    observationalOnly: true,
    productionDecisionInput: false,
    safety: {
      changesProductionCode: false,
      changesThresholds: false,
      reusesRealClassifier: "analyzeMarketRegime is called directly for finalLabel; diagnosticLabel is an independently recomputed cross-check, not a replacement"
    },
    symbolsAnalyzed,
    totalScans,
    insufficientCandleScans,
    labelDistribution,
    labelDistributionPercent,
    ...(unknownLabels.size ? { unknownLabelsEncountered: [...unknownLabels] } : {}),
    diagnosticVsProductionAgreement: {
      checkedScans: validRecords.length,
      agreeCount: validRecords.length - disagreements.length,
      disagreeCount: disagreements.length,
      disagreeSamples: disagreements.slice(0, 10).map((record) => ({
        symbol: record.symbol,
        timeframe: record.timeframe,
        finalLabel: record.diagnosis.finalLabel,
        diagnosticLabel: record.diagnosis.diagnosticLabel
      }))
    },
    rangeScansAnalyzed: rangeRecords.length,
    rangeBreakdown,
    rangeBreakdownPercent,
    rangeBreakdownByDirection,
    structureIgnoredWouldQualify,
    conditionNearMissAnalysis: {
      up: conditionNearMissAnalysis(rangeRecords, "up"),
      down: conditionNearMissAnalysis(rangeRecords, "down"),
      semantics: "For each condition, blockedRatePercent = among Range scans where the OTHER three trend conditions already held, the percent where this condition was the one still false. Higher = bigger bottleneck."
    },
    skippedSymbolTimeframePairs: skipped.length,
    skipped,
    methodology
  };
}

function bucketsCoveringSymbol(pair, appConfig, timeframeFilter) {
  return appConfig.supportedTimeframes.filter((timeframe) =>
    (pair.supportedTimeframes || []).includes(timeframe) && (!timeframeFilter || timeframeFilter.has(timeframe))
  );
}

async function defaultListSymbolUniverse(options) {
  const [{ listAutoScannerPairs }, { appConfig }] = await Promise.all([
    import("../src/modules/market-data/marketDataService.js"),
    import("../src/config/appConfig.js")
  ]);
  const pairs = listAutoScannerPairs().filter((pair) => pair.category === "Crypto");
  const symbolFilter = options.symbols ? new Set(options.symbols) : null;
  const timeframeFilter = options.timeframes ? new Set(options.timeframes) : null;
  const universe = [];
  for (const pair of pairs) {
    if (symbolFilter && !symbolFilter.has(pair.symbol)) continue;
    const timeframes = bucketsCoveringSymbol(pair, appConfig, timeframeFilter);
    if (timeframes.length) universe.push({ symbol: pair.symbol, timeframes });
  }
  return universe;
}

async function defaultReloadCryptoMarketSettings() {
  const { reloadCryptoMarketSettings } = await import("../src/modules/markets/cryptoMarketService.js");
  return reloadCryptoMarketSettings();
}

async function defaultLoadHistoricalCandles(symbol, timeframe, options) {
  const { getReadOnlySignalReviewMarketData } = await import("../src/modules/market-data/marketDataService.js");
  const lookbackDays = Number(options.lookbackDays) || DEFAULT_LOOKBACK_DAYS[timeframe] || 90;
  const candlesPerDay = CANDLES_PER_DAY[timeframe] || 24;
  const chunkDays = Math.max(1, Math.floor(SAFE_MAX_CANDLES_PER_REQUEST / candlesPerDay));
  const now = options.now ? new Date(options.now) : new Date();
  const start = new Date(now.getTime() - lookbackDays * 24 * 3600 * 1000);

  const merged = new Map();
  let cursor = start;
  while (cursor < now) {
    const chunkEnd = new Date(Math.min(now.getTime(), cursor.getTime() + chunkDays * 24 * 3600 * 1000));
    const marketData = await getReadOnlySignalReviewMarketData(symbol, timeframe, {
      from: cursor,
      to: chunkEnd,
      maxCandles: SAFE_MAX_CANDLES_PER_REQUEST
    });
    for (const candle of marketData.candles || []) merged.set(candle.time, candle);
    cursor = chunkEnd;
  }
  return [...merged.values()].sort((a, b) => a.time - b.time);
}

export async function runMarketRegimeDiagnosticReport(options = {}, dependencies = {}) {
  const listSymbolUniverse = dependencies.listSymbolUniverse || defaultListSymbolUniverse;
  const loadHistoricalCandles = dependencies.loadHistoricalCandles || defaultLoadHistoricalCandles;
  const reloadSettings = dependencies.reloadSettings || defaultReloadCryptoMarketSettings;

  if (!options.noReload) {
    try {
      await reloadSettings();
    } catch (error) {
      console.warn(`[market-regime-diagnostic] could not reload live crypto market settings from the database, continuing with defaults: ${error.message}`);
    }
  }

  const universe = await listSymbolUniverse(options);
  const pairsCovered = universe.reduce((sum, entry) => sum + entry.timeframes.length, 0);
  const records = [];
  const skipped = [];

  for (const { symbol, timeframes } of universe) {
    for (const timeframe of timeframes) {
      try {
        const candles = await loadHistoricalCandles(symbol, timeframe, options);
        const windows = slideDiagnosticWindows(candles, options.windowSize, options.targetSamples);
        for (const window of windows) {
          records.push({
            symbol,
            timeframe,
            windowEndTime: window.at(-1)?.time ?? null,
            diagnosis: diagnoseMarketRegimeClassification(window)
          });
        }
      } catch (error) {
        skipped.push({ symbol, timeframe, reason: error.message });
      }
    }
  }

  return buildMarketRegimeDiagnosticReport(records, {
    skipped,
    methodology: {
      symbolUniverseSource: "listAutoScannerPairs() filtered to category === 'Crypto', same universe runCandidateMarketWatch scans",
      timeframeSource: "appConfig.supportedTimeframes intersected with each market's verified supportedTimeframes",
      candleSource: "getReadOnlySignalReviewMarketData (read-only historical Coinbase candles, no cache/failure side effects)",
      windowSize: options.windowSize || DEFAULT_WINDOW_SIZE,
      targetSamplesPerSeries: options.targetSamples || DEFAULT_TARGET_SAMPLES,
      lookbackDaysByTimeframe: options.lookbackDays
        ? Object.fromEntries(Object.keys(DEFAULT_LOOKBACK_DAYS).map((timeframe) => [timeframe, options.lookbackDays]))
        : DEFAULT_LOOKBACK_DAYS,
      symbolTimeframePairsCovered: pairsCovered
    }
  });
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

async function main() {
  const options = parseMarketRegimeDiagnosticArguments(process.argv.slice(2));
  const report = await runMarketRegimeDiagnosticReport(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, output, "utf8");
    console.log(`Market regime diagnostic report written to ${options.output}`);
  } else {
    process.stdout.write(output);
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Market regime diagnostic report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
