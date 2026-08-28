import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MEAN_REVERSION_MAX_AGE_CANDLES,
  MEAN_REVERSION_MIN_EXTENSION_ATR,
  MEAN_REVERSION_STRUCTURE_TOLERANCE_ATR,
  classifySetupType,
  evaluateMeanReversionSetup
} from "../src/modules/signals/signalGenerator.js";

const generatorSource = await readFile(new URL("../src/modules/signals/signalGenerator.js", import.meta.url), "utf8");
const cleanLong = meanFixture();
const cleanShort = mirrorFixture(cleanLong);

assert.equal(MEAN_REVERSION_MIN_EXTENSION_ATR, 0.8);
assert.equal(MEAN_REVERSION_STRUCTURE_TOLERANCE_ATR, 1.35);
assert.equal(MEAN_REVERSION_MAX_AGE_CANDLES, 1);
assert.equal(oldMeanReversion(cleanLong), true);
assert.equal(classify(cleanLong), "Mean reversion");
assert.equal(classify(cleanShort), "Mean reversion");

const bearishLong = meanFixture({
  latest: { open: 98.2, high: 98.4, low: 96.4, close: 97.4 }
});
assert.equal(oldMeanReversion(bearishLong), true, "characterization: old LONG Mean reversion accepted a bearish trigger");
assert.equal(evidence(bearishLong).movedTowardMean, false);
assert.notEqual(classify(bearishLong), "Mean reversion");

const bullishShort = mirrorFixture(bearishLong);
assert.equal(oldMeanReversion(bullishShort), true, "characterization: old SHORT Mean reversion accepted a bullish trigger");
assert.notEqual(classify(bullishShort), "Mean reversion");

const noExtension = meanFixture({
  levelPrice: 98,
  latest: { open: 99.3, high: 99.8, low: 99.2, close: 99.6 }
});
assert.equal(oldMeanReversion(noExtension), true);
assert.ok(evidence(noExtension).distanceFromMeanAtr < MEAN_REVERSION_MIN_EXTENSION_ATR);
assert.notEqual(classify(noExtension), "Mean reversion");

const movingAway = meanFixture({ previousReversal: true });
const movingAwayEvidence = evidence(movingAway);
assert.equal(movingAwayEvidence.qualified, false);
assert.notEqual(classify(movingAway), "Mean reversion");

const nearSupportNoReversal = meanFixture({
  latest: { open: 98.2, high: 98.4, low: 96.4, close: 97.4 }
});
assert.notEqual(classify(nearSupportNoReversal), "Mean reversion");

const stale = meanFixture({ staleReversal: true });
assert.equal(evidence(stale).qualified, false);
assert.notEqual(classify(stale), "Mean reversion");

const wrongRsi = meanFixture({ rsi14: 55 });
assert.equal(evidence(wrongRsi).rsiSupported, false);
assert.notEqual(classify(wrongRsi), "Mean reversion");

const weakLevel = meanFixture({ levelStrength: 1 });
assert.equal(evidence(weakLevel).qualified, false);
assert.notEqual(classify(weakLevel), "Mean reversion");

const farFromStructure = meanFixture({ levelPrice: 90 });
assert.ok(evidence(farFromStructure).structuralDistanceAtr > MEAN_REVERSION_STRUCTURE_TOLERANCE_ATR);
assert.notEqual(classify(farFromStructure), "Mean reversion");

for (const regimeLabel of ["Trend Up", "Trend Down", "Breakout"]) {
  const disallowed = meanFixture({ regimeLabel });
  assert.equal(evidence(disallowed).regimeAllowed, false);
  assert.notEqual(classify(disallowed), "Mean reversion");
}

const rangeWithoutExtension = rangeBounceFixture();
assert.equal(classify(rangeWithoutExtension), "Range bounce");

const nextCandleConfirmation = meanFixture({ confirmationAfterReversal: true });
const nextCandleEvidence = evidence(nextCandleConfirmation);
assert.equal(nextCandleEvidence.qualified, true);
assert.equal(nextCandleEvidence.ageCandles, 1);
assert.equal(nextCandleEvidence.reversalCandle.time, nextCandleConfirmation.candles.at(-2).time);
assert.equal(nextCandleEvidence.confirmationCandle.time, nextCandleConfirmation.candles.at(-1).time);

const longEvidence = evidence(cleanLong);
const shortEvidence = evidence(cleanShort);
assert.equal(longEvidence.qualified, true);
assert.equal(shortEvidence.qualified, true);
assert.equal(longEvidence.meanReferenceType, "EMA20");
assert.equal(shortEvidence.meanReferenceType, "EMA20");
assert.equal(longEvidence.meanReferencePrice + shortEvidence.meanReferencePrice, 200);
assert.equal(longEvidence.distanceFromMeanAtr, shortEvidence.distanceFromMeanAtr);
assert.equal(longEvidence.currentDistanceFromMeanAtr, shortEvidence.currentDistanceFromMeanAtr);
assert.equal(longEvidence.structuralLevel + shortEvidence.structuralLevel, 200);
assert.equal(longEvidence.invalidationLevel + shortEvidence.invalidationLevel, 200);
assert.equal(longEvidence.confirmationDirection, "long");
assert.equal(shortEvidence.confirmationDirection, "short");

assert.match(generatorSource, /setupType === "Mean reversion"[\s\S]*?evaluateMeanReversionSetup/);
assert.match(generatorSource, /strategyEvidence: bestCase\.strategyEvidence/);
assert.match(generatorSource, /serializeIndicators\([\s\S]*?bestCase\.strategyEvidence/);
const riskCall = generatorSource.match(/buildDynamicRiskPlan\(\{[\s\S]*?\}\);/)?.[0] || "";
assert.doesNotMatch(riskCall, /strategyEvidence/, "Mean evidence must remain diagnostic and must not feed the risk engine");

console.log(JSON.stringify({
  oldRule: {
    meanReference: null,
    longRsi: "32-48",
    shortRsi: "52-68",
    levelStrength: 2,
    maximumCloseDistanceAtr: 1.35,
    directionalConfirmation: false,
    freshness: null
  },
  newRule: {
    meanReference: "EMA20",
    minimumExtensionAtr: MEAN_REVERSION_MIN_EXTENSION_ATR,
    structuralToleranceAtr: MEAN_REVERSION_STRUCTURE_TOLERANCE_ATR,
    longRsi: "32-48",
    shortRsi: "52-68",
    reversalConfirmation: "same candle or immediately following candle",
    maximumAgeCandles: MEAN_REVERSION_MAX_AGE_CANDLES,
    movementTowardMeanRequired: true,
    disallowedRegimes: ["Trend Up", "Trend Down", "Breakout"]
  },
  mirroredEvidence: { long: longEvidence, short: shortEvidence },
  rejectedFalsePositives: [
    "bearish_long_trigger",
    "bullish_short_trigger",
    "no_mean_extension",
    "continued_move_away",
    "stale_reversal",
    "wrong_rsi",
    "weak_level",
    "far_from_structure",
    "trend_or_breakout_regime"
  ],
  classifierFallthrough: {
    rangeBoundaryWithoutMeanExtension: classify(rangeWithoutExtension)
  }
}, null, 2));
console.log("Mean Reversion focused tests passed.");

function evidence(fixture) {
  return evaluateMeanReversionSetup(
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
  const long = fixture.direction === "long";
  if (Number.isFinite(fixture.rangeLow) && Number.isFinite(fixture.rangeHigh)) {
    return {
      nearestSupport: { price: fixture.rangeLow, time: fixture.rangeLowTime },
      nearestResistance: { price: fixture.rangeHigh, time: fixture.rangeHighTime },
      supportStrength: fixture.lowerStrength,
      resistanceStrength: fixture.upperStrength
    };
  }
  return {
    nearestSupport: long ? { price: fixture.levelPrice } : { price: 88 },
    nearestResistance: long ? { price: 112 } : { price: fixture.levelPrice },
    supportStrength: long ? fixture.levelStrength : 3,
    resistanceStrength: long ? 3 : fixture.levelStrength
  };
}

function rangeBounceFixture() {
  const start = 1_800_100_000;
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
  candles[29] = makeCandle(start, 29, { open: 100, high: 100.5, low: 99.5, close: 100 });
  candles[30] = makeCandle(start, 30, { open: 100, high: 100.5, low: 96.5, close: 97 });
  candles[31] = makeCandle(start, 31, { open: 96.8, high: 98.5, low: 95.2, close: 97.5 });
  return {
    direction: "long",
    candles,
    ema20: 100,
    ema50: 99,
    rsi14: 50,
    atr14: 2,
    rangeLow: 95,
    rangeHigh: 105,
    rangeLowTime: candles[8].time,
    rangeHighTime: candles[12].time,
    lowerStrength: 3,
    upperStrength: 3,
    regimeLabel: "Range",
    trendStrength: 0.25
  };
}

function oldMeanReversion(fixture) {
  const latest = fixture.candles.at(-1);
  const rsiSupported = fixture.direction === "long"
    ? fixture.rsi14 >= 32 && fixture.rsi14 <= 48
    : fixture.rsi14 >= 52 && fixture.rsi14 <= 68;
  return fixture.levelStrength >= 2 &&
    rsiSupported &&
    Math.abs(latest.close - fixture.levelPrice) <= fixture.atr14 * 1.35;
}

function meanFixture(options = {}) {
  const start = 1_790_000_000;
  const candles = Array.from({ length: 30 }, (_, index) => ({
    time: start + index * 900,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100
  }));
  if (options.staleReversal) {
    candles[27] = makeCandle(start, 27, { open: 97, high: 98.6, low: 96.4, close: 98.2 });
    candles[28] = makeCandle(start, 28, { open: 98.2, high: 98.4, low: 97.4, close: 97.8 });
    candles[29] = makeCandle(start, 29, { open: 97.8, high: 98, low: 97, close: 97.4 });
  } else if (options.confirmationAfterReversal) {
    candles[28] = makeCandle(start, 28, { open: 97, high: 98.2, low: 96.4, close: 97.8 });
    candles[29] = makeCandle(start, 29, { open: 98.5, high: 99.3, low: 98.5, close: 99.1 });
  } else if (options.previousReversal) {
    candles[28] = makeCandle(start, 28, { open: 97, high: 98.2, low: 96.4, close: 98 });
    candles[29] = makeCandle(start, 29, { open: 93, high: 97.2, low: 92, close: 97 });
  } else {
    candles[29] = makeCandle(start, 29, options.latest || { open: 97, high: 98.6, low: 96.4, close: 98.2 });
  }
  return {
    direction: "long",
    candles,
    ema20: 100,
    ema50: 99,
    rsi14: options.rsi14 ?? 46,
    atr14: 2,
    levelPrice: options.levelPrice ?? 96,
    levelStrength: options.levelStrength ?? 3,
    regimeLabel: options.regimeLabel || "High Volatility",
    trendStrength: 0.35
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
    levelPrice: mirror(fixture.levelPrice)
  };
}
