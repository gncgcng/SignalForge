import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  calculatePatternShadowModifier,
  detectChartPatterns,
  getPrimaryPatternContext
} from "../src/modules/patterns/patternDetector.js";
import { buildSignalQuality } from "../src/modules/signals/signalQualityService.js";

const hasPattern = (candles, pattern) => detectChartPatterns(candles, { timeframe: "15m" }).some((item) => item.pattern === pattern);

assert.ok(hasPattern(flagFixture("bull"), "bull_flag"), "bull flag was not detected");
assert.ok(hasPattern(flagFixture("bear"), "bear_flag"), "bear flag was not detected");
assert.ok(hasPattern(triangleFixture("ascending"), "ascending_triangle"), "ascending triangle was not detected");
assert.ok(hasPattern(triangleFixture("descending"), "descending_triangle"), "descending triangle was not detected");
assert.ok(hasPattern(triangleFixture("symmetrical"), "symmetrical_triangle"), "symmetrical triangle was not detected");
assert.ok(hasPattern(rectangleFixture("bull"), "bullish_rectangle"), "bullish rectangle was not detected");
assert.ok(hasPattern(rectangleFixture("bear"), "bearish_rectangle"), "bearish rectangle was not detected");
assert.ok(hasPattern(reversalFixture("double_top"), "double_top"), "double top was not detected");
assert.ok(hasPattern(reversalFixture("double_bottom"), "double_bottom"), "double bottom was not detected");
assert.ok(hasPattern(reversalFixture("head_and_shoulders"), "head_and_shoulders"), "head and shoulders was not detected");
assert.ok(hasPattern(reversalFixture("inverse_head_and_shoulders"), "inverse_head_and_shoulders"), "inverse head and shoulders was not detected");
assert.ok(hasPattern(choppyFixture(), "choppy_range"), "choppy range did not return avoid/watching context");
assert.ok(hasPattern(failedBreakoutFixture(), "failed_breakout"), "failed breakout was not detected");

const bullFlag = getPrimaryPatternContext(flagFixture("bull"), { timeframe: "15m" });
assert.equal(bullFlag.pattern, "bull_flag");
assert.equal(bullFlag.shadowMode, true);
assert.equal(bullFlag.confidenceModifier, 0);
assert.equal("entryPrice" in bullFlag, false, "pattern context leaked Entry");
assert.equal("stopLoss" in bullFlag, false, "pattern context leaked Stop Loss");
assert.equal("takeProfit" in bullFlag, false, "pattern context leaked Take Profit");
assert.equal("valid" in bullFlag, false, "pattern alone must not promote a signal");
assert.equal(calculatePatternShadowModifier({ sampleSize: 29, observedWinRate: 0.8 }), 0);
assert.equal(calculatePatternShadowModifier({ sampleSize: 30, observedWinRate: 0.61 }), 2);
assert.equal(calculatePatternShadowModifier({ sampleSize: 30, observedWinRate: 0.39 }), -2);
assert.equal(calculatePatternShadowModifier({ sampleSize: 30, observedWinRate: 0.5 }), 0);
assert.deepEqual(detectChartPatterns([], { timeframe: "15m" }), []);
assert.deepEqual(detectChartPatterns(makeCandles([1, 2, Number.NaN])), []);

const quality = buildSignalQuality({
  qualityScore: 82,
  confidenceScore: 84,
  riskRewardRatio: 2,
  patternContext: bullFlag,
  confirmations: []
});
assert.equal(quality.categories.patternContext.label, "Pattern context");
assert.match(quality.categories.patternContext.reason, /shadow mode/i);

const generatorSource = readFileSync("src/modules/signals/signalGenerator.js", "utf8");
const candidateSource = readFileSync("src/modules/signals/setupCandidateService.js", "utf8");
const repositorySource = readFileSync("src/modules/signals/setupCandidateRepository.js", "utf8");
const uiSource = readFileSync("public/app.js", "utf8");
const migration = readFileSync("migrations/042_chart_pattern_shadow_mode.sql", "utf8");
const audit = readFileSync("docs/chart-pattern-audit.md", "utf8");

assert.match(generatorSource, /detectChartPatterns/);
assert.doesNotMatch(generatorSource, /patternContext[^\n]*(?:valid\s*=|tradeAllowed)/, "pattern context must not control signal validity");
assert.match(candidateSource, /patternContext: sanitizePatternContext/);
assert.match(repositorySource, /detected_pattern/);
assert.match(repositorySource, /stats\.sample_size < 30 THEN 0/);
assert.match(repositorySource, /recordPromotedCandidatePatternOutcome/);
assert.match(repositorySource, /pattern_expected_move = CASE WHEN \$2 = 'Hit TP'/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS detected_pattern/);
assert.match(uiSource, /Pattern context/);
assert.match(uiSource, /Pattern recognition supports setup analysis/);
assert.match(audit, /Cup and handle \| Not supported \| Not supported/);
assert.match(audit, /Pattern confidence is separate from trade confidence/);

console.log("Chart pattern detection tests passed.");

function flagFixture(direction) {
  const impulse = Array.from({ length: 12 }, (_, index) => direction === "bull" ? 100 + index * 1.8 : 140 - index * 1.8);
  const start = impulse.at(-1);
  const consolidation = Array.from({ length: 24 }, (_, index) => {
    const drift = direction === "bull" ? -index * 0.13 : index * 0.13;
    return start + drift + Math.sin(index * 1.3) * 0.6;
  });
  return makeCandles([...impulse, ...consolidation], { volume: (index) => index < 12 ? 2000 : 1100 - index * 5 });
}

function triangleFixture(type) {
  const candles = [];
  for (let index = 0; index < 30; index += 1) {
    let high;
    let low;
    if (type === "ascending") { high = 120 + Math.sin(index) * 0.08; low = 100 + index * 0.55; }
    else if (type === "descending") { high = 140 - index * 0.55; low = 120 + Math.sin(index) * 0.08; }
    else { high = 140 - index * 0.42; low = 100 + index * 0.42; }
    const close = (high + low) / 2 + Math.sin(index * 1.7) * 0.12;
    candles.push(candle(index, close, high, low, 1200 - index * 6));
  }
  return candles;
}

function rectangleFixture(direction) {
  const prior = Array.from({ length: 12 }, (_, index) => direction === "bull" ? 100 + index * 1.2 : 140 - index * 1.2);
  const start = prior.at(-1);
  const range = Array.from({ length: 20 }, (_, index) => start + Math.sin(index * Math.PI / 2) * 1.2);
  return makeCandles([...prior, ...range], { wick: 0.45 });
}

function reversalFixture(type) {
  const anchors = {
    double_top: [[0, 100], [8, 108], [14, 100], [22, 108.2], [30, 99], [42, 96]],
    double_bottom: [[0, 108], [8, 100], [14, 108], [22, 99.8], [30, 109], [42, 112]],
    head_and_shoulders: [[0, 98], [7, 107], [13, 100], [20, 114], [27, 100], [34, 107.4], [41, 98], [47, 95]],
    inverse_head_and_shoulders: [[0, 112], [7, 103], [13, 110], [20, 96], [27, 110], [34, 102.6], [41, 112], [47, 115]]
  }[type];
  return makePointCandles(interpolateAnchors(anchors), 0.28);
}

function choppyFixture() {
  return makeCandles(Array.from({ length: 36 }, (_, index) => 100 + Math.sin(index * 1.8) * 1.1), { wick: 0.35 });
}

function failedBreakoutFixture() {
  const values = Array.from({ length: 28 }, (_, index) => 100 + Math.sin(index * 1.4) * 1.1);
  values.push(103.4, 100.8);
  return makeCandles(values, { wick: 0.3 });
}

function interpolateAnchors(anchors) {
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

function makeCandles(values, options = {}) {
  const wick = options.wick ?? 0.25;
  return values.map((close, index) => {
    const open = index ? values[index - 1] : close - 0.1;
    return {
      time: 1700000000 + index * 900,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
      volume: typeof options.volume === "function" ? options.volume(index) : 1000
    };
  });
}

function makePointCandles(values, wick = 0.25) {
  return values.map((close, index) => ({
    time: 1700000000 + index * 900,
    open: close,
    high: close + wick,
    low: close - wick,
    close,
    volume: 1000
  }));
}

function candle(index, close, high, low, volume) {
  return { time: 1700000000 + index * 900, open: close, high, low, close, volume };
}
