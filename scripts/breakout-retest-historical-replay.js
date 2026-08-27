import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  evaluateBreakoutRetestSetup,
  generateMarketDataSetup
} from "../src/modules/signals/signalGenerator.js";
import { analyzeMarketRegime } from "../src/modules/market-data/marketRegimeService.js";
import { analyzeAdvancedMarketStructure } from "../src/modules/market-data/advancedMarketStructureService.js";

const dataFolder = resolve(argument("--data-folder") || "C:\\Users\\monge\\Documents\\SignalForgeData");
const audit = JSON.parse(await readFile(join(dataFolder, "cross-period-signal-stability-audit.json"), "utf8"));
const oldSignals = audit.signals.filter((signal) => signal.strategy === "Breakout retest");
const manifestCache = new Map();
const records = [];

for (const signal of oldSignals) {
  const manifest = await loadManifestForSignal(signal);
  const signalTime = Number(String(signal.setupKey).split(":").at(-1));
  const candles = manifest.candles[signal.timeframe].filter((candle) => candle.time <= signalTime);
  assert.ok(candles.length >= 60, `${signal.signalIdentifier} lacks warmup candles`);
  assert.equal(candles.at(-1).time, signalTime, `${signal.signalIdentifier} candle timestamp mismatch`);

  const evidence = evaluateBreakoutRetestSetup(signal.direction, candles, { atr14: signal.atr });
  const generated = generateMarketDataSetup(buildMarketData(signal, manifest, candles, signalTime), signal.timeframe);
  const directionCandidate = generated.valid && generated.signal?.direction === signal.direction
    ? generated.signal
    : generated.analysis?.candidates?.find((candidate) => candidate.direction === signal.direction);

  records.push({
    signalIdentifier: signal.signalIdentifier,
    period: signal.period,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    direction: signal.direction,
    oldOutcome: signal.outcome,
    oldRealizedR: Number(signal.realizedR),
    newBreakoutRetest: evidence.qualified,
    freshBreakout: evidence.freshBreakout,
    heldLevel: evidence.heldLevel,
    confirmation: evidence.confirmation,
    retestDistanceAtr: evidence.retestDistanceAtr,
    fallthroughStrategy: evidence.qualified ? null : directionCandidate?.setupType || null,
    fallthroughValid: evidence.qualified ? false : Boolean(generated.valid && generated.signal?.direction === signal.direction)
  });
}

const report = {
  methodology: {
    source: "completed production-parity signal cohort plus genuine Coinbase historical manifests",
    oldPopulation: "signals previously emitted as Breakout retest by scanMarketSetupDetailed",
    newQualification: "evaluateBreakoutRetestSetup at the original setup candle",
    fallthrough: "generateMarketDataSetup current ordered production classifier with reconstructed same-symbol HTF and advanced structure",
    outcomeUse: "stored production-parity outcomes are retained only for signals that remain Breakout retest",
    tuning: false,
    noLookahead: true
  },
  periods: Object.fromEntries(["2024", "2025", "2026 YTD", "combined"].map((period) => {
    const selected = period === "combined" ? records : records.filter((record) => record.period === period);
    return [period, compare(selected)];
  })),
  removedOldBreakoutRetests: records.filter((record) => !record.newBreakoutRetest).length,
  fallthroughIntoAnotherStrategy: records.filter((record) => !record.newBreakoutRetest && record.fallthroughStrategy).length,
  disappearEntirelyAtClassification: records.filter((record) => !record.newBreakoutRetest && !record.fallthroughStrategy).length,
  fallthroughStrategies: countBy(records.filter((record) => !record.newBreakoutRetest && record.fallthroughStrategy), "fallthroughStrategy"),
  records
};

console.log(JSON.stringify(report, null, 2));

function compare(recordsForPeriod) {
  const surviving = recordsForPeriod.filter((record) => record.newBreakoutRetest);
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
    source: "historical-breakout-retest-replay",
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
