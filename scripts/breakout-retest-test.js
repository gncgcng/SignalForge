import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BREAKOUT_RETEST_TOLERANCE_ATR,
  classifySetupType,
  evaluateBreakoutRetestSetup
} from "../src/modules/signals/signalGenerator.js";

const generatorSource = await readFile(new URL("../src/modules/signals/signalGenerator.js", import.meta.url), "utf8");
const cleanLong = breakoutFixture();
const cleanShort = mirrorFixture(cleanLong);

assert.equal(BREAKOUT_RETEST_TOLERANCE_ATR, 0.35);
assert.equal(oldBreakoutRetest("long", cleanLong, 2), true);
assert.equal(classify(cleanLong, "long"), "Breakout retest");
assert.equal(classify(cleanShort, "short"), "Breakout retest");

const wickOnly = breakoutFixture({
  breakout: { open: 104.7, high: 106.2, low: 104.5, close: 104.8 }
});
assert.equal(oldBreakoutRetest("long", wickOnly, 2), false);
assert.notEqual(classify(wickOnly, "long"), "Breakout retest");
assert.notEqual(classify(mirrorFixture(wickOnly), "short"), "Breakout retest");

const deepFailure = breakoutFixture({
  retest: { open: 104.9, high: 105.8, low: 98, close: 105.2 }
});
assert.equal(oldBreakoutRetest("long", deepFailure, 2), true, "characterization: the old one-sided rule accepted a deep failure");
assert.notEqual(classify(deepFailure, "long"), "Breakout retest");
assert.notEqual(classify(mirrorFixture(deepFailure), "short"), "Breakout retest");
assert.equal(evaluateBreakoutRetestSetup("long", deepFailure, { atr14: 2 }).heldLevel, false);

const wrongSideClose = breakoutFixture({
  retest: { open: 105.4, high: 105.7, low: 104.8, close: 104.9 }
});
assert.equal(oldBreakoutRetest("long", wrongSideClose, 2), false);
assert.notEqual(classify(wrongSideClose, "long"), "Breakout retest");
assert.notEqual(classify(mirrorFixture(wrongSideClose), "short"), "Breakout retest");

const noRetest = breakoutFixture({
  retest: { open: 106, high: 106.8, low: 105.9, close: 106.6 }
});
assert.equal(oldBreakoutRetest("long", noRetest, 2), false);
assert.notEqual(classify(noRetest, "long"), "Breakout retest");
assert.notEqual(classify(mirrorFixture(noRetest), "short"), "Breakout retest");

const wrongDirection = breakoutFixture({
  retest: { open: 106.4, high: 106.6, low: 105.1, close: 105.3 }
});
assert.equal(oldBreakoutRetest("long", wrongDirection, 2), true, "characterization: the old rule accepted a bearish retest candle");
assert.notEqual(classify(wrongDirection, "long"), "Breakout retest");
assert.notEqual(classify(mirrorFixture(wrongDirection), "short"), "Breakout retest");
assert.equal(evaluateBreakoutRetestSetup("long", wrongDirection, { atr14: 2 }).confirmation, false);

const staleRetest = breakoutFixture({
  preBreakout: { open: 105.2, high: 105.8, low: 105.1, close: 105.6 }
});
assert.equal(oldBreakoutRetest("long", staleRetest, 2), true, "characterization: the old rule did not prove that the breakout was fresh");
assert.notEqual(classify(staleRetest, "long"), "Breakout retest");
assert.notEqual(classify(mirrorFixture(staleRetest), "short"), "Breakout retest");
assert.equal(evaluateBreakoutRetestSetup("long", staleRetest, { atr14: 2 }).freshBreakout, false);

const longEvidence = evaluateBreakoutRetestSetup("long", cleanLong, { atr14: 2 });
const shortEvidence = evaluateBreakoutRetestSetup("short", cleanShort, { atr14: 2 });
assert.equal(longEvidence.qualified, true);
assert.equal(shortEvidence.qualified, true);
assert.equal(longEvidence.breakoutLevel, 105);
assert.equal(shortEvidence.breakoutLevel, 95);
assert.equal(longEvidence.retestToleranceAtr, shortEvidence.retestToleranceAtr);
assert.equal(longEvidence.retestDistanceAtr, shortEvidence.retestDistanceAtr);
assert.equal(longEvidence.invalidationLevel + shortEvidence.invalidationLevel, 200);
assert.equal(longEvidence.breakoutCandle.time, cleanLong.at(-2).time);
assert.equal(longEvidence.retestCandle.time, cleanLong.at(-1).time);

const continuationType = classify(noRetest, "long", {
  lowerTimeframe: "15m",
  higherTimeframes: [
    { timeframe: "1h", available: true, regime: { preferredDirection: "long" } },
    { timeframe: "4h", available: true, regime: { preferredDirection: "long" } }
  ]
});
assert.equal(continuationType, "Multi-timeframe continuation", "failed retests must continue through the ordered classifier");

assert.match(generatorSource, /strategyEvidence: bestCase\.strategyEvidence/);
assert.match(generatorSource, /strategyEvidence\s*\n\s*};/);
assert.match(generatorSource, /buildDynamicRiskPlan\(\{[\s\S]*?setupType,[\s\S]*?qualityScore,/);
assert.doesNotMatch(
  generatorSource.match(/buildDynamicRiskPlan\(\{[\s\S]*?\}\);/)?.[0] || "",
  /strategyEvidence/,
  "strategy evidence must remain diagnostic and must not feed the generic risk engine"
);

console.log(JSON.stringify({
  oldRule: {
    breakoutCandleIndex: -2,
    retestCandleIndex: -1,
    toleranceAtr: 0.35,
    oneSidedRetestBound: true,
    directionalConfirmation: false,
    freshnessCheck: false
  },
  newRule: {
    breakoutCandleIndex: -2,
    retestCandleIndex: -1,
    boundedZoneAtr: BREAKOUT_RETEST_TOLERANCE_ATR,
    freshBreakout: true,
    heldLevel: true,
    directionalConfirmation: true
  },
  mirroredEvidence: {
    long: longEvidence,
    short: shortEvidence
  },
  rejectedOldFalsePositives: ["deep_failure", "wrong_direction", "stale_retest"],
  fallthrough: continuationType
}, null, 2));
console.log("Breakout Retest focused tests passed.");

function classify(candles, direction, confluenceContext = null) {
  const long = direction === "long";
  return classifySetupType(
    direction,
    candles,
    {
      ema20: long ? 102 : 98,
      ema50: 100,
      rsi14: long ? 55 : 45,
      atr14: 2,
      volumeMa20: 100
    },
    {
      nearestSupport: { price: long ? 101 : 90 },
      nearestResistance: { price: long ? 110 : 99 },
      supportStrength: 3,
      resistanceStrength: 3
    },
    { label: long ? "Trend Up" : "Trend Down", trendStrength: 0.5 },
    null,
    null,
    confluenceContext
  );
}

function oldBreakoutRetest(direction, candles, atrValue) {
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const priorWindow = candles.slice(-24, -3);
  const priorHigh = Math.max(...priorWindow.map((candle) => candle.high));
  const priorLow = Math.min(...priorWindow.map((candle) => candle.low));
  return direction === "long"
    ? previous.close > priorHigh && latest.low <= priorHigh + atrValue * 0.35 && latest.close > priorHigh
    : previous.close < priorLow && latest.high >= priorLow - atrValue * 0.35 && latest.close < priorLow;
}

function breakoutFixture(overrides = {}) {
  const start = 1_770_000_000;
  const candles = Array.from({ length: 27 }, (_, index) => ({
    time: start + index * 900,
    open: 100.5,
    high: index === 10 ? 105 : 103,
    low: index === 12 ? 95 : 98,
    close: 101,
    volume: 100
  }));
  candles.push(candle(start, 27, overrides.preBreakout || { open: 104.4, high: 104.9, low: 104.2, close: 104.8 }));
  candles.push(candle(start, 28, overrides.breakout || { open: 104.8, high: 106.4, low: 104.7, close: 106 }));
  candles.push(candle(start, 29, overrides.retest || { open: 105.2, high: 106.6, low: 105.1, close: 106.2 }));
  return candles;
}

function candle(start, index, values) {
  return { time: start + index * 900, volume: 120, ...values };
}

function mirrorFixture(candles, pivot = 100) {
  return candles.map((item) => ({
    ...item,
    open: pivot * 2 - item.open,
    high: pivot * 2 - item.low,
    low: pivot * 2 - item.high,
    close: pivot * 2 - item.close
  }));
}
