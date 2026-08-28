import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateMarketDataSetup } from "../src/modules/signals/signalGenerator.js";
import { analyzeMarketRegime } from "../src/modules/market-data/marketRegimeService.js";
import { analyzeAdvancedMarketStructure } from "../src/modules/market-data/advancedMarketStructureService.js";
import { timeframeDurationSeconds } from "../src/modules/market-data/candleIntegrity.js";
import { candleOutcome } from "../src/modules/admin-signals/generatedSignalService.js";
import { getSignalValidityMs } from "../src/modules/signals/signalValidityService.js";

const strategyInventory = [
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
const dataFolder = resolve(argument("--data-folder") || "C:\\Users\\monge\\Documents\\SignalForgeData");
const audit = JSON.parse(await readFile(join(dataFolder, "cross-period-signal-stability-audit.json"), "utf8"));
const manifestCache = new Map();
const records = [];
const skipped = [];

assert.equal(new Set(strategyInventory).size, 10);

for (const stored of audit.signals || []) {
  const manifest = await loadManifest(stored);
  const setupTime = Number(String(stored.setupKey).split(":").at(-1));
  const candles = manifest.candles[stored.timeframe]?.filter((candle) => candle.time <= setupTime) || [];
  if (candles.length < 60 || candles.at(-1)?.time !== setupTime) {
    skipped.push({ signalIdentifier: stored.signalIdentifier, reason: "missing_base_warmup_or_setup_candle" });
    continue;
  }

  const generated = generateMarketDataSetup(
    buildMarketData(stored, manifest, candles, setupTime),
    stored.timeframe
  );
  if (!generated.valid || !strategyInventory.includes(generated.signal?.setupType)) {
    records.push({
      signalIdentifier: stored.signalIdentifier,
      stored,
      generated: null,
      outcomeComparable: false,
      comparisonReason: generated.valid ? "non_inventory_strategy" : "no_current_valid_signal"
    });
    continue;
  }

  const signal = generated.signal;
  const directionMatches = signal.direction === stored.direction;
  const levelsMatch = approximatelyEqual(signal.entryPrice, stored.entry) &&
    approximatelyEqual(signal.stopLoss, stored.stopLoss) &&
    approximatelyEqual(signal.takeProfit, stored.takeProfit);
  const replayedOutcome = replayOutcome(signal, manifest, setupTime, stored.timeframe);
  records.push({
    signalIdentifier: stored.signalIdentifier,
    stored,
    generated: {
      strategy: signal.setupType,
      direction: signal.direction,
      confidence: Number(signal.confidenceScore),
      entry: Number(signal.entryPrice),
      stopLoss: Number(signal.stopLoss),
      takeProfit: Number(signal.takeProfit),
      riskReward: Number(signal.riskRewardRatio),
      strategyEvidence: signal.strategyEvidence || null
    },
    replayedOutcome,
    outcomeComparable: directionMatches && levelsMatch,
    comparisonReason: directionMatches
      ? levelsMatch ? "same_direction_and_trade_levels" : "trade_levels_changed"
      : "direction_changed"
  });
}

const generatedRecords = records.filter((record) => record.generated);
const comparable = generatedRecords.filter((record) => record.outcomeComparable);
const nonComparable = generatedRecords.filter((record) => !record.outcomeComparable);
const outcomeEvaluated = generatedRecords.filter((record) => record.replayedOutcome);
const report = {
  methodology: {
    sourceCohort: "cross-period production-parity historical audit",
    sourceSignals: (audit.signals || []).length,
    classification: "current ordered generateMarketDataSetup production generator at each original setup candle",
    higherTimeframes: "only candles whose close boundary is at or before the base decision time",
    fourHour: "UTC-aligned 14400-second manifest candles",
    outcomes: "current Entry/SL/TP are replayed against subsequent genuine candles through the canonical validity window",
    sameCandleOrdering: "real production candleOutcome; stop-first",
    tuning: false
  },
  strategyInventory,
  sourceSignals: (audit.signals || []).length,
  replayedSignals: records.length,
  skippedSignals: skipped.length,
  generatedSignals: generatedRecords.length,
  noCurrentValidSignal: records.length - generatedRecords.length,
  outcomeComparableSignals: comparable.length,
  nonComparableGeneratedSignals: nonComparable.length,
  outcomeEvaluatedSignals: outcomeEvaluated.length,
  outcomeUnavailableSignals: generatedRecords.length - outcomeEvaluated.length,
  total: performance(outcomeEvaluated),
  perStrategy: Object.fromEntries(strategyInventory.map((strategy) => [
    strategy,
    performance(outcomeEvaluated.filter((record) => record.generated.strategy === strategy))
  ])),
  generatedPerStrategy: Object.fromEntries(strategyInventory.map((strategy) => [
    strategy,
    generatedRecords.filter((record) => record.generated.strategy === strategy).length
  ])),
  confidenceDistribution: confidenceDistribution(generatedRecords),
  naturalInvalidationCoverage: naturalInvalidationCoverage(generatedRecords),
  nonComparable: nonComparable.map((record) => ({
    signalIdentifier: record.signalIdentifier,
    reason: record.comparisonReason,
    storedDirection: record.stored.direction,
    currentDirection: record.generated.direction,
    storedLevels: [record.stored.entry, record.stored.stopLoss, record.stored.takeProfit],
    currentLevels: [record.generated.entry, record.generated.stopLoss, record.generated.takeProfit]
  })),
  skipped
};

console.log(JSON.stringify(report, null, 2));

function buildMarketData(stored, manifest, candles, setupTime) {
  const order = ["5m", "15m", "1h", "4h"];
  const decisionTime = setupTime + timeframeDurationSeconds[stored.timeframe];
  const higherTimeframes = order.slice(order.indexOf(stored.timeframe) + 1).map((timeframe) => {
    const higherCandles = (manifest.candles[timeframe] || [])
      .filter((candle) => candle.time + timeframeDurationSeconds[timeframe] <= decisionTime);
    return higherCandles.length >= 60
      ? { timeframe, available: true, regime: analyzeMarketRegime(higherCandles) }
      : { timeframe, available: false };
  });
  return {
    pair: { symbol: stored.symbol, assetClass: "Crypto", category: "Crypto" },
    source: "consolidated-production-parity-replay",
    candles,
    volumeAvailable: true,
    advancedStructure: analyzeAdvancedMarketStructure(candles, { volumeAvailable: true }),
    confluence: { symbol: stored.symbol, lowerTimeframe: stored.timeframe, higherTimeframes },
    intelligence: null,
    correlation: null
  };
}

function performance(items) {
  const tp = items.filter((item) => item.replayedOutcome.status === "Hit TP").length;
  const sl = items.filter((item) => item.replayedOutcome.status === "Hit SL").length;
  const expired = items.filter((item) => item.replayedOutcome.status === "Expired").length;
  const netR = round(items.reduce((sum, item) => sum + item.replayedOutcome.realizedR, 0));
  return {
    count: items.length,
    tp,
    sl,
    expired,
    netR,
    expectancyR: items.length ? round(netR / items.length) : null,
    winRateExcludingExpired: tp + sl ? round(tp / (tp + sl) * 100) : null
  };
}

function replayOutcome(signal, manifest, setupTime, timeframe) {
  const interval = timeframeDurationSeconds[timeframe];
  const createdAt = setupTime + interval;
  const validUntil = createdAt + getSignalValidityMs(timeframe) / 1000;
  const source = manifest.candles[timeframe] || [];
  const future = source.filter((candle) => candle.time >= createdAt && candle.time < validUntil);
  for (const candle of future) {
    const hit = candleOutcome({
      direction: signal.direction,
      stopLoss: Number(signal.stopLoss),
      takeProfit: Number(signal.takeProfit)
    }, candle);
    if (!hit) continue;
    return {
      status: hit.status,
      realizedR: hit.status === "Hit TP" ? Number(signal.riskRewardRatio) : -1,
      candleTime: candle.time,
      reason: hit.reason
    };
  }
  const latest = source.at(-1);
  if (!latest || latest.time + interval < validUntil) return null;
  return { status: "Expired", realizedR: 0, candleTime: null, reason: "Validity window completed without TP or SL." };
}

function confidenceDistribution(items) {
  const buckets = [
    ["below_65", -Infinity, 65],
    ["65_69", 65, 70],
    ["70_74", 70, 75],
    ["75_79", 75, 80],
    ["80_84", 80, 85],
    ["85_89", 85, 90],
    ["90_plus", 90, Infinity]
  ];
  return Object.fromEntries(buckets.map(([label, minimum, maximum]) => [
    label,
    items.filter((item) => item.generated.confidence >= minimum && item.generated.confidence < maximum).length
  ]));
}

function naturalInvalidationCoverage(items) {
  return Object.fromEntries(strategyInventory.map((strategy) => {
    const selected = items.filter((item) => item.generated.strategy === strategy);
    const withExplicitPrice = selected.filter((item) => Number.isFinite(Number(
      item.generated.strategyEvidence?.invalidationLevel
    ))).length;
    return [strategy, {
      generated: selected.length,
      explicitPriceInvalidation: withExplicitPrice,
      diagnosticCoverage: invalidationPolicy(strategy)
    }];
  }));
}

function invalidationPolicy(strategy) {
  return {
    "Momentum breakout": "fresh trigger must remain beyond the reference-window boundary",
    "Breakout retest": "bounded retest zone on the failed side of the breakout level",
    "Liquidity sweep reversal": "sweep wick extreme",
    "VWAP reclaim/rejection": "interaction candle extreme across session VWAP",
    "Multi-timeframe continuation": "base regime/EMA continuation plus required HTF agreement",
    "Pullback bounce": "pullback interaction extreme",
    "Support/resistance retest": "level interaction extreme",
    "Trend continuation": "pause low/high",
    "Range bounce": "range-boundary interaction extreme",
    "Mean reversion": "extension extreme"
  }[strategy];
}

async function loadManifest(signal) {
  const prefix = signal.symbol.split("-")[0].toLowerCase();
  const suffix = signal.period === "2024"
    ? "2024-historical-manifest.json"
    : signal.period === "2026 YTD"
      ? "2026-ytd-historical-manifest.json"
      : signal.sourcePeriod === "H2"
        ? "h2-2025-historical-manifest.json"
        : "historical-manifest.json";
  const path = join(dataFolder, `${prefix}-${suffix}`);
  if (!manifestCache.has(path)) {
    const raw = JSON.parse(await readFile(path, "utf8"));
    manifestCache.set(path, {
      candles: Object.fromEntries(Object.entries(raw.candles || {}).map(([timeframe, sourceCandles]) => [
        timeframe,
        sourceCandles.map((item) => ({
          time: Number.isFinite(Number(item.time)) ? Number(item.time) : new Date(item.timestamp).getTime() / 1000,
          open: Number(item.open),
          high: Number(item.high),
          low: Number(item.low),
          close: Number(item.close),
          volume: Number(item.volume)
        }))
      ]))
    });
  }
  return manifestCache.get(path);
}

function approximatelyEqual(left, right) {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= Math.max(1e-8, Math.max(Math.abs(a), Math.abs(b)) * 1e-6);
}

function round(value) {
  return Number(Number(value).toFixed(6));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
