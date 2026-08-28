import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PULLBACK_BOUNCE_INTERACTION_TOLERANCE_ATR,
  PULLBACK_BOUNCE_MAX_AGE_CANDLES,
  PULLBACK_BOUNCE_MIN_CONFIRMATION_MOVE_ATR,
  PULLBACK_BOUNCE_MIN_PRIOR_EXTENSION_ATR,
  PULLBACK_BOUNCE_SEQUENCE_CANDLES,
  classifySetupType,
  evaluatePullbackBounceSetup
} from "../src/modules/signals/signalGenerator.js";

const generatorSource = await readFile(new URL("../src/modules/signals/signalGenerator.js", import.meta.url), "utf8");
const cleanLong = pullbackFixture();
const cleanShort = mirrorFixture(cleanLong);

assert.equal(PULLBACK_BOUNCE_MIN_PRIOR_EXTENSION_ATR, 0.8);
assert.equal(PULLBACK_BOUNCE_INTERACTION_TOLERANCE_ATR, 0.35);
assert.equal(PULLBACK_BOUNCE_MIN_CONFIRMATION_MOVE_ATR, 0.25);
assert.equal(PULLBACK_BOUNCE_MAX_AGE_CANDLES, 1);
assert.equal(PULLBACK_BOUNCE_SEQUENCE_CANDLES, 2);
assert.equal(oldPullbackBounce(cleanLong), true);
assert.equal(classify(cleanLong), "Pullback bounce");
assert.equal(classify(cleanShort), "Pullback bounce");

const proximityOnly = pullbackFixture({ noPullback: true });
assert.equal(oldPullbackBounce(proximityOnly), true, "characterization: old rule accepted EMA proximity without a pullback");
assert.equal(evidence(proximityOnly).qualified, false);
assert.equal(classify(proximityOnly), null, "persistent EMA proximity without a pause/resumption event must not fall through as Trend continuation");

const noTouch = pullbackFixture({ noTouch: true });
assert.equal(oldPullbackBounce(noTouch), true, "characterization: old rule checked close proximity rather than an EMA interaction");
assert.notEqual(classify(noTouch), "Pullback bounce");

const sideways = pullbackFixture({ sidewaysPullback: true });
assert.equal(evidence(sideways).qualified, false);
assert.notEqual(classify(sideways), "Pullback bounce");

const deepFailure = pullbackFixture({ deepFailure: true });
assert.equal(evidence(deepFailure).ambiguousEmaCross, true);
assert.equal(evidence(deepFailure).heldTrendSupport, false);
assert.notEqual(classify(deepFailure), "Pullback bounce");
assert.notEqual(classify(mirrorFixture(deepFailure)), "Pullback bounce");

const wrongDirection = pullbackFixture({ wrongDirection: true });
assert.equal(evidence(wrongDirection).movedAwayFromEma, false);
assert.notEqual(classify(wrongDirection), "Pullback bounce");

const stale = pullbackFixture({ staleInteraction: true });
assert.equal(evidence(stale).qualified, false);
assert.notEqual(classify(stale), "Pullback bounce");

const noExtension = pullbackFixture({ noExtension: true });
assert.ok(evidence(noExtension).priorExtensionAtr < PULLBACK_BOUNCE_MIN_PRIOR_EXTENSION_ATR);
assert.notEqual(classify(noExtension), "Pullback bounce");

const stuckAtEma = pullbackFixture({ weakConfirmationMove: true });
assert.ok(evidence(stuckAtEma).confirmationMoveAtr < PULLBACK_BOUNCE_MIN_CONFIRMATION_MOVE_ATR);
assert.notEqual(classify(stuckAtEma), "Pullback bounce");

const wrongRegime = pullbackFixture({ regimeLabel: "High Volatility" });
assert.equal(evidence(wrongRegime).qualified, false);
assert.notEqual(classify(wrongRegime), "Pullback bounce");

const brokenHierarchy = pullbackFixture({ ema50: 100.2 });
assert.equal(evidence(brokenHierarchy).qualified, false);
assert.notEqual(classify(brokenHierarchy), "Pullback bounce");

const nextCandleConfirmation = pullbackFixture({ confirmationAfterInteraction: true });
const nextEvidence = evidence(nextCandleConfirmation);
assert.equal(nextEvidence.qualified, true);
assert.equal(nextEvidence.ageCandles, 1);
assert.equal(nextEvidence.interactionCandle.time, nextCandleConfirmation.candles.at(-2).time);
assert.equal(nextEvidence.confirmationCandle.time, nextCandleConfirmation.candles.at(-1).time);

const meanReversion = meanReversionFixture();
assert.equal(evidence(meanReversion).qualified, false);
assert.equal(classify(meanReversion), "Mean reversion");

const longEvidence = evidence(cleanLong);
const shortEvidence = evidence(cleanShort);
assert.equal(longEvidence.qualified, true);
assert.equal(shortEvidence.qualified, true);
assert.equal(longEvidence.ema20 + shortEvidence.ema20, 200);
assert.equal(longEvidence.ema50 + shortEvidence.ema50, 200);
assertApprox(longEvidence.priorExtensionAtr, shortEvidence.priorExtensionAtr);
assertApprox(longEvidence.pullbackDepthAtr, shortEvidence.pullbackDepthAtr);
assertApprox(longEvidence.interactionDistanceAtr, shortEvidence.interactionDistanceAtr);
assertApprox(longEvidence.confirmationMoveAtr, shortEvidence.confirmationMoveAtr);
assert.equal(longEvidence.invalidationLevel + shortEvidence.invalidationLevel, 200);
assert.equal(longEvidence.confirmationDirection, "long");
assert.equal(shortEvidence.confirmationDirection, "short");

assert.match(generatorSource, /setupType === "Pullback bounce"[\s\S]*?evaluatePullbackBounceSetup/);
assert.match(generatorSource, /strategyEvidence: bestCase\.strategyEvidence/);
assert.match(generatorSource, /serializeIndicators\([\s\S]*?bestCase\.strategyEvidence/);
const riskCall = generatorSource.match(/buildDynamicRiskPlan\(\{[\s\S]*?\}\);/)?.[0] || "";
assert.doesNotMatch(riskCall, /strategyEvidence/, "Pullback evidence must remain diagnostic and must not feed the risk engine");

console.log(JSON.stringify({
  oldRule: {
    emaAlignment: true,
    maximumLatestCloseDistanceAtr: 0.8,
    directionalLatestCandle: true,
    trendRegimeRequired: false,
    priorExtensionRequired: false,
    countertrendSequenceRequired: false,
    actualEmaInteractionRequired: false,
    freshness: null
  },
  newRule: {
    trendRegime: "Trend Up / Trend Down",
    priorExtensionAtr: PULLBACK_BOUNCE_MIN_PRIOR_EXTENSION_ATR,
    countertrendCandles: PULLBACK_BOUNCE_SEQUENCE_CANDLES,
    interactionToleranceAtr: PULLBACK_BOUNCE_INTERACTION_TOLERANCE_ATR,
    minimumConfirmationMoveAtr: PULLBACK_BOUNCE_MIN_CONFIRMATION_MOVE_ATR,
    maximumAgeCandles: PULLBACK_BOUNCE_MAX_AGE_CANDLES,
    ema50Cross: "ambiguous_rejected"
  },
  mirroredEvidence: { long: longEvidence, short: shortEvidence },
  rejectedFalsePositives: [
    "ema_proximity_without_pullback",
    "near_ema_without_touch",
    "sideways_near_ema",
    "deep_ema20_ema50_failure",
    "wrong_direction_confirmation",
    "stale_interaction",
    "missing_prior_extension",
    "weak_move_away",
    "wrong_regime",
    "broken_ema_hierarchy",
    "mean_reversion_geometry"
  ],
  classifierFallthrough: {
    genericTrendWithoutPullback: classify(proximityOnly),
    meanReversionGeometry: classify(meanReversion)
  }
}, null, 2));
console.log("Pullback Bounce focused tests passed.");

function evidence(fixture) {
  return evaluatePullbackBounceSetup(
    fixture.direction,
    fixture.candles,
    indicators(fixture),
    levels(fixture),
    regime(fixture)
  );
}

function classify(fixture) {
  return classifySetupType(
    fixture.direction,
    fixture.candles,
    indicators(fixture),
    levels(fixture),
    regime(fixture)
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
    nearestSupport: fixture.nearestSupport,
    nearestResistance: fixture.nearestResistance,
    supportStrength: fixture.supportStrength,
    resistanceStrength: fixture.resistanceStrength
  };
}

function regime(fixture) {
  return {
    label: fixture.regimeLabel,
    trendStrength: fixture.trendStrength
  };
}

function oldPullbackBounce(fixture) {
  const latest = fixture.candles.at(-1);
  const aligned = fixture.direction === "long"
    ? latest.close > fixture.ema20 && fixture.ema20 > fixture.ema50
    : latest.close < fixture.ema20 && fixture.ema20 < fixture.ema50;
  return aligned &&
    Math.abs(latest.close - fixture.ema20) <= fixture.atr14 * 0.8 &&
    (fixture.direction === "long" ? latest.close > latest.open : latest.close < latest.open);
}

function pullbackFixture(options = {}) {
  const start = 1_810_000_000;
  const candles = Array.from({ length: 32 }, (_, index) => {
    const center = 98 + index * 0.08;
    return makeCandle(start, index, {
      open: center,
      high: center + 0.5,
      low: center - 0.4,
      close: center + 0.15
    });
  });

  candles[28] = makeCandle(start, 28, { open: 103, high: 104, low: 102.8, close: 103.5 });
  candles[29] = makeCandle(start, 29, { open: 103.4, high: 103.6, low: 102.3, close: 102.5 });
  candles[30] = makeCandle(start, 30, { open: 102.4, high: 102.6, low: 100.8, close: 101.1 });
  candles[31] = makeCandle(start, 31, { open: 100.4, high: 102, low: 99.8, close: 101.6 });

  if (options.noPullback) {
    candles[28] = makeCandle(start, 28, { open: 100.5, high: 101.4, low: 100.4, close: 101 });
    candles[29] = makeCandle(start, 29, { open: 101, high: 101.6, low: 100.9, close: 101.4 });
    candles[30] = makeCandle(start, 30, { open: 101.3, high: 101.7, low: 101.2, close: 101.5 });
  }
  if (options.noTouch) {
    candles[31] = makeCandle(start, 31, { open: 100.9, high: 102, low: 100.8, close: 101.6 });
  }
  if (options.sidewaysPullback) {
    candles[29] = makeCandle(start, 29, { open: 102.5, high: 102.8, low: 102.3, close: 102.5 });
    candles[30] = makeCandle(start, 30, { open: 101.2, high: 101.4, low: 101, close: 101.2 });
  }
  if (options.deepFailure) {
    candles[31] = makeCandle(start, 31, { open: 100.4, high: 102, low: 97.8, close: 101.6 });
  }
  if (options.wrongDirection) {
    candles[31] = makeCandle(start, 31, { open: 101.5, high: 101.7, low: 99.8, close: 100.3 });
  }
  if (options.staleInteraction) {
    candles[26] = makeCandle(start, 26, { open: 103, high: 104, low: 102.8, close: 103.5 });
    candles[27] = makeCandle(start, 27, { open: 103.4, high: 103.6, low: 102.3, close: 102.5 });
    candles[28] = makeCandle(start, 28, { open: 102.4, high: 102.6, low: 100.8, close: 101.1 });
    candles[29] = makeCandle(start, 29, { open: 100.4, high: 102, low: 99.8, close: 101.6 });
    candles[30] = makeCandle(start, 30, { open: 101.1, high: 101.8, low: 100.9, close: 101.5 });
    candles[31] = makeCandle(start, 31, { open: 101.4, high: 102, low: 101.3, close: 101.8 });
  }
  if (options.noExtension) {
    candles[28] = makeCandle(start, 28, { open: 100.3, high: 100.5, low: 100.2, close: 100.4 });
    candles[29] = makeCandle(start, 29, { open: 100.4, high: 100.5, low: 100.2, close: 100.3 });
    candles[30] = makeCandle(start, 30, { open: 100.3, high: 100.4, low: 100.1, close: 100.2 });
  }
  if (options.weakConfirmationMove) {
    candles[31] = makeCandle(start, 31, { open: 100.1, high: 100.5, low: 99.8, close: 100.3 });
  }
  if (options.confirmationAfterInteraction) {
    candles[27] = makeCandle(start, 27, { open: 103, high: 104, low: 102.8, close: 103.5 });
    candles[28] = makeCandle(start, 28, { open: 103.4, high: 103.6, low: 102.3, close: 102.5 });
    candles[29] = makeCandle(start, 29, { open: 102.4, high: 102.6, low: 100.8, close: 101.1 });
    candles[30] = makeCandle(start, 30, { open: 100.5, high: 100.8, low: 99.8, close: 100.2 });
    candles[31] = makeCandle(start, 31, { open: 100.9, high: 102, low: 100.8, close: 101.8 });
  }

  return {
    direction: "long",
    candles,
    ema20: 100,
    ema50: options.ema50 ?? 98,
    rsi14: 55,
    atr14: 2,
    nearestSupport: { price: 99.6 },
    nearestResistance: { price: 110 },
    supportStrength: 3,
    resistanceStrength: 3,
    regimeLabel: options.regimeLabel || "Trend Up",
    trendStrength: options.trendStrength ?? (options.noPullback ? 0.78 : 0.45)
  };
}

function meanReversionFixture() {
  const start = 1_820_000_000;
  const candles = Array.from({ length: 30 }, (_, index) => makeCandle(start, index, {
    open: 100,
    high: 101,
    low: 99,
    close: 100
  }));
  candles[29] = makeCandle(start, 29, { open: 97, high: 98.6, low: 96.4, close: 98.2 });
  return {
    direction: "long",
    candles,
    ema20: 100,
    ema50: 99,
    rsi14: 46,
    atr14: 2,
    nearestSupport: { price: 96 },
    nearestResistance: { price: 112 },
    supportStrength: 3,
    resistanceStrength: 3,
    regimeLabel: "High Volatility",
    trendStrength: 0.35
  };
}

function makeCandle(start, index, values) {
  return { time: start + index * 900, volume: 130, ...values };
}

function assertApprox(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected}`);
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
    nearestSupport: fixture.nearestResistance ? { ...fixture.nearestResistance, price: mirror(fixture.nearestResistance.price) } : null,
    nearestResistance: fixture.nearestSupport ? { ...fixture.nearestSupport, price: mirror(fixture.nearestSupport.price) } : null,
    supportStrength: fixture.resistanceStrength,
    resistanceStrength: fixture.supportStrength,
    regimeLabel: fixture.regimeLabel === "Trend Up" ? "Trend Down" : fixture.regimeLabel
  };
}
