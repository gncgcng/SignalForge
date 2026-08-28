import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateMarketDataSetup } from "../src/modules/signals/signalGenerator.js";
import { analyzeMarketRegime } from "../src/modules/market-data/marketRegimeService.js";
import { analyzeAdvancedMarketStructure } from "../src/modules/market-data/advancedMarketStructureService.js";

const dataFolder = resolve(argument("--data-folder") || "C:\\Users\\monge\\Documents\\SignalForgeData");
const audit = JSON.parse(await readFile(join(dataFolder, "cross-period-signal-stability-audit.json"), "utf8"));
const oldSignals = audit.signals.filter((signal) => signal.strategy === "Momentum breakout");
const manifestCache = new Map();
const records = [];

for (const signal of oldSignals) {
  const manifest = await loadManifestForSignal(signal);
  const signalTime = Number(String(signal.setupKey).split(":").at(-1));
  const candles = manifest.candles[signal.timeframe].filter((candle) => candle.time <= signalTime);
  assert.ok(candles.length >= 60, `${signal.signalIdentifier} lacks warmup candles`);
  assert.equal(candles.at(-1).time, signalTime, `${signal.signalIdentifier} candle timestamp mismatch`);

  const freshness = characterizeFreshness(signal.direction, candles);
  const generated = generateMarketDataSetup(buildMarketData(signal, manifest, candles), signal.timeframe);
  const directionCandidate = generated.valid && generated.signal?.direction === signal.direction
    ? generated.signal
    : generated.analysis?.candidates?.find((candidate) => candidate.direction === signal.direction);
  const remainsMomentum = directionCandidate?.setupType === "Momentum breakout";

  records.push({
    signalIdentifier: signal.signalIdentifier,
    period: signal.period,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    direction: signal.direction,
    oldOutcome: signal.outcome,
    oldRealizedR: Number(signal.realizedR),
    referenceLevel: freshness.referenceLevel,
    minus3PriorBreakout: freshness.minus3PriorBreakout,
    minus2PriorBreakout: freshness.minus2PriorBreakout,
    staleBecauseInterveningClose: freshness.priorBreakoutDetected,
    newMomentumBreakout: remainsMomentum,
    strategyEvidence: remainsMomentum ? directionCandidate.strategyEvidence || null : null,
    fallthroughStrategy: remainsMomentum ? null : directionCandidate?.setupType || null,
    fallthroughValid: remainsMomentum
      ? false
      : Boolean(generated.valid && generated.signal?.direction === signal.direction)
  });
}

const staleMinus3 = records.filter((record) => record.minus3PriorBreakout);
const staleMinus2 = records.filter((record) => record.minus2PriorBreakout);
const report = {
  methodology: {
    source: "completed production-parity signal cohort plus genuine Coinbase historical manifests",
    oldPopulation: "signals previously emitted as Momentum breakout by scanMarketSetupDetailed",
    newQualification: "unchanged -24..-4 reference and -1 trigger, with strict-close freshness at -3 and -2",
    fallthrough: "generateMarketDataSetup continues through the unchanged ordered classifier and downstream validation",
    outcomeUse: "stored production-parity outcomes are retained only for historical characterization",
    tuning: false,
    noLookahead: true
  },
  periods: Object.fromEntries(["2024", "2025", "2026 YTD", "combined"].map((period) => {
    const selected = period === "combined" ? records : records.filter((record) => record.period === period);
    return [period, compare(selected)];
  })),
  oldMomentumCandidates: records.length,
  remainingMomentum: records.filter((record) => record.newMomentumBreakout).length,
  removedMomentum: records.filter((record) => !record.newMomentumBreakout).length,
  removedSpecificallyBecauseMinus3: {
    ...metrics(staleMinus3),
    signalIdentifiers: staleMinus3.map((record) => record.signalIdentifier)
  },
  removedSpecificallyBecauseMinus2: {
    ...metrics(staleMinus2),
    signalIdentifiers: staleMinus2.map((record) => record.signalIdentifier)
  },
  removedBecauseAnyInterveningClose: records.filter((record) => record.staleBecauseInterveningClose).length,
  fallthroughIntoAnotherStrategy: records.filter((record) => !record.newMomentumBreakout && record.fallthroughStrategy).length,
  fullyValidFallthrough: records.filter((record) => record.fallthroughValid).length,
  disappearEntirelyAtClassification: records.filter((record) => !record.newMomentumBreakout && !record.fallthroughStrategy).length,
  fallthroughStrategies: countBy(records.filter((record) => !record.newMomentumBreakout && record.fallthroughStrategy), "fallthroughStrategy"),
  records
};

console.log(JSON.stringify(report, null, 2));

function characterizeFreshness(direction, candles) {
  const priorWindow = candles.slice(-24, -3);
  const referenceLevel = direction === "long"
    ? Math.max(...priorWindow.map((candle) => Number(candle.high)))
    : Math.min(...priorWindow.map((candle) => Number(candle.low)));
  const minus3Close = Number(candles.at(-3).close);
  const minus2Close = Number(candles.at(-2).close);
  const isPriorBreakout = (close) => direction === "long"
    ? close > referenceLevel
    : close < referenceLevel;
  const minus3PriorBreakout = isPriorBreakout(minus3Close);
  const minus2PriorBreakout = isPriorBreakout(minus2Close);
  return {
    referenceLevel,
    minus3PriorBreakout,
    minus2PriorBreakout,
    priorBreakoutDetected: minus3PriorBreakout || minus2PriorBreakout
  };
}

function compare(recordsForPeriod) {
  const surviving = recordsForPeriod.filter((record) => record.newMomentumBreakout);
  return {
    old: metrics(recordsForPeriod),
    new: metrics(surviving),
    removed: recordsForPeriod.length - surviving.length
  };
}

function metrics(items) {
  const tp = items.filter((item) => item.oldOutcome === "Hit TP").length;
  const sl = items.filter((item) => item.oldOutcome === "Hit SL").length;
  const expired = items.filter((item) => item.oldOutcome === "Expired").length;
  const netR = round(items.reduce((sum, item) => sum + item.oldRealizedR, 0));
  return {
    signals: items.length,
    tp,
    sl,
    expired,
    netR,
    expectancyR: items.length ? round(netR / items.length) : null
  };
}

function buildMarketData(signal, manifest, candles) {
  const order = ["5m", "15m", "1h", "4h"];
  const signalTime = candles.at(-1).time;
  const higherTimeframes = order.slice(order.indexOf(signal.timeframe) + 1).map((timeframe) => {
    const higherCandles = manifest.candles[timeframe]?.filter((candle) => candle.time <= signalTime) || [];
    return higherCandles.length >= 60
      ? { timeframe, available: true, regime: analyzeMarketRegime(higherCandles) }
      : { timeframe, available: false };
  });
  return {
    pair: { symbol: signal.symbol, assetClass: "Crypto" },
    source: "historical-momentum-breakout-freshness-replay",
    candles,
    volumeAvailable: true,
    advancedStructure: analyzeAdvancedMarketStructure(candles, { volumeAvailable: true }),
    confluence: { symbol: signal.symbol, lowerTimeframe: signal.timeframe, higherTimeframes },
    intelligence: null,
    correlation: null
  };
}

async function loadManifestForSignal(signal) {
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
      ...raw,
      candles: Object.fromEntries(Object.entries(raw.candles).map(([timeframe, candleRows]) => [
        timeframe,
        candleRows.map((candle) => ({
          time: new Date(candle.timestamp ?? candle.time).getTime() / 1000,
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
          volume: Number(candle.volume)
        }))
      ]))
    });
  }
  return manifestCache.get(path);
}

function countBy(items, field) {
  return items.reduce((counts, item) => {
    counts[item[field]] = (counts[item[field]] || 0) + 1;
    return counts;
  }, {});
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function round(value) {
  return Number(Number(value).toFixed(6));
}
