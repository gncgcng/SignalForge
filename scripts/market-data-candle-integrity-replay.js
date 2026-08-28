import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateMarketDataSetup } from "../src/modules/signals/signalGenerator.js";
import { analyzeMarketRegime } from "../src/modules/market-data/marketRegimeService.js";
import { analyzeAdvancedMarketStructure } from "../src/modules/market-data/advancedMarketStructureService.js";
import { timeframeDurationSeconds } from "../src/modules/market-data/candleIntegrity.js";

const dataFolder = resolve(argument("--data-folder") || "C:\\Users\\monge\\Documents\\SignalForgeData");
const audit = JSON.parse(await readFile(join(dataFolder, "cross-period-signal-stability-audit.json"), "utf8"));
const manifestCache = new Map();
const records = [];

for (const signal of audit.signals || []) {
  const manifest = await loadManifest(signal);
  const signalTime = Number(String(signal.setupKey).split(":").at(-1));
  const baseCandles = manifest.candles[signal.timeframe]?.filter((candle) => candle.time <= signalTime) || [];
  if (baseCandles.length < 60 || baseCandles.at(-1)?.time !== signalTime) continue;
  const decisionTime = signalTime + timeframeDurationSeconds[signal.timeframe];
  const before = generateMarketDataSetup(buildMarketData(signal, manifest, baseCandles, decisionTime, false), signal.timeframe);
  const after = generateMarketDataSetup(buildMarketData(signal, manifest, baseCandles, decisionTime, true), signal.timeframe);
  const beforeSignal = before.valid ? before.signal : null;
  const afterSignal = after.valid ? after.signal : null;
  records.push({
    signalIdentifier: signal.signalIdentifier,
    timeframe: signal.timeframe,
    storedOutcome: signal.outcome,
    storedRealizedR: Number(signal.realizedR),
    before: summarizeGenerated(beforeSignal),
    after: summarizeGenerated(afterSignal)
  });
}

const report = {
  methodology: {
    cohort: "99 completed production-parity historical signals from the cross-period audit",
    before: "Current generator with retrospective higher-timeframe buckets selected by start time, including buckets not closed at the decision time.",
    after: "Same generator and rules, but each higher-timeframe candle must close at or before the decision time.",
    unchanged: "Base candles, strategy rules, confidence formulas, risk formulas, and stored outcomes.",
    limitation: "The manifests contain true 4h candles. This replay measures closed-HTF impact but cannot reconstruct the old live provider's mislabeled 6h direct-4h inputs."
  },
  sourceSignals: (audit.signals || []).length,
  replayedSignals: records.length,
  before: summarizePopulation(records, "before"),
  after: summarizePopulation(records, "after"),
  changes: summarizeChanges(records),
  byTimeframe: Object.fromEntries(["15m", "1h", "4h"].map((timeframe) => {
    const selected = records.filter((record) => record.timeframe === timeframe);
    return [timeframe, {
      sourceSignals: selected.length,
      before: summarizePopulation(selected, "before"),
      after: summarizePopulation(selected, "after"),
      changes: summarizeChanges(selected)
    }];
  }))
};

console.log(JSON.stringify(report, null, 2));

function buildMarketData(signal, manifest, baseCandles, decisionTime, completedOnly) {
  const order = ["5m", "15m", "1h", "4h"];
  const higherTimeframes = order.slice(order.indexOf(signal.timeframe) + 1).map((timeframe) => {
    const source = manifest.candles[timeframe] || [];
    const candles = source.filter((candle) => completedOnly
      ? candle.time + timeframeDurationSeconds[timeframe] <= decisionTime
      : candle.time <= signalTimeFrom(signal));
    return candles.length >= 60
      ? { timeframe, available: true, regime: analyzeMarketRegime(candles) }
      : { timeframe, available: false };
  });
  return {
    pair: { symbol: signal.symbol, assetClass: "Crypto", category: "Crypto" },
    source: completedOnly ? "historical-completed-candle-replay" : "historical-forming-htf-baseline",
    candles: baseCandles,
    volumeAvailable: true,
    advancedStructure: analyzeAdvancedMarketStructure(baseCandles, { volumeAvailable: true }),
    confluence: { symbol: signal.symbol, lowerTimeframe: signal.timeframe, higherTimeframes },
    intelligence: null,
    correlation: null
  };
}

function summarizeGenerated(signal) {
  if (!signal) return null;
  return {
    strategy: signal.setupType,
    direction: signal.direction,
    confidence: Number(signal.confidenceScore),
    entry: Number(signal.entryPrice),
    stopLoss: Number(signal.stopLoss),
    takeProfit: Number(signal.takeProfit)
  };
}

function summarizePopulation(items, field) {
  const generated = items.filter((item) => item[field]).map((item) => ({ ...item[field], outcome: item.storedOutcome, realizedR: item.storedRealizedR }));
  return {
    generatedSignals: generated.length,
    strategyDistribution: countBy(generated, "strategy"),
    directionDistribution: countBy(generated, "direction"),
    retainedStoredOutcomes: countBy(generated, "outcome"),
    retainedStoredRealizedR: round(generated.reduce((sum, item) => sum + item.realizedR, 0))
  };
}

function summarizeChanges(items) {
  const comparable = items.filter((item) => item.before && item.after);
  const confidenceDeltas = comparable
    .map((item) => item.after.confidence - item.before.confidence)
    .filter((value) => value !== 0);
  return {
    generatedCountDelta: items.filter((item) => item.after).length - items.filter((item) => item.before).length,
    becameNoSetup: items.filter((item) => item.before && !item.after).length,
    becameSetup: items.filter((item) => !item.before && item.after).length,
    strategyChanged: comparable.filter((item) => item.before.strategy !== item.after.strategy).length,
    directionChanged: comparable.filter((item) => item.before.direction !== item.after.direction).length,
    confidenceChanged: comparable.filter((item) => item.before.confidence !== item.after.confidence).length,
    confidenceDeltaRange: confidenceDeltas.length
      ? { minimum: Math.min(...confidenceDeltas), maximum: Math.max(...confidenceDeltas) }
      : null,
    entryChanged: comparable.filter((item) => item.before.entry !== item.after.entry).length,
    stopLossChanged: comparable.filter((item) => item.before.stopLoss !== item.after.stopLoss).length,
    takeProfitChanged: comparable.filter((item) => item.before.takeProfit !== item.after.takeProfit).length
  };
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
      candles: Object.fromEntries(Object.entries(raw.candles || {}).map(([timeframe, candles]) => [
        timeframe,
        candles.map((item) => ({
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

function signalTimeFrom(signal) {
  return Number(String(signal.setupKey).split(":").at(-1));
}

function countBy(items, field) {
  return items.reduce((counts, item) => {
    const key = item[field] ?? "Unavailable";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function round(value) {
  return Number(Number(value).toFixed(6));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

