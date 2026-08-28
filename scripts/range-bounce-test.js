import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  RANGE_BOUNCE_INTERACTION_TOLERANCE_ATR,
  RANGE_BOUNCE_MAX_AGE_CANDLES,
  RANGE_BOUNCE_MIN_INSIDE_RATIO,
  RANGE_BOUNCE_MIN_WIDTH_ATR,
  classifySetupType,
  evaluateRangeBounceSetup
} from "../src/modules/signals/signalGenerator.js";

const generatorSource = await readFile(new URL("../src/modules/signals/signalGenerator.js", import.meta.url), "utf8");
const cleanLong = rangeFixture();
const cleanShort = mirrorFixture(cleanLong);

assert.equal(RANGE_BOUNCE_MIN_WIDTH_ATR, 2.5);
assert.equal(RANGE_BOUNCE_INTERACTION_TOLERANCE_ATR, 0.35);
assert.equal(RANGE_BOUNCE_MAX_AGE_CANDLES, 1);
assert.equal(RANGE_BOUNCE_MIN_INSIDE_RATIO, 0.7);
assert.equal(oldRangeBounce(cleanLong), true);
assert.equal(classify(cleanLong), "Range bounce");
assert.equal(classify(cleanShort), "Range bounce");

const noCompleteRange = rangeFixture({ omitUpperBoundary: true });
assert.equal(oldRangeBounce(noCompleteRange), true, "characterization: old rule did not require both boundaries");
assert.equal(evidence(noCompleteRange).qualified, false);
assert.notEqual(classify(noCompleteRange), "Range bounce");

const noTouch = rangeFixture({
  interaction: { open: 97.2, high: 98.5, low: 97, close: 97.5 }
});
assert.equal(oldRangeBounce(noTouch), true, "characterization: old close-proximity rule accepted no boundary touch");
assert.notEqual(classify(noTouch), "Range bounce");
assert.notEqual(classify(mirrorFixture(noTouch)), "Range bounce");

const closedOutside = rangeFixture({
  interaction: { open: 93.5, high: 94.8, low: 93, close: 94 }
});
assert.equal(evidence(closedOutside).closedInsideRange, false);
assert.notEqual(classify(closedOutside), "Range bounce");
assert.notEqual(classify(mirrorFixture(closedOutside)), "Range bounce");

const continuedOutward = rangeFixture({
  interaction: { open: 96, high: 96.2, low: 93, close: 93.5 }
});
assert.notEqual(classify(continuedOutward), "Range bounce");

const wrongDirection = rangeFixture({
  interaction: { open: 98, high: 98.2, low: 95.2, close: 97 }
});
assert.equal(evidence(wrongDirection).movedTowardInterior, false);
assert.notEqual(classify(wrongDirection), "Range bounce");

const stale = rangeFixture({ staleInteraction: true });
assert.equal(evidence(stale).qualified, false);
assert.notEqual(classify(stale), "Range bounce");

const outsideApproach = rangeFixture({ outsideApproach: true });
assert.equal(evidence(outsideApproach).approachedFromInterior, false);
assert.notEqual(classify(outsideApproach), "Range bounce");

const narrowRange = rangeFixture({ rangeHigh: 99.5 });
assert.ok(evidence(narrowRange).rangeWidthAtr < RANGE_BOUNCE_MIN_WIDTH_ATR);
assert.notEqual(classify(narrowRange), "Range bounce");

const poorRangeQuality = rangeFixture({ poorInsideRatio: true });
assert.ok(evidence(poorRangeQuality).recentInsideRatio < RANGE_BOUNCE_MIN_INSIDE_RATIO);
assert.notEqual(classify(poorRangeQuality), "Range bounce");

const futureBoundary = rangeFixture();
futureBoundary.rangeHighTime = futureBoundary.candles.at(-2).time;
assert.equal(evidence(futureBoundary).qualified, false);
assert.notEqual(classify(futureBoundary), "Range bounce");

const dualBoundary = rangeFixture({
  rangeHigh: 100,
  interaction: { open: 96.5, high: 99.8, low: 95.2, close: 98 }
});
assert.equal(evidence(dualBoundary).ambiguousDualBoundaryTest, true);
assert.notEqual(classify(dualBoundary), "Range bounce");
assert.notEqual(classify(mirrorFixture(dualBoundary)), "Range bounce");

const nextCandleConfirmation = rangeFixture({ confirmationAfterInteraction: true });
const nextCandleEvidence = evidence(nextCandleConfirmation);
assert.equal(nextCandleEvidence.qualified, true);
assert.equal(nextCandleEvidence.ageCandles, 1);
assert.equal(nextCandleEvidence.interactionCandle.time, nextCandleConfirmation.candles.at(-2).time);
assert.equal(nextCandleEvidence.confirmationCandle.time, nextCandleConfirmation.candles.at(-1).time);

const supportRetestOnly = rangeFixture({ omitUpperBoundary: true, regimeLabel: "Trend Up" });
supportRetestOnly.ema20 = 95.5;
supportRetestOnly.ema50 = 94;
assert.equal(classify(supportRetestOnly), "Support/resistance retest");

const meanOnly = rangeFixture({ omitUpperBoundary: true, regimeLabel: "High Volatility" });
meanOnly.ema20 = 100;
meanOnly.ema50 = 99;
meanOnly.rsi14 = 46;
meanOnly.rangeLow = 95;
assert.equal(classify(meanOnly), "Mean reversion");

const longEvidence = evidence(cleanLong);
const shortEvidence = evidence(cleanShort);
assert.equal(longEvidence.qualified, true);
assert.equal(shortEvidence.qualified, true);
assert.equal(longEvidence.rangeLow + shortEvidence.rangeHigh, 200);
assert.equal(longEvidence.rangeHigh + shortEvidence.rangeLow, 200);
assert.equal(longEvidence.rangeMidpoint + shortEvidence.rangeMidpoint, 200);
assert.equal(longEvidence.rangeWidthAtr, shortEvidence.rangeWidthAtr);
assert.equal(longEvidence.interactionDistanceAtr, shortEvidence.interactionDistanceAtr);
assert.equal(longEvidence.recentInsideRatio, shortEvidence.recentInsideRatio);
assert.equal(longEvidence.invalidationLevel + shortEvidence.invalidationLevel, 200);
assert.equal(longEvidence.confirmationDirection, "long");
assert.equal(shortEvidence.confirmationDirection, "short");

assert.match(generatorSource, /setupType === "Range bounce"[\s\S]*?evaluateRangeBounceSetup/);
assert.match(generatorSource, /strategyEvidence: bestCase\.strategyEvidence/);
assert.match(generatorSource, /serializeIndicators\([\s\S]*?bestCase\.strategyEvidence/);
const riskCall = generatorSource.match(/buildDynamicRiskPlan\(\{[\s\S]*?\}\);/)?.[0] || "";
assert.doesNotMatch(riskCall, /strategyEvidence/, "Range evidence must not feed the risk engine");

console.log(JSON.stringify({
  oldRule: {
    regime: "Range",
    levelStrength: 2,
    maximumCloseDistanceAtr: 1.35,
    directionalLatestCandle: true,
    completeRangeRequired: false,
    actualBoundaryTestRequired: false,
    freshness: null
  },
  newRule: {
    minimumRangeWidthAtr: RANGE_BOUNCE_MIN_WIDTH_ATR,
    interactionToleranceAtr: RANGE_BOUNCE_INTERACTION_TOLERANCE_ATR,
    minimumRecentInsideRatio: RANGE_BOUNCE_MIN_INSIDE_RATIO,
    priorInsideApproach: true,
    closeInsideRange: true,
    movementTowardMidpoint: true,
    maximumAgeCandles: RANGE_BOUNCE_MAX_AGE_CANDLES,
    dualBoundaryInteraction: "ambiguous_rejected"
  },
  mirroredEvidence: { long: longEvidence, short: shortEvidence },
  rejectedFalsePositives: [
    "missing_second_boundary",
    "near_without_touch",
    "close_outside_range",
    "continued_breakout",
    "wrong_direction",
    "stale_bounce",
    "approach_from_outside",
    "narrow_range",
    "poor_inside_ratio",
    "future_derived_boundary",
    "dual_boundary_ambiguity"
  ],
  classifierSeparation: {
    supportRetestWithoutRange: classify(supportRetestOnly),
    meanReversionWithoutRange: classify(meanOnly)
  }
}, null, 2));
console.log("Range Bounce focused tests passed.");

function evidence(fixture) {
  return evaluateRangeBounceSetup(
    fixture.direction,
    fixture.candles,
    indicators(fixture),
    levels(fixture),
    { label: fixture.regimeLabel, trendStrength: fixture.trendStrength }
  );
}

function classify(fixture) {
  return classifySetupType(
    fixture.direction,
    fixture.candles,
    indicators(fixture),
    levels(fixture),
    { label: fixture.regimeLabel, trendStrength: fixture.trendStrength }
  );
}

function indicators(fixture) {
  return {
    ema20: fixture.ema20,
    ema50: fixture.ema50,
    rsi14: fixture.rsi14,
    atr14: fixture.atr14,
    volumeMa20: 100
  };
}

function levels(fixture) {
  return {
    nearestSupport: fixture.omitLowerBoundary ? null : {
      price: fixture.rangeLow,
      time: fixture.rangeLowTime
    },
    nearestResistance: fixture.omitUpperBoundary ? null : {
      price: fixture.rangeHigh,
      time: fixture.rangeHighTime
    },
    supportStrength: fixture.lowerStrength,
    resistanceStrength: fixture.upperStrength
  };
}

function oldRangeBounce(fixture) {
  const latest = fixture.candles.at(-1);
  const testedBoundary = fixture.direction === "long" ? fixture.rangeLow : fixture.rangeHigh;
  const strength = fixture.direction === "long" ? fixture.lowerStrength : fixture.upperStrength;
  const directional = fixture.direction === "long" ? latest.close > latest.open : latest.close < latest.open;
  return fixture.regimeLabel === "Range" &&
    strength >= 2 &&
    Math.abs(latest.close - testedBoundary) <= fixture.atr14 * 1.35 &&
    directional;
}

function rangeFixture(options = {}) {
  const start = 1_800_000_000;
  const candles = Array.from({ length: 32 }, (_, index) => ({
    time: start + index * 900,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100
  }));
  candles[8] = makeCandle(start, 8, { open: 97, high: 98, low: 95, close: 96.5 });
  candles[12] = makeCandle(start, 12, { open: 103, high: 105, low: 102, close: 103.5 });
  candles[29] = makeCandle(start, 29, { open: 100, high: 100.5, low: 99.5, close: options.outsideApproach ? 94 : 100 });
  candles[30] = makeCandle(start, 30, { open: 100, high: 100.5, low: 96.5, close: 97 });

  if (options.staleInteraction) {
    candles[29] = makeCandle(start, 29, { open: 96.8, high: 98.5, low: 95.2, close: 97.5 });
    candles[30] = makeCandle(start, 30, { open: 97.5, high: 99, low: 97.3, close: 98.5 });
    candles[31] = makeCandle(start, 31, { open: 98.5, high: 100, low: 98.3, close: 99.5 });
  } else if (options.confirmationAfterInteraction) {
    candles[29] = makeCandle(start, 29, { open: 100, high: 100.5, low: 96.5, close: 97 });
    candles[30] = makeCandle(start, 30, { open: 97, high: 97.4, low: 95.2, close: 96.5 });
    candles[31] = makeCandle(start, 31, { open: 96.5, high: 98.8, low: 96.3, close: 98.5 });
  } else {
    candles[31] = makeCandle(start, 31, options.interaction || { open: 96.8, high: 98.5, low: 95.2, close: 97.5 });
  }

  if (options.poorInsideRatio) {
    for (let index = 18; index < 29; index += 1) candles[index].close = 110;
    candles[29].close = 100;
    candles[30].close = 97;
  }

  return {
    direction: "long",
    candles,
    ema20: 100,
    ema50: 99,
    rsi14: 50,
    atr14: 2,
    rangeLow: options.rangeLow ?? 95,
    rangeHigh: options.rangeHigh ?? 105,
    rangeLowTime: candles[8].time,
    rangeHighTime: candles[12].time,
    lowerStrength: 3,
    upperStrength: 3,
    omitLowerBoundary: options.omitLowerBoundary || false,
    omitUpperBoundary: options.omitUpperBoundary || false,
    regimeLabel: options.regimeLabel || "Range",
    trendStrength: 0.25
  };
}

function makeCandle(start, index, values) {
  return { time: start + index * 900, volume: 130, ...values };
}

function mirrorFixture(fixture, pivot = 100) {
  const mirror = (value) => pivot * 2 - Number(value);
  return {
    ...fixture,
    direction: "short",
    candles: fixture.candles.map((item) => ({
      ...item,
      open: mirror(item.open),
      high: mirror(item.low),
      low: mirror(item.high),
      close: mirror(item.close)
    })),
    ema20: mirror(fixture.ema20),
    ema50: mirror(fixture.ema50),
    rsi14: 100 - fixture.rsi14,
    rangeLow: mirror(fixture.rangeHigh),
    rangeHigh: mirror(fixture.rangeLow),
    rangeLowTime: fixture.rangeHighTime,
    rangeHighTime: fixture.rangeLowTime,
    lowerStrength: fixture.upperStrength,
    upperStrength: fixture.lowerStrength
  };
}
