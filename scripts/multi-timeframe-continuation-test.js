import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  classifySetupType,
  evaluateMultiTimeframeContinuationSetup
} from "../src/modules/signals/signalGenerator.js";
import { scoreMultiTimeframeConfluence } from "../src/modules/market-data/multiTimeframeService.js";

const generatorSource = await readFile(new URL("../src/modules/signals/signalGenerator.js", import.meta.url), "utf8");

for (const baseTimeframe of ["1h", "15m", "5m"]) {
  for (const direction of ["long", "short"]) {
    const item = fixture(baseTimeframe, direction, alignedFrames(baseTimeframe, direction));
    const evidence = evaluate(item);
    assert.equal(evidence.passed, true, `${baseTimeframe} ${direction.toUpperCase()} should pass`);
    assert.equal(classify(item), "Multi-timeframe continuation");
  }
}

const mixed = fixture("5m", "long", [
  frame("15m", "long"),
  frame("1h", "short"),
  frame("4h", "short")
]);
assert.equal(oldMtfRule(mixed), true, "one matching preferredDirection triggered the old rule");
assert.equal(scoreMultiTimeframeConfluence(mixed.confluenceContext, "long").score, 37);
assert.equal(evaluate(mixed).passed, false);
assert.notEqual(classify(mixed), "Multi-timeframe continuation");

const nearestAlignedBroadestOpposed = fixture("15m", "long", [
  frame("1h", "long"),
  frame("4h", "short")
]);
assert.equal(evaluate(nearestAlignedBroadestOpposed).broadestTimeframeDirection, "short");
assert.equal(evaluate(nearestAlignedBroadestOpposed).passed, false);

const broadestAlignedNearestOpposed = fixture("15m", "long", [
  frame("1h", "short"),
  frame("4h", "long")
]);
assert.equal(evaluate(broadestAlignedNearestOpposed).passed, false);

const neutral = fixture("15m", "long", [frame("1h", "neutral"), frame("4h", "neutral")]);
assert.equal(evaluate(neutral).neutralCount, 2);
assert.equal(evaluate(neutral).passed, false);

const oneOfThree = fixture("5m", "long", [
  frame("15m", "long"),
  unavailable("1h"),
  unavailable("4h")
]);
assert.equal(evaluate(oneOfThree).passed, false);

const twoOfThreeNoOpposition = fixture("5m", "long", [
  frame("15m", "long"),
  frame("1h", "long"),
  unavailable("4h")
]);
assert.equal(evaluate(twoOfThreeNoOpposition).passed, true);

const oneHour = fixture("1h", "long", [frame("4h", "long")]);
assert.equal(evaluate(oneHour).passed, true);

const badBaseRegime = fixture("15m", "long", alignedFrames("15m", "long"), { regimeDirection: "neutral" });
assert.equal(evaluate(badBaseRegime).baseContinuation, false);
assert.equal(evaluate(badBaseRegime).passed, false);

const wrongDirectionCandle = fixture("15m", "long", alignedFrames("15m", "long"), { wrongDirectionCandle: true });
assert.equal(evaluate(wrongDirectionCandle).baseContinuation, false);
assert.equal(evaluate(wrongDirectionCandle).passed, false);

const fourHour = fixture("4h", "long", []);
assert.equal(evaluate(fourHour).agreementRule, "higher_timeframe_required");
assert.equal(evaluate(fourHour).passed, false);
assert.notEqual(classify(fourHour), "Multi-timeframe continuation");

const fallthrough = { ...mixed, regime: directionalRegime("long", 0.78) };
assert.notEqual(classify(fallthrough), "Multi-timeframe continuation");

const evidence = evaluate(fixture("5m", "long", [
  frame("15m", "long"),
  frame("1h", "long"),
  frame("4h", "neutral")
]));
assert.deepEqual(
  evidence.higherTimeframes.map(({ timeframe, state, direction }) => ({ timeframe, state, direction })),
  [
    { timeframe: "15m", state: "aligned", direction: "long" },
    { timeframe: "1h", state: "aligned", direction: "long" },
    { timeframe: "4h", state: "neutral", direction: "neutral" }
  ]
);
assert.equal(evidence.passed, true);
assert.equal(evidence.agreementRule, "at_least_2_aligned_no_opposition");

assert.doesNotMatch(
  generatorSource.match(/buildDynamicRiskPlan\(\{[\s\S]*?\}\);/)?.[0] || "",
  /strategyEvidence|evaluateMultiTimeframeContinuationSetup/,
  "MTF evidence must remain diagnostic and must not feed the generic risk engine"
);

console.log(JSON.stringify({
  oldRule: {
    agreeingHigherTimeframesRequired: 1,
    matchingField: "regime.preferredDirection",
    confluenceScoreUsedByClassifier: false,
    mixedFixtureScore: scoreMultiTimeframeConfluence(mixed.confluenceContext, "long").score
  },
  newRules: {
    "5m": "at least 2 aligned and zero opposing",
    "15m": "1h and 4h aligned",
    "1h": "4h aligned",
    "4h": "unreachable without a real higher timeframe"
  },
  evidence,
  rejectedOldFalsePositive: "5m one aligned and two opposing",
  fallthrough: classify(fallthrough)
}, null, 2));
console.log("Multi-timeframe Continuation focused tests passed.");

function evaluate(item) {
  return evaluateMultiTimeframeContinuationSetup(
    item.direction,
    item.candles,
    item.indicators,
    item.regime,
    item.confluenceContext
  );
}

function classify(item) {
  return classifySetupType(
    item.direction,
    item.candles,
    item.indicators,
    item.levels,
    item.regime,
    null,
    null,
    item.confluenceContext
  );
}

function oldMtfRule(item) {
  const latest = item.candles.at(-1);
  const aligned = item.direction === "long"
    ? latest.close > item.indicators.ema20 && item.indicators.ema20 > item.indicators.ema50
    : latest.close < item.indicators.ema20 && item.indicators.ema20 < item.indicators.ema50;
  const directional = item.direction === "long" ? latest.close > latest.open : latest.close < latest.open;
  const onePreferredDirection = item.confluenceContext.higherTimeframes.some((higher) => (
    higher.available && higher.regime?.preferredDirection === item.direction
  ));
  return onePreferredDirection && aligned && directional;
}

function fixture(baseTimeframe, direction, higherTimeframes, options = {}) {
  const long = direction === "long";
  const candles = Array.from({ length: 30 }, (_, index) => ({
    time: 1_700_000_000 + index * 900,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100
  }));
  candles[candles.length - 1] = long
    ? { ...candles.at(-1), open: options.wrongDirectionCandle ? 104 : 103, high: 104.5, low: 102.5, close: 103.5 }
    : { ...candles.at(-1), open: options.wrongDirectionCandle ? 96 : 97, high: 97.5, low: 95.5, close: 96.5 };
  const regimeDirection = options.regimeDirection || direction;
  return {
    direction,
    candles,
    indicators: { ema20: long ? 102 : 98, ema50: 100, rsi14: long ? 56 : 44, atr14: 2, volumeMa20: 100 },
    levels: {
      nearestSupport: { price: long ? 96 : 90 },
      nearestResistance: { price: long ? 110 : 104 },
      supportStrength: 3,
      resistanceStrength: 3
    },
    regime: regimeDirection === "neutral"
      ? { label: "Range", preferredDirection: "both", trendStrength: 0.2 }
      : directionalRegime(regimeDirection, 0.65),
    confluenceContext: { lowerTimeframe: baseTimeframe, higherTimeframes }
  };
}

function alignedFrames(baseTimeframe, direction) {
  const map = { "5m": ["15m", "1h", "4h"], "15m": ["1h", "4h"], "1h": ["4h"], "4h": [] };
  return map[baseTimeframe].map((timeframe) => frame(timeframe, direction));
}

function frame(timeframe, direction) {
  if (direction === "neutral") {
    return {
      timeframe,
      available: true,
      regime: {
        label: "Range",
        preferredDirection: "both",
        trendStrength: 0.1,
        metrics: { ema20: 100, ema50: 100, rsi14: 50, adx14: 15, structure: "Mixed", latestPrice: 100, support: 95, resistance: 105 }
      }
    };
  }
  const long = direction === "long";
  return {
    timeframe,
    available: true,
    regime: {
      ...directionalRegime(direction, 0.75),
      metrics: {
        ema20: long ? 105 : 95,
        ema50: 100,
        rsi14: long ? 58 : 42,
        adx14: 30,
        structure: long ? "Higher highs / higher lows" : "Lower highs / lower lows",
        latestPrice: 102,
        support: 94,
        resistance: 112
      }
    }
  };
}

function unavailable(timeframe) {
  return { timeframe, available: false, error: "fixture unavailable" };
}

function directionalRegime(direction, trendStrength) {
  return {
    label: direction === "long" ? "Trend Up" : "Trend Down",
    preferredDirection: direction,
    trendStrength
  };
}
