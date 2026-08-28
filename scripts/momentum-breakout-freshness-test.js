import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  classifySetupType,
  evaluateMomentumBreakoutSetup
} from "../src/modules/signals/signalGenerator.js";
import { calculateMomentumEntryDiagnostics } from "../src/modules/signals/momentumEntryDiagnostics.js";

const generatorSource = await readFile(new URL("../src/modules/signals/signalGenerator.js", import.meta.url), "utf8");
const diagnosticsSource = await readFile(new URL("../src/modules/signals/momentumEntryDiagnostics.js", import.meta.url), "utf8");

const staleLong = momentumFixture("long", {
  minus3: { open: 104.8, high: 106.4, low: 104.5, close: 106.2 },
  minus2: { open: 105.2, high: 105.4, low: 104.5, close: 104.8 },
  trigger: { open: 104.9, high: 106.5, low: 104.7, close: 106.1 }
});
const staleShort = mirrorFixture(staleLong);

assert.equal(oldMomentumClassifies(staleLong), true, "characterization: old LONG rule accepts a -3 breakout and -1 re-break");
assert.equal(oldMomentumClassifies(staleShort), true, "characterization: old SHORT rule accepts a -3 breakout and -1 re-break");
assert.equal(momentumEvidence(staleLong).priorBreakoutDetected, true);
assert.equal(momentumEvidence(staleShort).priorBreakoutDetected, true);
assert.notEqual(classify(staleLong), "Momentum breakout");
assert.notEqual(classify(staleShort), "Momentum breakout");

const freshLong = momentumFixture("long");
const freshShort = mirrorFixture(freshLong);
assert.equal(classify(freshLong), "Momentum breakout");
assert.equal(classify(freshShort), "Momentum breakout");
assert.equal(momentumEvidence(freshLong).breakoutFresh, true);
assert.equal(momentumEvidence(freshShort).breakoutFresh, true);

const wickOnlyLong = momentumFixture("long", {
  minus3: { open: 104.4, high: 106.2, low: 104.1, close: 104.8 }
});
const wickOnlyShort = mirrorFixture(wickOnlyLong);
assert.equal(classify(wickOnlyLong), "Momentum breakout");
assert.equal(classify(wickOnlyShort), "Momentum breakout");

const minus3OnLevel = momentumFixture("long", {
  minus3: { open: 104.5, high: 105.4, low: 104.2, close: 105 }
});
const minus2OnLevel = momentumFixture("long", {
  minus2: { open: 104.8, high: 105.2, low: 104.6, close: 105 }
});
assert.equal(classify(minus3OnLevel), "Momentum breakout", "a close equal to resistance is not a prior breakout");
assert.equal(classify(minus2OnLevel), "Momentum breakout", "the existing strict trigger semantics permit equality before breakout");
assert.equal(classify(mirrorFixture(minus3OnLevel)), "Momentum breakout");
assert.equal(classify(mirrorFixture(minus2OnLevel)), "Momentum breakout");

const staleAtMinus2 = momentumFixture("long", {
  minus2: { open: 104.8, high: 106.1, low: 104.6, close: 105.7 }
});
assert.equal(momentumEvidence(staleAtMinus2).priorBreakoutDetected, true);
assert.notEqual(classify(staleAtMinus2), "Momentum breakout");
assert.notEqual(classify(mirrorFixture(staleAtMinus2)), "Momentum breakout");

const priorBreakoutContinues = momentumFixture("long", {
  minus3: { open: 104.8, high: 106.1, low: 104.5, close: 105.7 },
  minus2: { open: 105.7, high: 106.3, low: 105.5, close: 106.1 },
  trigger: { open: 106.1, high: 106.8, low: 105.9, close: 106.6 }
});
assert.equal(momentumEvidence(priorBreakoutContinues).priorBreakoutDetected, true);
assert.notEqual(classify(priorBreakoutContinues), "Momentum breakout");
assert.notEqual(classify(mirrorFixture(priorBreakoutContinues)), "Momentum breakout");

const breakoutThenLevelThenRebreak = momentumFixture("long", {
  minus3: { open: 104.8, high: 106.1, low: 104.5, close: 105.7 },
  minus2: { open: 105.5, high: 105.8, low: 104.8, close: 105 }
});
assert.equal(momentumEvidence(breakoutThenLevelThenRebreak).priorBreakoutDetected, true);
assert.notEqual(classify(breakoutThenLevelThenRebreak), "Momentum breakout");

const freshEvidence = momentumEvidence(freshLong);
assert.deepEqual({
  start: freshEvidence.referenceWindowStartIndex,
  end: freshEvidence.referenceWindowEndIndex,
  minus3: freshEvidence.interveningCloseMinus3,
  minus2: freshEvidence.interveningCloseMinus2,
  trigger: freshEvidence.triggerIndex
}, {
  start: freshLong.candles.length - 24,
  end: freshLong.candles.length - 4,
  minus3: freshLong.candles.at(-3).close,
  minus2: freshLong.candles.at(-2).close,
  trigger: freshLong.candles.length - 1
});

const diagnosticContext = {
  candles: freshLong.candles,
  direction: "long",
  entryPrice: freshLong.candles.at(-1).close,
  stopLoss: 101,
  indicators: freshLong.indicators
};
const diagnostics = calculateMomentumEntryDiagnostics(diagnosticContext);
assert.ok(Number.isFinite(diagnostics.latestCandleRangeAtr));
assert.ok(Number.isFinite(diagnostics.breakoutDistanceAtr));
assert.equal(diagnostics.version, "momentum_entry_shadow_v1");
assert.match(diagnosticsSource, /const DIAGNOSTIC_VERSION = "momentum_entry_shadow_v1"/);

const evaluatorSource = generatorSource.match(
  /export function evaluateMomentumBreakoutSetup[\s\S]*?\n}\n\nexport function evaluateVwapReclaimRejectionSetup/
)?.[0] || "";
assert.ok(evaluatorSource, "focused Momentum evaluator source was not found");
assert.doesNotMatch(evaluatorSource, /1\.25|latestCandleRangeAtr|stopDistanceAtr|ema20DistanceAtr|breakoutDistanceAtr/);
assert.match(evaluatorSource, /candles\.slice\(-24, -3\)/);
assert.match(evaluatorSource, /candles\.slice\(-3, -1\)/);
assert.match(generatorSource, /setupType === "Momentum breakout"[\s\S]*?evaluateMomentumBreakoutSetup/);
const riskCall = generatorSource.match(/buildDynamicRiskPlan\(\{[\s\S]*?\}\);/)?.[0] || "";
assert.doesNotMatch(riskCall, /strategyEvidence/);

console.log(JSON.stringify({
  oldRule: {
    referenceWindow: "slice(-24, -3) => relative indexes -24 through -4 inclusive",
    freshnessChecked: "-2 only",
    triggerIndex: -1,
    staleLongAccepted: oldMomentumClassifies(staleLong),
    staleShortAccepted: oldMomentumClassifies(staleShort)
  },
  newRule: {
    referenceWindowStartIndex: freshEvidence.referenceWindowStartIndex,
    referenceWindowEndIndex: freshEvidence.referenceWindowEndIndex,
    freshnessIndexes: [-3, -2],
    priorLongBreakout: "close > reference resistance",
    priorShortBreakout: "close < reference support",
    equalityIsBreakout: false,
    wickOnlyIsBreakout: false,
    triggerIndex: freshEvidence.triggerIndex
  },
  mirrored: true,
  prospectiveDiagnosticsVersion: diagnostics.version,
  antiChaseFilterAdded: false,
  evidence: freshEvidence
}, null, 2));

function momentumFixture(direction, overrides = {}) {
  const candles = Array.from({ length: 30 }, (_, index) => ({
    time: 1_920_000_000 + index * 900,
    open: 102.5,
    high: index === 12 ? 105 : 104.5,
    low: 100,
    close: 102.8,
    volume: 100
  }));
  candles[27] = applyCandle(candles[27], {
    open: 104.4,
    high: 104.9,
    low: 104.1,
    close: 104.8,
    ...overrides.minus3
  });
  candles[28] = applyCandle(candles[28], {
    open: 104.7,
    high: 105.1,
    low: 104.5,
    close: 104.9,
    ...overrides.minus2
  });
  candles[29] = applyCandle(candles[29], {
    open: 104.9,
    high: 106.5,
    low: 104.7,
    close: 106.1,
    volume: 150,
    ...overrides.trigger
  });
  const fixture = {
    direction,
    candles,
    indicators: { ema20: 103, ema50: 101, rsi14: 58, atr14: 2, volumeMa20: 100 },
    levels: {
      nearestSupport: { price: 98 },
      nearestResistance: { price: 110 },
      supportStrength: 3,
      resistanceStrength: 3
    },
    regime: { label: "Breakout", trendStrength: 0.7 },
    advancedStructure: { vwap: { event: "None" } },
    confluenceContext: { higherTimeframes: [] }
  };
  return direction === "short" ? mirrorFixture(fixture) : fixture;
}

function mirrorFixture(fixture) {
  const mirrorPrice = (value) => 200 - Number(value);
  return {
    ...fixture,
    direction: fixture.direction === "short" ? "long" : "short",
    candles: fixture.candles.map((item) => ({
      ...item,
      open: mirrorPrice(item.open),
      high: mirrorPrice(item.low),
      low: mirrorPrice(item.high),
      close: mirrorPrice(item.close)
    })),
    indicators: {
      ...fixture.indicators,
      ema20: mirrorPrice(fixture.indicators.ema20),
      ema50: mirrorPrice(fixture.indicators.ema50)
    },
    levels: {
      nearestSupport: { price: mirrorPrice(fixture.levels.nearestResistance.price) },
      nearestResistance: { price: mirrorPrice(fixture.levels.nearestSupport.price) },
      supportStrength: fixture.levels.resistanceStrength,
      resistanceStrength: fixture.levels.supportStrength
    }
  };
}

function applyCandle(base, values) {
  return { ...base, ...values, volume: values.volume ?? base.volume };
}

function classify(fixture) {
  return classifySetupType(
    fixture.direction,
    fixture.candles,
    fixture.indicators,
    fixture.levels,
    fixture.regime,
    null,
    fixture.advancedStructure,
    fixture.confluenceContext
  );
}

function momentumEvidence(fixture) {
  return evaluateMomentumBreakoutSetup(fixture.direction, fixture.candles);
}

function oldMomentumClassifies(fixture) {
  const candles = fixture.candles;
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const priorWindow = candles.slice(-24, -3);
  const referenceLevel = fixture.direction === "long"
    ? Math.max(...priorWindow.map((item) => item.high))
    : Math.min(...priorWindow.map((item) => item.low));
  const directionalBreakout = fixture.direction === "long"
    ? previous.close <= referenceLevel && latest.close > referenceLevel && latest.close > latest.open
    : previous.close >= referenceLevel && latest.close < referenceLevel && latest.close < latest.open;
  const aligned = fixture.direction === "long"
    ? latest.close > fixture.indicators.ema20 && fixture.indicators.ema20 > fixture.indicators.ema50
    : latest.close < fixture.indicators.ema20 && fixture.indicators.ema20 < fixture.indicators.ema50;
  return directionalBreakout && aligned && latest.volume >= fixture.indicators.volumeMa20 * 1.02;
}
