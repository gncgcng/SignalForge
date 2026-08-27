import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  analyzeSmartMoneyConcepts,
  LIQUIDITY_SWEEP_REVERSAL_MAX_AGE_CANDLES
} from "../src/modules/market-data/smartMoneyConceptsService.js";
import {
  classifySetupType,
  evaluateLiquiditySweepReversalSetup
} from "../src/modules/signals/signalGenerator.js";

const generatorSource = await readFile(new URL("../src/modules/signals/signalGenerator.js", import.meta.url), "utf8");
const validLongCandles = sweepFixture();
const validShortCandles = mirrorCandles(validLongCandles);
const validLongSmc = analyzeSmartMoneyConcepts(validLongCandles);
const validShortSmc = analyzeSmartMoneyConcepts(validShortCandles);

assert.equal(LIQUIDITY_SWEEP_REVERSAL_MAX_AGE_CANDLES, 1);
assert.equal(validLongSmc.liquiditySweep?.direction, "long", "legacy SMC state remains available for unchanged confidence scoring");
assert.equal(validShortSmc.liquiditySweep?.direction, "short");
assert.equal(validLongSmc.liquiditySweepReversal?.direction, "long");
assert.equal(validShortSmc.liquiditySweepReversal?.direction, "short");
assert.equal(classify(validLongCandles, "long", validLongSmc), "Liquidity sweep reversal");
assert.equal(classify(validShortCandles, "short", validShortSmc), "Liquidity sweep reversal");

const longEvidence = evidence(validLongCandles, "long", validLongSmc);
const shortEvidence = evidence(validShortCandles, "short", validShortSmc);
assert.equal(longEvidence.qualified, true);
assert.equal(shortEvidence.qualified, true);
assert.equal(longEvidence.liquidityLevel, 96);
assert.equal(shortEvidence.liquidityLevel, 104);
assert.equal(longEvidence.sweepDistanceAtr, shortEvidence.sweepDistanceAtr);
assert.equal(longEvidence.reversalMoveAtr, shortEvidence.reversalMoveAtr);
assert.equal(longEvidence.distanceFromSweepAtr, shortEvidence.distanceFromSweepAtr);
assert.equal(longEvidence.ageCandles, 1);
assert.equal(shortEvidence.ageCandles, 1);
assert.equal(longEvidence.invalidationLevel + shortEvidence.invalidationLevel, 200);

const longHistory = [...baseCandles(100), ...validLongCandles].map((item, index) => ({
  ...item,
  time: 1_600_000_000 + index * 900
}));
const longHistorySmc = analyzeSmartMoneyConcepts(longHistory);
assert.equal(longHistorySmc.liquiditySweepReversal?.sweepIndex, longHistory.length - 2);
assert.equal(longHistorySmc.liquiditySweepReversal?.referenceSwing?.index, 114);
assert.equal(evidence(longHistory, "long", longHistorySmc).qualified, true, "120-candle analysis indexes remain absolute");

const touchOnly = sweepFixture({ sweep: { open: 97, high: 98, low: 96, close: 97 } });
assertRejectedBoth(touchOnly, "touch without breach");

const noReclaim = sweepFixture({ sweep: { open: 97, high: 98, low: 95, close: 95.5 } });
assertRejectedBoth(noReclaim, "breach without reclaim");

const stale = sweepFixture({
  sweepIndex: 27,
  sweep: { open: 97, high: 98, low: 95, close: 97 },
  middle: { open: 97, high: 98.5, low: 96.8, close: 98 },
  confirmation: { open: 98, high: 100, low: 97.8, close: 99.5 }
});
const staleSmc = analyzeSmartMoneyConcepts(stale);
assert.equal(staleSmc.liquiditySweep?.direction, "long", "characterization: the old six-candle SMC event remains present");
assert.equal(staleSmc.liquiditySweepReversal, null);
assert.notEqual(classify(stale, "long", staleSmc), "Liquidity sweep reversal");
assert.notEqual(classify(mirrorCandles(stale), "short", analyzeSmartMoneyConcepts(mirrorCandles(stale))), "Liquidity sweep reversal");

const unrelated = sweepFixture({ confirmation: { open: 99, high: 99.2, low: 97.2, close: 97.5 } });
assertRejectedBoth(unrelated, "wrong-direction confirmation");

const dual = dualSweepFixture();
const dualSmc = analyzeSmartMoneyConcepts(dual);
assert.equal(dualSmc.liquiditySweep?.direction, "long", "characterization: legacy assignment still resolves LONG for unchanged SMC scoring");
assert.equal(dualSmc.liquiditySweepReversal?.ambiguous, true);
assert.notEqual(classify(dual, "long", dualSmc), "Liquidity sweep reversal");
assert.notEqual(classify(dual, "short", dualSmc), "Liquidity sweep reversal");

const directionalOnly = sweepFixture({ sweep: { open: 97, high: 98, low: 96.2, close: 97 } });
assertRejectedBoth(directionalOnly, "directional candle without sweep");

const fakeDisconnectedState = {
  liquiditySweep: { confirmed: true, direction: "long", level: 96, time: validLongCandles[20].time }
};
assert.notEqual(classify(validLongCandles, "long", fakeDisconnectedState), "Liquidity sweep reversal");

const fallthroughType = classify(stale, "long", staleSmc, {
  higherTimeframes: [{ available: true, regime: { preferredDirection: "long" } }]
});
assert.equal(fallthroughType, "Multi-timeframe continuation");

assert.doesNotMatch(
  generatorSource.match(/buildDynamicRiskPlan\(\{[\s\S]*?\}\);/)?.[0] || "",
  /strategyEvidence|liquiditySweepReversal/,
  "liquidity evidence must remain diagnostic and must not feed the generic risk engine"
);

console.log(JSON.stringify({
  oldRule: {
    pivotWidth: 2,
    analysisWindow: 120,
    sweepSearchCandles: 6,
    minimumSweepDistance: null,
    maximumSweepDistance: null,
    currentDirectionalCandleOnly: true,
    dualSweepOverwrite: "long"
  },
  newRule: {
    maximumAgeCandles: LIQUIDITY_SWEEP_REVERSAL_MAX_AGE_CANDLES,
    strictBreach: true,
    strictReclaim: true,
    directionalConfirmation: true,
    dualSweep: "ambiguous_rejected"
  },
  mirroredEvidence: { long: longEvidence, short: shortEvidence },
  rejectedOldFalsePositives: ["stale", "unrelated_confirmation", "dual_sided", "legacy_only_state"],
  fallthrough: fallthroughType
}, null, 2));
console.log("Liquidity Sweep Reversal focused tests passed.");

function classify(candles, direction, smcState, confluenceContext = null) {
  const long = direction === "long";
  return classifySetupType(
    direction,
    candles,
    { ema20: long ? 99 : 101, ema50: long ? 98 : 102, rsi14: long ? 44 : 56, atr14: 2, volumeMa20: 100 },
    {
      nearestSupport: { price: long ? 96 : 90 },
      nearestResistance: { price: long ? 110 : 104 },
      supportStrength: 3,
      resistanceStrength: 3
    },
    { label: "Range", trendStrength: 0.3 },
    smcState,
    null,
    confluenceContext
  );
}

function evidence(candles, direction, smcState) {
  return evaluateLiquiditySweepReversalSetup(direction, candles, { atr14: 2 }, smcState);
}

function assertRejectedBoth(candles, reason) {
  const longSmc = analyzeSmartMoneyConcepts(candles);
  const shortCandles = mirrorCandles(candles);
  const shortSmc = analyzeSmartMoneyConcepts(shortCandles);
  assert.notEqual(classify(candles, "long", longSmc), "Liquidity sweep reversal", `LONG ${reason}`);
  assert.notEqual(classify(shortCandles, "short", shortSmc), "Liquidity sweep reversal", `SHORT ${reason}`);
}

function sweepFixture(overrides = {}) {
  const candles = baseCandles(30);
  const sweepIndex = overrides.sweepIndex ?? 28;
  if (sweepIndex === 27) {
    candles[27] = makeCandle(27, overrides.sweep || { open: 97, high: 98, low: 95, close: 97 });
    candles[28] = makeCandle(28, overrides.middle || { open: 97, high: 98.5, low: 96.8, close: 98 });
  } else {
    candles[28] = makeCandle(28, overrides.sweep || { open: 97, high: 98, low: 95, close: 97 });
  }
  candles[29] = makeCandle(29, overrides.confirmation || { open: 97, high: 100, low: 96.8, close: 99 });
  return candles;
}

function dualSweepFixture() {
  const candles = baseCandles(30);
  candles[29] = makeCandle(29, { open: 100, high: 105, low: 95, close: 100 });
  return candles;
}

function baseCandles(length) {
  return Array.from({ length }, (_, index) => makeCandle(index, {
    open: 100,
    high: index === 10 ? 104 : 102,
    low: index === 14 ? 96 : 98,
    close: 100
  }));
}

function makeCandle(index, values) {
  return { time: 1_700_000_000 + index * 900, volume: 100 + index, ...values };
}

function mirrorCandles(candles, pivot = 100) {
  return candles.map((candle) => ({
    ...candle,
    open: pivot * 2 - candle.open,
    high: pivot * 2 - candle.low,
    low: pivot * 2 - candle.high,
    close: pivot * 2 - candle.close
  }));
}
