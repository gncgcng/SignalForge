import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SUPPORT_RESISTANCE_RETEST_MAX_AGE_CANDLES,
  SUPPORT_RESISTANCE_RETEST_MIN_LEVEL_STRENGTH,
  SUPPORT_RESISTANCE_RETEST_MIN_SEPARATION_ATR,
  SUPPORT_RESISTANCE_RETEST_TOLERANCE_ATR,
  classifySetupType,
  evaluateSupportResistanceRetestSetup
} from "../src/modules/signals/signalGenerator.js";

const generatorSource = await readFile(new URL("../src/modules/signals/signalGenerator.js", import.meta.url), "utf8");
const cleanLong = retestFixture();
const cleanShort = mirrorFixture(cleanLong);

assert.equal(SUPPORT_RESISTANCE_RETEST_TOLERANCE_ATR, 0.35);
assert.equal(SUPPORT_RESISTANCE_RETEST_MIN_SEPARATION_ATR, 0.75);
assert.equal(SUPPORT_RESISTANCE_RETEST_MAX_AGE_CANDLES, 1);
assert.equal(SUPPORT_RESISTANCE_RETEST_MIN_LEVEL_STRENGTH, 2);
assert.equal(oldSupportResistanceRetest(cleanLong), true);
assert.equal(classify(cleanLong), "Support/resistance retest");
assert.equal(classify(cleanShort), "Support/resistance retest");

const noTouch = retestFixture({
  interaction: { open: 102.2, high: 103, low: 102.1, close: 102.6 },
  ema20: 100.5
});
assert.equal(oldSupportResistanceRetest(noTouch), true, "characterization: the old 1.35 ATR proximity rule accepted no touch");
assert.notEqual(classify(noTouch), "Support/resistance retest");

const noSeparation = retestFixture({ nearLevelBeforeRetest: true });
const noSeparationEvidence = evidence(noSeparation);
assert.equal(noSeparationEvidence.priorSeparated, false);
assert.notEqual(classify(noSeparation), "Support/resistance retest");

const deepBreak = retestFixture({
  interaction: { open: 99.2, high: 101.8, low: 98.8, close: 101.4 }
});
assert.equal(evidence(deepBreak).heldLevel, false);
assert.notEqual(classify(deepBreak), "Support/resistance retest");
assert.notEqual(classify(mirrorFixture(deepBreak)), "Support/resistance retest");

const wrongConfirmation = retestFixture({
  interaction: { open: 102, high: 102.2, low: 100.2, close: 101 }
});
assert.equal(evidence(wrongConfirmation).confirmationDirection, null);
assert.notEqual(classify(wrongConfirmation), "Support/resistance retest");
assert.notEqual(classify(mirrorFixture(wrongConfirmation)), "Support/resistance retest");

const nextCandleConfirmation = retestFixture({ confirmationAfterInteraction: true });
const nextCandleEvidence = evidence(nextCandleConfirmation);
assert.equal(nextCandleEvidence.qualified, true);
assert.equal(nextCandleEvidence.ageCandles, 1);
assert.equal(nextCandleEvidence.interactionCandle.time, nextCandleConfirmation.candles.at(-2).time);
assert.equal(nextCandleEvidence.confirmationCandle.time, nextCandleConfirmation.candles.at(-1).time);

const stale = retestFixture({ staleInteraction: true });
assert.equal(evidence(stale).qualified, false);
assert.notEqual(classify(stale), "Support/resistance retest");

const weakLevel = retestFixture({ levelStrength: 1 });
assert.equal(evidence(weakLevel).qualified, false);
assert.notEqual(classify(weakLevel), "Support/resistance retest");

const futureDerivedLevel = retestFixture();
futureDerivedLevel.level = { ...futureDerivedLevel.level, time: futureDerivedLevel.candles.at(-2).time };
assert.equal(evidence(futureDerivedLevel).levelPredatesInteraction, false);
assert.notEqual(classify(futureDerivedLevel), "Support/resistance retest");

const farDirectional = retestFixture({
  interaction: { open: 103.5, high: 104.8, low: 103.2, close: 104.5 }
});
assert.notEqual(classify(farDirectional), "Support/resistance retest");

const simpleContinuation = retestFixture({
  interaction: { open: 102.2, high: 103, low: 102.1, close: 102.6 },
  ema20: 100.5,
  trendStrength: 0.8
});
assert.equal(classify(simpleContinuation), null, "a directional trend candle without a pause must not fall through as Trend continuation");

const continuationFallthrough = retestFixture({
  interaction: { open: 102.2, high: 103, low: 102.1, close: 102.6 },
  ema20: 100.5,
  confluenceContext: {
    lowerTimeframe: "15m",
    higherTimeframes: [
      { timeframe: "1h", available: true, regime: { preferredDirection: "long" } },
      { timeframe: "4h", available: true, regime: { preferredDirection: "long" } }
    ]
  }
});
assert.equal(classify(continuationFallthrough), "Multi-timeframe continuation");

const longEvidence = evidence(cleanLong);
const shortEvidence = evidence(cleanShort);
assert.equal(longEvidence.qualified, true);
assert.equal(shortEvidence.qualified, true);
assert.equal(longEvidence.levelType, "support");
assert.equal(shortEvidence.levelType, "resistance");
assert.equal(longEvidence.levelPrice + shortEvidence.levelPrice, 200);
assert.equal(longEvidence.interactionDistanceAtr, shortEvidence.interactionDistanceAtr);
assert.equal(longEvidence.priorSeparationAtr, shortEvidence.priorSeparationAtr);
assert.equal(longEvidence.toleranceAtr, shortEvidence.toleranceAtr);
assert.equal(longEvidence.ageCandles, shortEvidence.ageCandles);
assert.equal(longEvidence.invalidationLevel + shortEvidence.invalidationLevel, 200);
assert.equal(longEvidence.confirmationDirection, "long");
assert.equal(shortEvidence.confirmationDirection, "short");

assert.match(generatorSource, /setupType === "Support\/resistance retest"[\s\S]*?evaluateSupportResistanceRetestSetup/);
assert.match(generatorSource, /strategyEvidence: bestCase\.strategyEvidence/);
assert.match(generatorSource, /serializeIndicators\([\s\S]*?bestCase\.strategyEvidence/);
const riskCall = generatorSource.match(/buildDynamicRiskPlan\(\{[\s\S]*?\}\);/)?.[0] || "";
assert.doesNotMatch(riskCall, /strategyEvidence/, "S/R evidence must not feed the generic risk engine");

console.log(JSON.stringify({
  oldRule: {
    alignedEma: true,
    maximumCloseDistanceAtr: 1.35,
    actualInteractionRequired: false,
    priorSeparationRequired: false,
    rejectionRequired: false,
    directionalLatestCandle: true
  },
  newRule: {
    existingLevelStrength: SUPPORT_RESISTANCE_RETEST_MIN_LEVEL_STRENGTH,
    boundedInteractionZoneAtr: SUPPORT_RESISTANCE_RETEST_TOLERANCE_ATR,
    priorSeparationAtr: SUPPORT_RESISTANCE_RETEST_MIN_SEPARATION_ATR,
    maximumInteractionAgeCandles: SUPPORT_RESISTANCE_RETEST_MAX_AGE_CANDLES,
    validSideClose: true,
    sameOrNextCandleDirectionalConfirmation: true
  },
  mirroredEvidence: { long: longEvidence, short: shortEvidence },
  rejectedFalsePositives: [
    "near_without_touch",
    "no_prior_separation",
    "deep_invalidation",
    "wrong_direction_confirmation",
    "stale_interaction",
    "weak_level",
    "future_derived_level",
    "far_directional_candle"
  ],
  fallthrough: {
    simpleContinuation: classify(simpleContinuation),
    higherTimeframeContinuation: classify(continuationFallthrough)
  }
}, null, 2));
console.log("Support/resistance Retest focused tests passed.");

function evidence(fixture) {
  return evaluateSupportResistanceRetestSetup(
    fixture.direction,
    fixture.candles,
    { atr14: fixture.atr14 },
    levels(fixture)
  );
}

function classify(fixture) {
  return classifySetupType(
    fixture.direction,
    fixture.candles,
    {
      ema20: fixture.ema20,
      ema50: fixture.ema50,
      rsi14: fixture.rsi14,
      atr14: fixture.atr14,
      volumeMa20: 100
    },
    levels(fixture),
    {
      label: fixture.direction === "long" ? "Trend Up" : "Trend Down",
      trendStrength: fixture.trendStrength
    },
    null,
    null,
    fixture.confluenceContext
  );
}

function levels(fixture) {
  const long = fixture.direction === "long";
  return {
    nearestSupport: long ? fixture.level : { price: 90, time: fixture.candles[4].time },
    nearestResistance: long ? { price: 115, time: fixture.candles[4].time } : fixture.level,
    supportStrength: long ? fixture.levelStrength : 3,
    resistanceStrength: long ? 3 : fixture.levelStrength
  };
}

function oldSupportResistanceRetest(fixture) {
  const latest = fixture.candles.at(-1);
  const activeLevel = fixture.level;
  const aligned = fixture.direction === "long"
    ? latest.close > fixture.ema20 && fixture.ema20 > fixture.ema50
    : latest.close < fixture.ema20 && fixture.ema20 < fixture.ema50;
  const nearLevel = Math.abs(latest.close - activeLevel.price) <= fixture.atr14 * 1.35;
  const directional = fixture.direction === "long" ? latest.close > latest.open : latest.close < latest.open;
  return aligned && nearLevel && directional;
}

function retestFixture(options = {}) {
  const start = 1_780_000_000;
  const candles = Array.from({ length: 30 }, (_, index) => ({
    time: start + index * 900,
    open: 103.5,
    high: 104.5,
    low: 103,
    close: options.nearLevelBeforeRetest && index >= 10 ? 100.6 : 104,
    volume: 100
  }));
  candles[8] = { time: start + 8 * 900, open: 101, high: 102, low: 100, close: 101.4, volume: 120 };

  if (options.staleInteraction) {
    candles[27] = makeCandle(start, 27, options.interaction || { open: 101.2, high: 103, low: 100.2, close: 102.6 });
    candles[28] = makeCandle(start, 28, { open: 102.6, high: 103.5, low: 102.3, close: 103.2 });
    candles[29] = makeCandle(start, 29, { open: 103.2, high: 104, low: 103, close: 103.7 });
  } else if (options.confirmationAfterInteraction) {
    candles[28] = makeCandle(start, 28, { open: 101.4, high: 101.8, low: 100.2, close: 100.8 });
    candles[29] = makeCandle(start, 29, { open: 101.1, high: 103.2, low: 101, close: 102.8 });
  } else {
    candles[29] = makeCandle(start, 29, options.interaction || { open: 101.2, high: 103, low: 100.2, close: 102.6 });
  }

  return {
    direction: "long",
    candles,
    level: { price: 100, time: candles[8].time, source: "Swing low" },
    levelStrength: options.levelStrength ?? 3,
    atr14: 2,
    ema20: options.ema20 ?? 100.9,
    ema50: 99,
    rsi14: 55,
    trendStrength: options.trendStrength ?? 0.45,
    confluenceContext: options.confluenceContext || null
  };
}

function makeCandle(start, index, values) {
  return { time: start + index * 900, volume: 140, ...values };
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
    level: { ...fixture.level, price: mirror(fixture.level.price) },
    ema20: mirror(fixture.ema20),
    ema50: mirror(fixture.ema50),
    rsi14: 100 - fixture.rsi14,
    confluenceContext: fixture.confluenceContext ? {
      higherTimeframes: [{ available: true, regime: { preferredDirection: "short" } }]
    } : null
  };
}
