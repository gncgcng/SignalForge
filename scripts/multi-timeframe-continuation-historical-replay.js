import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateMarketDataSetup } from "../src/modules/signals/signalGenerator.js";
import { analyzeMarketRegime } from "../src/modules/market-data/marketRegimeService.js";
import { analyzeAdvancedMarketStructure } from "../src/modules/market-data/advancedMarketStructureService.js";

const timeframeSeconds = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400 };
const dataFolder = resolve(argument("--data-folder") || "C:\\Users\\monge\\Documents\\SignalForgeData");
const audit = JSON.parse(await readFile(join(dataFolder, "cross-period-signal-stability-audit.json"), "utf8"));
const oldSignals = audit.signals.filter((signal) => signal.strategy === "Multi-timeframe continuation");
const manifestCache = new Map();
const records = [];

for (const signal of oldSignals) {
  const manifest = await loadManifestForSignal(signal);
  const signalTime = Number(String(signal.setupKey).split(":").at(-1));
  const candles = manifest.candles[signal.timeframe].filter((candle) => candle.time <= signalTime);
  assert.ok(candles.length >= 60, `${signal.signalIdentifier} lacks warmup candles`);
  assert.equal(candles.at(-1).time, signalTime, `${signal.signalIdentifier} candle timestamp mismatch`);

  const marketData = buildMarketData(signal, manifest, candles, signalTime);
  const generated = generateMarketDataSetup(marketData.payload, signal.timeframe);
  const directionCandidate = generated.valid && generated.signal?.direction === signal.direction
    ? generated.signal
    : generated.analysis?.candidates?.find((candidate) => candidate.direction === signal.direction);
  const newMtfContinuation = directionCandidate?.setupType === "Multi-timeframe continuation";
  if (newMtfContinuation && generated.valid && generated.signal?.direction === signal.direction) {
    assert.equal(generated.signal.strategyEvidence?.passed, true, `${signal.signalIdentifier} missing positive MTF evidence`);
  }

  records.push({
    signalIdentifier: signal.signalIdentifier,
    period: signal.period,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    direction: signal.direction,
    confidence: Number(signal.confidence),
    oldOutcome: signal.outcome,
    oldRealizedR: Number(signal.realizedR),
    newMtfContinuation,
    acceptedEvidencePersisted: Boolean(generated.valid && generated.signal?.strategyEvidence?.passed),
    fallthroughStrategy: newMtfContinuation ? null : directionCandidate?.setupType || null,
    fallthroughValid: newMtfContinuation ? false : Boolean(generated.valid && generated.signal?.direction === signal.direction),
    potentiallyFormingHigherTimeframes: marketData.potentiallyFormingHigherTimeframes
  });
}

const removed = records.filter((record) => !record.newMtfContinuation);
const report = {
  methodology: {
    source: "completed production-parity signal cohort plus genuine Coinbase historical manifests",
    oldPopulation: "signals previously emitted as Multi-timeframe continuation by scanMarketSetupDetailed",
    newQualification: "current generateMarketDataSetup ordered production classifier at the original setup candle",
    outcomeUse: "stored production-parity outcomes are retained only for signals that remain Multi-timeframe continuation",
    tuning: false,
    futureOutcomeCandlesUsedForClassification: false,
    providerCandleContract: "Higher-timeframe candles are included only when their close boundary is at or before the decision time.",
    fourHourParity: "Historical manifests and the corrected live provider both use UTC-aligned 14400-second 4h candles."
  },
  periods: Object.fromEntries(["2024", "2025", "2026 YTD", "combined"].map((period) => {
    const selected = period === "combined" ? records : records.filter((record) => record.period === period);
    return [period, compare(selected)];
  })),
  oldMtfSignals: records.length,
  remainingMtfSignals: records.length - removed.length,
  acceptedSignalsWithEvidence: records.filter((record) => record.newMtfContinuation && record.acceptedEvidencePersisted).length,
  removedMtfSignals: removed.length,
  fallthroughIntoAnotherStrategy: removed.filter((record) => record.fallthroughStrategy).length,
  fullyValidFallthroughSignals: removed.filter((record) => record.fallthroughValid).length,
  noClassificationCount: removed.filter((record) => !record.fallthroughStrategy).length,
  fallthroughStrategies: countBy(removed.filter((record) => record.fallthroughStrategy), "fallthroughStrategy"),
  removedConfidenceDiagnostics: {
    atLeast80: removed.filter((record) => record.confidence >= 80).length,
    atLeast88: removed.filter((record) => record.confidence >= 88).length,
    atLeast92: removed.filter((record) => record.confidence >= 92).length
  },
  potentiallyFormingHtfContexts: records.filter((record) => record.potentiallyFormingHigherTimeframes.length > 0).length,
  records
};

console.log(JSON.stringify(report, null, 2));

function compare(recordsForPeriod) {
  const surviving = recordsForPeriod.filter((record) => record.newMtfContinuation);
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
  const decisionTime = signalTime + inferIntervalSeconds(candles, timeframeSeconds[signal.timeframe]);
  const potentiallyFormingHigherTimeframes = [];
  const higherTimeframes = order.slice(order.indexOf(signal.timeframe) + 1).map((timeframe) => {
    const availableAtStart = manifest.candles[timeframe]?.filter((candle) => candle.time <= signalTime) || [];
    const latest = availableAtStart.at(-1);
    const interval = inferIntervalSeconds(availableAtStart, timeframeSeconds[timeframe]);
    if (latest && latest.time + interval > decisionTime) {
      potentiallyFormingHigherTimeframes.push(timeframe);
    }
    const higherCandles = availableAtStart.filter((candle) => candle.time + interval <= decisionTime);
    return higherCandles.length >= 60
      ? { timeframe, available: true, regime: analyzeMarketRegime(higherCandles) }
      : { timeframe, available: false };
  });
  return {
    payload: {
      pair: { symbol: signal.symbol, assetClass: "Crypto" },
      source: "historical-multi-timeframe-continuation-replay",
      candles,
      volumeAvailable: true,
      advancedStructure: analyzeAdvancedMarketStructure(candles, { volumeAvailable: true }),
      confluence: { symbol: signal.symbol, lowerTimeframe: signal.timeframe, higherTimeframes },
      intelligence: null,
      correlation: null
    },
    potentiallyFormingHigherTimeframes
  };
}

function inferIntervalSeconds(candles, fallback) {
  const recent = candles.slice(-20);
  const intervals = recent.slice(1)
    .map((candle, index) => candle.time - recent[index].time)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  return intervals.length ? intervals[Math.floor(intervals.length / 2)] : fallback;
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
      candles: Object.fromEntries(Object.entries(raw.candles).map(([timeframe, sourceCandles]) => [
        timeframe,
        sourceCandles.map((item) => ({
          time: new Date(item.timestamp ?? item.time).getTime() / 1000,
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
