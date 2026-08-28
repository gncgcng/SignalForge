import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateMarketDataSetup } from "../src/modules/signals/signalGenerator.js";
import { analyzeMarketRegime } from "../src/modules/market-data/marketRegimeService.js";
import { analyzeAdvancedMarketStructure } from "../src/modules/market-data/advancedMarketStructureService.js";
import { timeframeDurationSeconds } from "../src/modules/market-data/candleIntegrity.js";

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
    fourHourParity: "Historical manifests and the live provider both use UTC-aligned 14400-second 4h candles."
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
  potentiallyFormingHtfContexts: records.filter((record) => record.potentiallyFormingHigherTimeframes.length > 0).length,
  records
};

console.log(JSON.stringify(report, null, 2));

function compare(items) {
  const surviving = items.filter((record) => record.newMtfContinuation);
  return { old: metrics(items), new: metrics(surviving), removed: items.length - surviving.length };
}

function metrics(items) {
  const tp = items.filter((item) => item.oldOutcome === "Hit TP").length;
  const sl = items.filter((item) => item.oldOutcome === "Hit SL").length;
  const expired = items.filter((item) => item.oldOutcome === "Expired").length;
  const netR = round(items.reduce((sum, item) => sum + item.oldRealizedR, 0));
  return { signals: items.length, tp, sl, expired, netR, expectancyR: items.length ? round(netR / items.length) : null };
}

function buildMarketData(signal, manifest, candles, signalTime) {
  const order = ["5m", "15m", "1h", "4h"];
  const decisionTime = signalTime + timeframeDurationSeconds[signal.timeframe];
  const potentiallyFormingHigherTimeframes = [];
  const higherTimeframes = order.slice(order.indexOf(signal.timeframe) + 1).map((timeframe) => {
    const source = manifest.candles[timeframe] || [];
    const latestAtStart = source.filter((candle) => candle.time <= signalTime).at(-1);
    if (latestAtStart && latestAtStart.time + timeframeDurationSeconds[timeframe] > decisionTime) {
      potentiallyFormingHigherTimeframes.push(timeframe);
    }
    const higherCandles = source.filter((candle) => candle.time + timeframeDurationSeconds[timeframe] <= decisionTime);
    return higherCandles.length >= 60
      ? { timeframe, available: true, regime: analyzeMarketRegime(higherCandles) }
      : { timeframe, available: false };
  });
  return {
    payload: {
      pair: { symbol: signal.symbol, assetClass: "Crypto", category: "Crypto" },
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
