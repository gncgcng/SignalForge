import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateMarketDataSetup } from "../src/modules/signals/signalGenerator.js";
import { analyzeMarketRegime } from "../src/modules/market-data/marketRegimeService.js";
import { analyzeAdvancedMarketStructure } from "../src/modules/market-data/advancedMarketStructureService.js";

const dataFolder = resolve(argument("--data-folder") || "C:\\Users\\monge\\Documents\\SignalForgeData");
const audit = JSON.parse(await readFile(join(dataFolder, "cross-period-signal-stability-audit.json"), "utf8"));
const oldSignals = audit.signals.filter((signal) => signal.strategy === "Support/resistance retest");
const manifestCache = new Map();
const records = [];

for (const signal of oldSignals) {
  const manifest = await loadManifestForSignal(signal);
  const signalTime = Number(String(signal.setupKey).split(":").at(-1));
  const candles = manifest.candles[signal.timeframe].filter((candle) => candle.time <= signalTime);
  assert.ok(candles.length >= 60, `${signal.signalIdentifier} lacks warmup candles`);
  assert.equal(candles.at(-1).time, signalTime, `${signal.signalIdentifier} candle timestamp mismatch`);

  const generated = generateMarketDataSetup(buildMarketData(signal, manifest, candles, signalTime), signal.timeframe);
  const directionCandidate = generated.valid && generated.signal?.direction === signal.direction
    ? generated.signal
    : generated.analysis?.candidates?.find((candidate) => candidate.direction === signal.direction);
  const remainsSupportResistanceRetest = directionCandidate?.setupType === "Support/resistance retest";

  records.push({
    signalIdentifier: signal.signalIdentifier,
    period: signal.period,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    direction: signal.direction,
    oldOutcome: signal.outcome,
    oldRealizedR: Number(signal.realizedR),
    newSupportResistanceRetest: remainsSupportResistanceRetest,
    strategyEvidence: remainsSupportResistanceRetest ? directionCandidate.strategyEvidence || null : null,
    fallthroughStrategy: remainsSupportResistanceRetest ? null : directionCandidate?.setupType || null,
    fallthroughValid: remainsSupportResistanceRetest
      ? false
      : Boolean(generated.valid && generated.signal?.direction === signal.direction)
  });
}

const report = {
  methodology: {
    source: "completed production-parity signal cohort plus genuine Coinbase historical manifests",
    oldPopulation: "signals previously emitted as Support/resistance retest by scanMarketSetupDetailed",
    newQualification: "current ordered production classifier using canonical completed candles",
    fallthrough: "generateMarketDataSetup continues through the unchanged ordered classifier and downstream validation",
    outcomeUse: "stored production-parity outcomes are retained only for signals that remain Support/resistance retest",
    tuning: false,
    noLookahead: true
  },
  periods: Object.fromEntries(["2024", "2025", "2026 YTD", "combined"].map((period) => {
    const selected = period === "combined" ? records : records.filter((record) => record.period === period);
    return [period, compare(selected)];
  })),
  removedOldSupportResistanceRetests: records.filter((record) => !record.newSupportResistanceRetest).length,
  remainingSupportResistanceRetests: records.filter((record) => record.newSupportResistanceRetest).length,
  fallthroughIntoAnotherStrategy: records.filter((record) => !record.newSupportResistanceRetest && record.fallthroughStrategy).length,
  fullyValidFallthrough: records.filter((record) => record.fallthroughValid).length,
  disappearEntirelyAtClassification: records.filter((record) => !record.newSupportResistanceRetest && !record.fallthroughStrategy).length,
  fallthroughStrategies: countBy(records.filter((record) => !record.newSupportResistanceRetest && record.fallthroughStrategy), "fallthroughStrategy"),
  records
};

console.log(JSON.stringify(report, null, 2));

function compare(recordsForPeriod) {
  const surviving = recordsForPeriod.filter((record) => record.newSupportResistanceRetest);
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

function buildMarketData(signal, manifest, candles, signalTime) {
  const order = ["5m", "15m", "1h", "4h"];
  const higherTimeframes = order.slice(order.indexOf(signal.timeframe) + 1).map((timeframe) => {
    const higherCandles = manifest.candles[timeframe]?.filter((candle) => candle.time <= signalTime) || [];
    return higherCandles.length >= 60
      ? { timeframe, available: true, regime: analyzeMarketRegime(higherCandles) }
      : { timeframe, available: false };
  });
  return {
    pair: { symbol: signal.symbol, assetClass: "Crypto" },
    source: "historical-support-resistance-retest-replay",
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
      candles: Object.fromEntries(Object.entries(raw.candles).map(([timeframe, candles]) => [
        timeframe,
        candles.map((candle) => ({
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
