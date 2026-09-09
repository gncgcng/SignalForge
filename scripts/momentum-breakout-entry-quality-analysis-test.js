import assert from "node:assert/strict";
import {
  analyzeMomentumInputs,
  buildBucketAnalysis,
  buildCounterfactualRange,
  calculateExpansionFeatures,
  calculateMarketQuality,
  calculateSetupFeatures,
  decodeText,
  evaluateOutcomePath,
  extractJsonDocument,
  summarizeOutcomes
} from "./momentum-breakout-entry-quality-analysis.js";

const HOUR = 3600;
const START = Date.parse("2024-01-01T00:00:00.000Z") / 1000;

testJsonExtraction();
testReplayTextEncoding();
testSetupFeatureSnapshotDoesNotUseFutureCandles();
testExpansionAndMarketQualityDiagnostics();
testStopFirstOutcomeAndLaterTarget();
testBucketsAndCounterfactuals();
testCompleteOfflineAnalysis();
testMalformedInputRejection();

console.log("Momentum Breakout entry-quality analysis tests passed.");

function testJsonExtraction() {
  const parsed = extractJsonDocument(`noise before\n{"message":"brace } in text","nested":{"ok":true}}\nnoise after`);
  assert.deepEqual(parsed, { message: "brace } in text", nested: { ok: true } });
  const selected = extractJsonDocument('diagnostic {not json}\n{"small":true}\n{"policies":{"baseline":{"records":[]}}}', (value) => Array.isArray(value?.policies?.baseline?.records));
  assert.deepEqual(selected, { policies: { baseline: { records: [] } } });
  assert.throws(() => extractJsonDocument("no document"), /does not contain/);
  assert.throws(() => extractJsonDocument("prefix {\"broken\": true"), /complete JSON/);
}

function testReplayTextEncoding() {
  const source = '{"policies":{"baseline":{"records":[]}}}';
  assert.equal(decodeText(Buffer.from(source, "utf8")), source);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")])), source);
}

function testSetupFeatureSnapshotDoesNotUseFutureCandles() {
  const setupCandles = buildSetupCandles();
  const context = featureContext(setupCandles);
  const first = calculateSetupFeatures(context);
  const future = { time: setupCandles.at(-1).time + HOUR, open: 111, high: 1000, low: 1, close: 900, volume: 1_000_000 };
  const second = calculateSetupFeatures({ ...context, candles: [...setupCandles, future] });
  assert.notDeepEqual(first, second, "Passing a future candle as setup data must visibly alter the snapshot; callers must freeze the setup window.");

  const frozenAgain = calculateSetupFeatures(featureContext(setupCandles));
  assert.deepEqual(first, frozenAgain);
  assert.equal(first.breakoutDistanceAtr > 0, true);
  assert.equal(first.bodyBeyondLevelFraction > 0, true);
  assert.equal(first.stopDistanceAtr > 0, true);
  assert.equal(first.reconstructedRiskReward, 2);
}

function testExpansionAndMarketQualityDiagnostics() {
  const candles = buildSetupCandles();
  const expansion = calculateExpansionFeatures(candles, "long", 2);
  assert.equal(Number.isFinite(expansion.previous3BarMoveAtr), true);
  assert.equal(expansion.directionalExpansionCount3 >= 1, true);

  const qualityCandles = Array.from({ length: 39 }, (_, index) => candle(index, 100, 101, 99, 100.5, 100));
  qualityCandles.push(candle(39, 100, 120, 80, 110, 10_000));
  const quality = calculateMarketQuality(qualityCandles);
  assert.equal(quality.maxRangeToMedianRange >= 20, true);
  assert.equal(quality.severeIsolatedRangeSpikes, 1);
  assert.equal(quality.severeIsolatedVolumeSpikes, 1);
}

function testStopFirstOutcomeAndLaterTarget() {
  const signal = {
    timeframe: "1h",
    direction: "long",
    entryPrice: 100,
    stopLoss: 98,
    takeProfit: 104,
    riskRewardRatio: 2,
    validUntil: new Date((START + 20 * HOUR) * 1000).toISOString()
  };
  const future = [
    candleAt(1, 100, 101, 99, 100, 100),
    candleAt(2, 100, 104.5, 97.5, 101, 100),
    candleAt(3, 101, 105, 100, 104, 100)
  ];
  const result = evaluateOutcomePath({ signal, candles: future, entryTimestampMs: START * 1000, atr: 2 });
  assert.equal(result.outcomeReconstructed, "Hit SL");
  assert.equal(result.sameCandleAmbiguity, true);
  assert.equal(result.tpReachedLaterAfterSl, true);
  assert.equal(result.candlesFromSlToLaterTp, 1);
  assert.equal(result.candlesToTerminal, 2);
}

function testBucketsAndCounterfactuals() {
  const records = [
    diagnosticRecord(0.2, "Hit TP", 2, "2024"),
    diagnosticRecord(0.6, "Hit SL", -1, "2025"),
    diagnosticRecord(1.2, "Expired", 0, "2026 YTD")
  ];
  assert.deepEqual(summarizeOutcomes(records), { signals: 3, tp: 1, sl: 1, expired: 1, winRate: 50, netR: 1, expectancyR: 0.333333 });
  const buckets = buildBucketAnalysis(records, "breakoutDistanceAtr", [0.5, 1]);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.signals, 0), 3);
  const counterfactual = buildCounterfactualRange(records, { feature: "breakoutDistanceAtr", operator: "<=", thresholds: [0.5, 1] });
  assert.equal(counterfactual.thresholds[0].retained.signals, 1);
  assert.equal(counterfactual.thresholds[1].retained.signals, 2);
  assert.equal(counterfactual.thresholds[1].supplyRetainedPercent, 66.666667);
}

function testCompleteOfflineAnalysis() {
  const fixture = buildOfflineInput();
  const report = analyzeMomentumInputs([fixture]);
  assert.equal(report.sample.total, 1);
  assert.equal(report.sample.periods["2024"].tp, 1);
  assert.equal(report.dataQuality.outcomeReconstructionMismatches.length, 0);
  assert.equal(report.dataQuality.atrParityMismatches.length, 0);
  assert.equal(report.records[0].outcomeReplay, "Hit TP");
  assert.equal(report.records[0].outcomeReconstructed, "Hit TP");
  assert.equal(report.prospectiveShadow.feasibleWithoutSchemaMigration, true);
  assert.equal(report.prospectiveShadow.productionChangeImplemented, false);
  assert.equal(report.conclusions.productionRuleSupported, false);
}

function testMalformedInputRejection() {
  assert.throws(() => analyzeMomentumInputs([]), /At least one replay input/);
  assert.throws(() => analyzeMomentumInputs([{ replay: {}, manifest: {}, resultName: "bad", manifestName: "bad" }]), /baseline replay records/);
}

function buildOfflineInput() {
  const setupCandles = buildSetupCandles();
  const trigger = setupCandles.at(-1);
  const future = Array.from({ length: 20 }, (_, index) => {
    if (index === 2) return { time: trigger.time + (index + 1) * HOUR, open: 112, high: 118, low: 110, close: 117, volume: 140 };
    return { time: trigger.time + (index + 1) * HOUR, open: 111, high: 113, low: 110, close: 112, volume: 120 };
  });
  const atr = 2.0714285714285716;
  const timestamp = new Date(trigger.time * 1000).toISOString();
  const validUntil = new Date((trigger.time + 20 * HOUR) * 1000).toISOString();
  const setupKey = `BTC-USD:1h:long:${trigger.time}`;
  const signal = { direction: "long", strategy: "Momentum breakout", confidence: 84, entry: 111, stopLoss: 107.9, takeProfit: 117.2, riskRewardRatio: 2, atr, validUntil };
  return {
    resultName: "fixture-risk-replay-results.txt",
    manifestName: "fixture-historical-manifest.json",
    manifest: {
      sourceType: "real_provider",
      symbol: "BTC-USD",
      provider: "fixture",
      candleTimezone: "UTC",
      source: { from: "2024-01-01T00:00:00.000Z", to: "2024-12-31T00:00:00.000Z" },
      candles: { "1h": [...setupCandles, ...future] }
    },
    replay: {
      observations: [{ setupKey, replayTimestamp: timestamp, timeframe: "1h", signal }],
      policies: { baseline: { records: [{ setupKey, symbol: "BTC-USD", timeframe: "1h", strategy: "Momentum breakout", direction: "long", replayTimestamp: timestamp, entryPrice: 111, stopLoss: 107.9, takeProfit: 117.2, riskRewardRatio: 2, outcome: "Hit TP", realizedR: 2 }] } }
    }
  };
}

function buildSetupCandles() {
  const candles = Array.from({ length: 120 }, (_, index) => {
    const base = 100 + index * 0.07;
    return candle(index, base, base + 1, base - 1, base + 0.4, 100 + index % 7);
  });
  candles[118] = candle(118, 108.5, 109.5, 107.5, 109, 105);
  candles[119] = candle(119, 109, 110, 108, 109.5, 110);
  candles.push(candle(120, 109.5, 112, 109, 111, 180));
  return candles;
}

function featureContext(candles) {
  return {
    signal: { direction: "long", entryPrice: 111, stopLoss: 107.9, takeProfit: 117.2, riskRewardRatio: 2 },
    candles,
    indicators: { atr14: 2.0714285714285716, ema20: 107, ema50: 104, volumeMa20: 108 },
    breakoutLevel: 109.5,
    levels: { nearestSupport: { price: 106 }, nearestResistance: { price: 118 }, nearestSwingLow: { price: 106.5 }, nearestSwingHigh: { price: 118 } }
  };
}

function diagnosticRecord(value, outcomeReplay, realizedR, period) {
  return { breakoutDistanceAtr: value, outcomeReplay, realizedR, period };
}

function candle(index, open, high, low, close, volume) {
  return { time: START + index * HOUR, open, high, low, close, volume };
}

function candleAt(index, open, high, low, close, volume) {
  return { time: START + index * HOUR, open, high, low, close, volume };
}
