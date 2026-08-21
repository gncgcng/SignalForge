import assert from "node:assert/strict";
import {
  MAX_FINAL_PIVOT_AGE_CANDLES,
  detectChartPatterns
} from "../src/modules/patterns/patternDetector.js";
import {
  PATTERN_ASSOCIATION_MAX_AGE_CANDLES,
  attachRelevantPatternContext,
  classifySetupType
} from "../src/modules/signals/signalGenerator.js";

const confirmedTopCandles = reversalCandles("double_top", "confirmed");
const confirmedTop = findPattern(confirmedTopCandles, "double_top");
assert.equal(confirmedTop.confirmed, true);
assert.equal(confirmedTop.state, "confirmed");
assert.ok(confirmedTop.evidence.firstPivot);
assert.ok(confirmedTop.evidence.middlePivot);
assert.ok(confirmedTop.evidence.secondPivot);
assert.ok(confirmedTop.evidence.confirmation);
assert.ok(confirmedTop.evidence.confirmation.index > confirmedTop.evidence.secondPivot.index);
assert.ok(confirmedTop.evidence.confirmation.close < confirmedTop.evidence.neckline);
assert.equal(confirmedTop.detectedAt, isoTime(confirmedTop.evidence.confirmation.time));

const unconfirmedTop = findPattern(reversalCandles("double_top", "no_break"), "double_top");
assert.equal(unconfirmedTop.confirmed, false, "double top without a neckline close must remain potential");
assert.equal(unconfirmedTop.evidence.confirmation, null);

const wickOnlyTop = findPattern(reversalCandles("double_top", "wick_only"), "double_top");
assert.equal(wickOnlyTop.confirmed, false, "wick-only double-top breakdown must not confirm");

const staleTop = findPattern(reversalCandles("double_top", "stale"), "double_top");
assert.equal(staleTop.confirmed, false, "old double top must not remain current-confirmed");
assert.ok(staleTop.evidence.finalPivotAgeCandles > MAX_FINAL_PIVOT_AGE_CANDLES);
assert.ok(staleTop.evidence.confirmation, "stale structure should remain observable as historical evidence");
assert.equal(attach("Momentum breakout", "short", staleTop, reversalCandles("double_top", "stale")).patternContext, null);

const unrelatedTopCandles = reversalCandles("double_top", "unrelated");
const unrelatedTop = findPattern(unrelatedTopCandles, "double_top");
assert.equal(unrelatedTop.confirmed, true, "recent historical confirmation remains observable");
assert.ok(unrelatedTop.ageCandles > PATTERN_ASSOCIATION_MAX_AGE_CANDLES);
assert.equal(attach("Momentum breakout", "short", unrelatedTop, unrelatedTopCandles).patternContext, null);
assert.equal(attach("Momentum breakout", "short", confirmedTop, confirmedTopCandles).patternContext?.pattern, "double_top");

const confirmedBottomCandles = reversalCandles("double_bottom", "confirmed");
const confirmedBottom = findPattern(confirmedBottomCandles, "double_bottom");
assert.equal(confirmedBottom.confirmed, true);
assert.ok(confirmedBottom.evidence.confirmation.close > confirmedBottom.evidence.neckline);
assert.equal(findPattern(reversalCandles("double_bottom", "no_break"), "double_bottom").confirmed, false);
assert.equal(findPattern(reversalCandles("double_bottom", "wick_only"), "double_bottom").confirmed, false);
const staleBottomCandles = reversalCandles("double_bottom", "stale");
const staleBottom = findPattern(staleBottomCandles, "double_bottom");
assert.equal(staleBottom.confirmed, false);
assert.ok(staleBottom.evidence.confirmation);
assert.equal(attach("Momentum breakout", "long", staleBottom, staleBottomCandles).patternContext, null);
const unrelatedBottomCandles = reversalCandles("double_bottom", "unrelated");
const unrelatedBottom = findPattern(unrelatedBottomCandles, "double_bottom");
assert.equal(unrelatedBottom.confirmed, true);
assert.equal(attach("Momentum breakout", "long", unrelatedBottom, unrelatedBottomCandles).patternContext, null);
assert.equal(attach("Momentum breakout", "long", confirmedBottom, confirmedBottomCandles).patternContext?.pattern, "double_bottom");

for (const [patternName, direction] of [["head_and_shoulders", "short"], ["inverse_head_and_shoulders", "long"]]) {
  const confirmedCandles = shoulderCandles(patternName, "confirmed");
  const confirmed = findPattern(confirmedCandles, patternName);
  assert.equal(confirmed.confirmed, true, `${patternName} close confirmation was not recognized`);
  assert.ok(confirmed.evidence.leftShoulder);
  assert.ok(confirmed.evidence.head);
  assert.ok(confirmed.evidence.rightShoulder);
  assert.ok(confirmed.evidence.confirmation.index > confirmed.evidence.rightShoulder.index);
  assert.equal(findPattern(shoulderCandles(patternName, "no_break"), patternName).confirmed, false);
  assert.equal(findPattern(shoulderCandles(patternName, "wick_only"), patternName).confirmed, false);
  assert.equal(findPattern(shoulderCandles(patternName, "stale"), patternName).confirmed, false);
  assert.equal(hasPattern(shoulderCandles(patternName, "malformed_shoulders"), patternName), false);
  assert.equal(hasPattern(shoulderCandles(patternName, "weak_head"), patternName), false);
  assert.equal(attach("Momentum breakout", direction, confirmed, confirmedCandles).patternContext?.pattern, patternName);
  const staleAssociation = { ...confirmed, ageCandles: PATTERN_ASSOCIATION_MAX_AGE_CANDLES + 1, evidence: { ...confirmed.evidence, ageCandles: PATTERN_ASSOCIATION_MAX_AGE_CANDLES + 1 } };
  assert.equal(attach("Momentum breakout", direction, staleAssociation, confirmedCandles).patternContext, null);
}

const momentumCandles = momentumBreakoutCandles();
const momentumType = classifySetupType(
  "long",
  momentumCandles,
  { ema20: 105, ema50: 101, atr14: 2, volumeMa20: 1000, rsi14: 55 },
  { nearestSupport: { price: 104 }, nearestResistance: null, supportStrength: 3, resistanceStrength: 0 },
  { label: "Breakout", trendStrength: 0.8 },
  null,
  null,
  null
);
assert.equal(momentumType, "Momentum breakout");

const numericSignal = {
  setupType: momentumType,
  direction: "long",
  entry: 111,
  stopLoss: 107,
  takeProfit: 119,
  riskRewardRatio: 2,
  confidenceScore: 86,
  qualityScore: 82,
  readinessScore: 91,
  valid: true
};
const relevantPattern = confirmedPattern("double_bottom", "bullish", 110, momentumCandles.at(-1).time, 0);
const withPattern = attachRelevantPatternContext(numericSignal, [relevantPattern], "long", {
  candles: momentumCandles,
  indicators: { atr14: 2 }
});
const withoutPattern = attachRelevantPatternContext(numericSignal, [{ ...relevantPattern, confirmed: false, state: "potential" }], "long", {
  candles: momentumCandles,
  indicators: { atr14: 2 }
});
assert.equal(withPattern.patternContext?.pattern, "double_bottom");
assert.equal(withoutPattern.patternContext, null);
assert.equal(withPattern.setupType, "Momentum breakout");
assert.equal(withoutPattern.setupType, "Momentum breakout");
for (const field of ["direction", "entry", "stopLoss", "takeProfit", "riskRewardRatio", "confidenceScore", "qualityScore", "readinessScore", "valid"]) {
  assert.deepEqual(withPattern[field], withoutPattern[field], `${field} changed when pattern metadata was omitted`);
}
assert.equal(withPattern.patternContext.confidenceModifier, 0);

const retestPattern = { ...relevantPattern, ageCandles: 1, evidence: { ...relevantPattern.evidence, ageCandles: 1 } };
assert.equal(attach("Breakout retest", "long", retestPattern, momentumCandles).patternContext?.pattern, "double_bottom");
assert.equal(attach("Breakout retest", "long", relevantPattern, momentumCandles).patternContext, null, "retest association must use the preceding breakout candle");

const sweepTime = confirmedTop.evidence.finalPivot.time;
assert.equal(attachRelevantPatternContext({ ...numericSignal, setupType: "Liquidity sweep reversal" }, [confirmedTop], "short", {
  candles: confirmedTopCandles,
  indicators: { atr14: 2 },
  smcState: { liquiditySweep: { confirmed: true, direction: "short", time: sweepTime } }
}).patternContext?.pattern, "double_top");
assert.equal(attachRelevantPatternContext({ ...numericSignal, setupType: "Liquidity sweep reversal" }, [confirmedTop], "short", {
  candles: confirmedTopCandles,
  indicators: { atr14: 2 },
  smcState: { liquiditySweep: { confirmed: true, direction: "short", time: confirmedTopCandles[0].time } }
}).patternContext, null, "unrelated liquidity sweep must not inherit a classical pattern");

console.log(JSON.stringify({
  patternAssociationMaxAgeCandles: PATTERN_ASSOCIATION_MAX_AGE_CANDLES,
  staleDoubleTopAge: staleTop.evidence.finalPivotAgeCandles,
  confirmedDoubleTop: summarize(confirmedTop),
  confirmedDoubleBottom: summarize(confirmedBottom),
  momentumNumericFieldsUnchanged: true
}, null, 2));
console.log("Chart pattern confirmation and association tests passed.");

function attach(setupType, direction, pattern, candles) {
  return attachRelevantPatternContext({ setupType, direction, valid: true }, [pattern], direction, {
    candles,
    indicators: { atr14: 2 }
  });
}

function findPattern(candles, pattern) {
  const found = detectChartPatterns(candles, { timeframe: "15m" }).find((item) => item.pattern === pattern);
  assert.ok(found, `${pattern} structure was not detected`);
  return found;
}

function hasPattern(candles, pattern) {
  return detectChartPatterns(candles, { timeframe: "15m" }).some((item) => item.pattern === pattern);
}

function reversalCandles(type, mode) {
  const bearish = type === "double_top";
  const anchors = bearish
    ? [[0, 104], [8, 110], [14, 100], [22, 110.1], [28, 101], [30, 99]]
    : [[0, 106], [8, 100], [14, 110], [22, 99.9], [28, 109], [30, 111]];
  let candles = pointCandles(interpolate(anchors));
  if (mode === "no_break" || mode === "wick_only") {
    candles = candles.slice(0, 30);
    const neckline = bearish ? 99.75 : 110.25;
    const close = bearish ? neckline + 0.35 : neckline - 0.35;
    candles.push(makeCandle(candles.length, close, mode === "wick_only"
      ? { low: bearish ? neckline - 1 : close - 0.25, high: bearish ? close + 0.25 : neckline + 1 }
      : {}));
  }
  if (mode === "stale") {
    const last = candles.at(-1).close;
    for (let index = 0; index < 12; index += 1) candles.push(makeCandle(candles.length, bearish ? last - index * 0.12 : last + index * 0.12));
  }
  if (mode === "unrelated") {
    const last = candles.at(-1).close;
    for (let index = 0; index < 5; index += 1) candles.push(makeCandle(candles.length, bearish ? last - index * 0.08 : last + index * 0.08));
  }
  return candles;
}

function shoulderCandles(type, mode) {
  const bearish = type === "head_and_shoulders";
  let shoulders = bearish ? [108, 108.2] : [102, 101.8];
  let head = bearish ? 114 : 96;
  const closesThroughNeckline = mode === "confirmed" || mode === "stale";
  const finalClose = bearish
    ? (closesThroughNeckline ? 99 : 102)
    : (closesThroughNeckline ? 111 : 108);
  if (mode === "malformed_shoulders") shoulders = bearish ? [108, 103] : [102, 107];
  if (mode === "weak_head") head = bearish ? 108.45 : 101.55;
  const anchors = bearish
    ? [[0, 104], [6, shoulders[0]], [10, 101], [15, head], [20, 101.2], [25, shoulders[1]], [30, finalClose]]
    : [[0, 106], [6, shoulders[0]], [10, 109], [15, head], [20, 108.8], [25, shoulders[1]], [30, finalClose]];
  let candles = pointCandles(interpolate(anchors));
  if (["no_break", "wick_only", "malformed_shoulders", "weak_head"].includes(mode)) {
    candles = candles.slice(0, 30);
    const neckline = bearish ? 100.85 : 109.15;
    const close = bearish ? neckline + 0.35 : neckline - 0.35;
    candles.push(makeCandle(candles.length, close, mode === "wick_only"
      ? { low: bearish ? neckline - 1 : close - 0.25, high: bearish ? close + 0.25 : neckline + 1 }
      : {}));
  }
  if (mode === "stale") {
    const last = candles.at(-1).close;
    for (let index = 0; index < 12; index += 1) candles.push(makeCandle(candles.length, bearish ? last - index * 0.1 : last + index * 0.1));
  }
  return candles;
}

function momentumBreakoutCandles() {
  const candles = Array.from({ length: 27 }, (_, index) => makeCandle(index, 104 + Math.sin(index) * 1.2, {
    high: index === 10 ? 110 : 106 + Math.sin(index) * 0.5,
    low: 102 + Math.sin(index) * 0.5,
    volume: 1000
  }));
  candles.push(makeCandle(27, 108, { high: 109, low: 107, volume: 1000 }));
  candles.push(makeCandle(28, 109, { high: 109.5, low: 108, volume: 1000 }));
  candles.push(makeCandle(29, 111, { open: 109, high: 111.5, low: 108.8, volume: 1100 }));
  return candles;
}

function confirmedPattern(pattern, bias, neckline, time, ageCandles) {
  const direction = bias === "bullish" ? "long" : "short";
  return {
    pattern,
    label: pattern,
    bias,
    category: "reversal",
    confirmed: true,
    state: "confirmed",
    ageCandles,
    confidence: 0.8,
    confidenceModifier: 0,
    keyLevels: { neckline },
    evidence: {
      neckline,
      finalPivot: { time },
      confirmation: { time, close: direction === "long" ? neckline + 1 : neckline - 1 },
      ageCandles,
      confirmed: true
    }
  };
}

function pointCandles(values) {
  return values.map((close, index) => makeCandle(index, close));
}

function makeCandle(index, close, overrides = {}) {
  const open = overrides.open ?? close;
  return {
    time: 1700000000 + index * 900,
    open,
    high: overrides.high ?? Math.max(open, close) + 0.25,
    low: overrides.low ?? Math.min(open, close) - 0.25,
    close,
    volume: overrides.volume ?? 1000
  };
}

function interpolate(anchors) {
  const values = [];
  for (let segment = 0; segment < anchors.length - 1; segment += 1) {
    const [startIndex, startValue] = anchors[segment];
    const [endIndex, endValue] = anchors[segment + 1];
    for (let index = startIndex; index < endIndex; index += 1) {
      const progress = (index - startIndex) / (endIndex - startIndex);
      values[index] = startValue + (endValue - startValue) * progress;
    }
  }
  const [lastIndex, lastValue] = anchors.at(-1);
  values[lastIndex] = lastValue;
  return values;
}

function summarize(pattern) {
  return {
    pattern: pattern.pattern,
    confirmed: pattern.confirmed,
    neckline: pattern.evidence.neckline,
    completionIndex: pattern.completionIndex,
    ageCandles: pattern.ageCandles
  };
}

function isoTime(value) {
  return new Date(Number(value) * 1000).toISOString();
}
