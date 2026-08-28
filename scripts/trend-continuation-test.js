import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  TREND_CONTINUATION_MAX_PAUSE_BODY_ATR,
  TREND_CONTINUATION_MAX_PAUSE_DIRECTIONAL_MOVE_ATR,
  TREND_CONTINUATION_MAX_PAUSE_RANGE_ATR,
  TREND_CONTINUATION_MIN_BODY_ATR,
  TREND_CONTINUATION_MIN_BODY_TO_RANGE,
  TREND_CONTINUATION_MIN_CLOSE_LOCATION,
  TREND_CONTINUATION_MIN_TREND_STRENGTH,
  TREND_CONTINUATION_PAUSE_CANDLES,
  classifySetupType,
  evaluateTrendContinuationSetup
} from "../src/modules/signals/signalGenerator.js";

const generatorSource = await readFile(new URL("../src/modules/signals/signalGenerator.js", import.meta.url), "utf8");
const validLong = continuationFixture();
const validShort = mirrorFixture(validLong);

assert.equal(TREND_CONTINUATION_MIN_TREND_STRENGTH, 0.56);
assert.equal(TREND_CONTINUATION_PAUSE_CANDLES, 2);
assert.equal(TREND_CONTINUATION_MAX_PAUSE_RANGE_ATR, 1.25);
assert.equal(TREND_CONTINUATION_MAX_PAUSE_BODY_ATR, 0.35);
assert.equal(TREND_CONTINUATION_MAX_PAUSE_DIRECTIONAL_MOVE_ATR, 0.4);
assert.equal(TREND_CONTINUATION_MIN_BODY_ATR, 0.45);
assert.equal(TREND_CONTINUATION_MIN_BODY_TO_RANGE, 0.55);
assert.equal(TREND_CONTINUATION_MIN_CLOSE_LOCATION, 0.7);

assert.equal(classify(validLong), "Trend continuation");
assert.equal(classify(validShort), "Trend continuation");
assert.equal(evidence(validLong).qualified, true);
assert.equal(evidence(validShort).qualified, true);
assert.ok(Math.min(...validLong.candles.slice(-3, -1).map((candle) => candle.low)) > validLong.ema20);

const noPause = continuationFixture({ noPause: true });
assert.equal(oldTrendContinuation(noPause), true, "characterization: old rule accepted one directional trend candle without a pause");
assert.equal(evidence(noPause).qualified, false);
assert.notEqual(classify(noPause), "Trend continuation");
assert.notEqual(classify(mirrorFixture(noPause)), "Trend continuation");

const noProgress = continuationFixture({ noProgress: true });
assert.equal(evidence(noProgress).brokePauseRange, false);
assert.notEqual(classify(noProgress), "Trend continuation");

const weakBody = continuationFixture({ weakBody: true });
assert.ok(evidence(weakBody).continuationBodyAtr < TREND_CONTINUATION_MIN_BODY_ATR);
assert.notEqual(classify(weakBody), "Trend continuation");

const opposingWick = continuationFixture({ opposingWick: true });
assert.ok(evidence(opposingWick).bodyToRangeRatio < TREND_CONTINUATION_MIN_BODY_TO_RANGE);
assert.ok(evidence(opposingWick).directionalCloseLocation < TREND_CONTINUATION_MIN_CLOSE_LOCATION);
assert.notEqual(classify(opposingWick), "Trend continuation");

const failedTrend = continuationFixture({ trendFailure: true });
assert.equal(evidence(failedTrend).trendHeld, false);
assert.notEqual(classify(failedTrend), "Trend continuation");
assert.notEqual(classify(mirrorFixture(failedTrend)), "Trend continuation");

const stale = continuationFixture({ staleContinuation: true });
assert.equal(oldTrendContinuation(stale), true, "characterization: the old rule ignored when continuation actually occurred");
assert.equal(evidence(stale).qualified, false);
assert.notEqual(classify(stale), "Trend continuation");

const wrongRegime = continuationFixture({ regimeLabel: "High Volatility" });
assert.equal(oldTrendContinuation(wrongRegime), true, "characterization: the old rule had no explicit regime label requirement");
assert.equal(evidence(wrongRegime).qualified, false);
assert.notEqual(classify(wrongRegime), "Trend continuation");

const brokenHierarchy = continuationFixture({ ema20: 98 });
assert.equal(evidence(brokenHierarchy).qualified, false);
assert.notEqual(classify(brokenHierarchy), "Trend continuation");

const unresolvedPause = continuationFixture({ unresolvedPause: true });
assert.equal(evidence(unresolvedPause).compactPause, true);
assert.equal(evidence(unresolvedPause).brokePauseRange, false);
assert.notEqual(classify(unresolvedPause), "Trend continuation");

const weakVolume = continuationFixture({ latestVolume: 5 });
assert.equal(evidence(weakVolume).qualified, true, "volume remains diagnostic rather than a new blocker");
assert.equal(evidence(weakVolume).volumeRatio, 0.05);

const momentum = continuationFixture({ momentumBreakout: true });
assert.equal(evidence(momentum).qualified, true);
assert.equal(classify(momentum), "Momentum breakout", "Momentum breakout precedence must remain unchanged");

const pullback = pullbackFixture();
assert.equal(classify(pullback), "Pullback bounce", "Pullback Bounce precedence must remain unchanged");

const mtf = continuationFixture({
  confluenceContext: {
    lowerTimeframe: "15m",
    higherTimeframes: [
      { timeframe: "1h", available: true, regime: { preferredDirection: "long" } },
      { timeframe: "4h", available: true, regime: { preferredDirection: "long" } }
    ]
  }
});
assert.equal(classify(mtf), "Multi-timeframe continuation", "MTF precedence must remain unchanged");

const longEvidence = evidence(validLong);
const shortEvidence = evidence(validShort);
assertApprox(longEvidence.pauseRangeAtr, shortEvidence.pauseRangeAtr);
assertApprox(longEvidence.pauseBodyAtr, shortEvidence.pauseBodyAtr);
assertApprox(longEvidence.pauseDirectionalMoveAtr, shortEvidence.pauseDirectionalMoveAtr);
assertApprox(longEvidence.continuationBodyAtr, shortEvidence.continuationBodyAtr);
assertApprox(longEvidence.bodyToRangeRatio, shortEvidence.bodyToRangeRatio);
assertApprox(longEvidence.directionalCloseLocation, shortEvidence.directionalCloseLocation);
assert.equal(longEvidence.invalidationLevel + shortEvidence.invalidationLevel, 200);

assert.match(generatorSource, /setupType === "Trend continuation"[\s\S]*?evaluateTrendContinuationSetup/);
assert.match(generatorSource, /strategyEvidence: bestCase\.strategyEvidence/);
const riskCall = generatorSource.match(/buildDynamicRiskPlan\(\{[\s\S]*?\}\);/)?.[0] || "";
assert.doesNotMatch(riskCall, /strategyEvidence/, "Trend evidence must remain diagnostic and must not feed the risk engine");

console.log(JSON.stringify({
  oldRule: {
    regimeLabelRequired: false,
    trendStrength: "abs(EMA20 - EMA50) / ATR14 >= 0.56",
    emaAlignment: true,
    directionalLatestCandle: true,
    pauseRequired: false,
    expansionRequired: false,
    freshness: null
  },
  newRule: {
    regime: "Trend Up / Trend Down",
    pauseCandles: TREND_CONTINUATION_PAUSE_CANDLES,
    maximumPauseRangeAtr: TREND_CONTINUATION_MAX_PAUSE_RANGE_ATR,
    maximumAveragePauseBodyAtr: TREND_CONTINUATION_MAX_PAUSE_BODY_ATR,
    maximumPauseDirectionalMoveAtr: TREND_CONTINUATION_MAX_PAUSE_DIRECTIONAL_MOVE_ATR,
    minimumContinuationBodyAtr: TREND_CONTINUATION_MIN_BODY_ATR,
    minimumBodyToRangeRatio: TREND_CONTINUATION_MIN_BODY_TO_RANGE,
    minimumDirectionalCloseLocation: TREND_CONTINUATION_MIN_CLOSE_LOCATION,
    progressReference: "latest close beyond the immediately preceding two-candle pause high/low",
    triggerIndex: -1,
    invalidation: "pause low for LONG / pause high for SHORT",
    volume: "diagnostic only"
  },
  precedence: ["Momentum breakout", "Multi-timeframe continuation", "Pullback bounce"],
  mirrored: true,
  evidence: longEvidence
}, null, 2));

function continuationFixture(options = {}) {
  const start = 1_900_000_000;
  const candles = Array.from({ length: 32 }, (_, index) => candle(start, index, {
    open: 102.2,
    high: index === 15 ? 108 : 103.1,
    low: 101.8,
    close: 102.6,
    volume: 100
  }));
  candles[28] = candle(start, 28, { open: 102.6, high: 104.1, low: 102.5, close: 103.4, volume: 110 });
  candles[29] = candle(start, 29, { open: 103.25, high: 103.7, low: 103.1, close: 103.4, volume: 80 });
  candles[30] = candle(start, 30, { open: 103.4, high: 103.8, low: 103.2, close: 103.5, volume: 75 });
  candles[31] = candle(start, 31, {
    open: 103.45,
    high: 105.45,
    low: 103.35,
    close: 105.2,
    volume: options.latestVolume ?? 125
  });

  if (options.noPause) {
    candles[29] = candle(start, 29, { open: 101.4, high: 103, low: 101.2, close: 102.8, volume: 100 });
    candles[30] = candle(start, 30, { open: 102.8, high: 104, low: 102.6, close: 103.7, volume: 100 });
  }
  if (options.noProgress || options.unresolvedPause) {
    candles[31] = candle(start, 31, { open: 103.3, high: 104.1, low: 103.2, close: 103.7, volume: 125 });
  }
  if (options.weakBody) {
    candles[31] = candle(start, 31, { open: 103.6, high: 104.2, low: 103.5, close: 103.9, volume: 125 });
  }
  if (options.opposingWick) {
    candles[31] = candle(start, 31, { open: 103.45, high: 105.9, low: 101.8, close: 104.4, volume: 125 });
  }
  if (options.trendFailure) {
    candles[29] = candle(start, 29, { open: 103.2, high: 103.5, low: 98.5, close: 100.8, volume: 100 });
    candles[30] = candle(start, 30, { open: 100.8, high: 103.8, low: 98.7, close: 103.4, volume: 100 });
  }
  if (options.staleContinuation) {
    candles[28] = candle(start, 28, { open: 103.3, high: 105.3, low: 103.2, close: 105, volume: 125 });
    candles[29] = candle(start, 29, { open: 104.8, high: 105.2, low: 104.5, close: 104.9, volume: 90 });
    candles[30] = candle(start, 30, { open: 104.9, high: 105.3, low: 104.7, close: 105, volume: 90 });
    candles[31] = candle(start, 31, { open: 105, high: 105.5, low: 104.9, close: 105.2, volume: 100 });
  }
  if (options.momentumBreakout) {
    for (let index = 8; index <= 28; index += 1) candles[index].high = Math.min(candles[index].high, 104.8);
    candles[28].high = 104.8;
  }

  return {
    direction: "long",
    candles,
    ema20: options.ema20 ?? 101,
    ema50: options.ema50 ?? 99,
    rsi14: 55,
    atr14: 2,
    volumeMa20: 100,
    nearestSupport: { price: 95 },
    nearestResistance: { price: 112 },
    supportStrength: 3,
    resistanceStrength: 3,
    regimeLabel: options.regimeLabel || "Trend Up",
    trendStrength: options.trendStrength ?? 0.78,
    confluenceContext: options.confluenceContext || null
  };
}

function pullbackFixture() {
  const fixture = continuationFixture({ trendStrength: 0.5 });
  const { candles } = fixture;
  candles[27] = candle(candles[0].time, 27, { open: 104.8, high: 106, low: 104.5, close: 105, volume: 120 });
  candles[28] = candle(candles[0].time, 28, { open: 105, high: 105.2, low: 103.8, close: 104, volume: 115 });
  candles[29] = candle(candles[0].time, 29, { open: 103.4, high: 103.6, low: 102.3, close: 102.5, volume: 110 });
  candles[30] = candle(candles[0].time, 30, { open: 102.4, high: 102.6, low: 100.8, close: 101.1, volume: 110 });
  candles[31] = candle(candles[0].time, 31, { open: 100.4, high: 102, low: 99.8, close: 101.6, volume: 130 });
  fixture.ema20 = 100;
  fixture.ema50 = 98;
  fixture.nearestSupport = { price: 99.6 };
  return fixture;
}

function evidence(fixture) {
  return evaluateTrendContinuationSetup(
    fixture.direction,
    fixture.candles,
    indicators(fixture),
    { label: fixture.regimeLabel, trendStrength: fixture.trendStrength }
  );
}

function classify(fixture) {
  return classifySetupType(
    fixture.direction,
    fixture.candles,
    indicators(fixture),
    {
      nearestSupport: fixture.nearestSupport,
      nearestResistance: fixture.nearestResistance,
      supportStrength: fixture.supportStrength,
      resistanceStrength: fixture.resistanceStrength
    },
    { label: fixture.regimeLabel, trendStrength: fixture.trendStrength },
    null,
    null,
    fixture.confluenceContext
  );
}

function indicators(fixture) {
  return {
    ema20: fixture.ema20,
    ema50: fixture.ema50,
    rsi14: fixture.rsi14,
    atr14: fixture.atr14,
    volumeMa20: fixture.volumeMa20
  };
}

function oldTrendContinuation(fixture) {
  const latest = fixture.candles.at(-1);
  const aligned = fixture.direction === "long"
    ? latest.close > fixture.ema20 && fixture.ema20 > fixture.ema50
    : latest.close < fixture.ema20 && fixture.ema20 < fixture.ema50;
  const directional = fixture.direction === "long" ? latest.close > latest.open : latest.close < latest.open;
  return aligned && fixture.trendStrength >= 0.56 && directional;
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
    regimeLabel: fixture.regimeLabel === "Trend Up" ? "Trend Down" : fixture.regimeLabel,
    confluenceContext: fixture.confluenceContext ? {
      higherTimeframes: [{ available: true, regime: { preferredDirection: "short" } }]
    } : null
  };
}

function candle(start, index, values) {
  return { time: start + index * 900, ...values };
}

function assertApprox(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected}`);
}
