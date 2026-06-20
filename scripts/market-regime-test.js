import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeMarketRegime } from "../src/modules/market-data/marketRegimeService.js";

const trendUp = analyzeMarketRegime(buildTrend(1));
const trendDown = analyzeMarketRegime(buildTrend(-1));
const range = analyzeMarketRegime(buildRange());
const breakout = analyzeMarketRegime(buildBreakout());
const highVolatility = analyzeMarketRegime(buildHighVolatility());
const lowVolatility = analyzeMarketRegime(buildLowVolatility());

assert.equal(trendUp.label, "Trend Up");
assert.equal(trendDown.label, "Trend Down");
assert.equal(range.label, "Range");
assert.equal(breakout.label, "Breakout");
assert.equal(highVolatility.label, "High Volatility");
assert.equal(lowVolatility.label, "Low Volatility");

for (const regime of [trendUp, trendDown, range, breakout, highVolatility, lowVolatility]) {
  assert.ok(Number.isFinite(regime.metrics.adx14));
  assert.ok(Number.isFinite(regime.metrics.atr14));
  assert.ok(Number.isFinite(regime.metrics.rsi14));
  assert.ok(regime.explanation.length > 30);
}

const signalGenerator = readFileSync(
  new URL("../src/modules/signals/signalGenerator.js", import.meta.url),
  "utf8"
);
const marketDataService = readFileSync(
  new URL("../src/modules/market-data/marketDataService.js", import.meta.url),
  "utf8"
);
const performanceService = readFileSync(
  new URL("../src/modules/performance/performanceService.js", import.meta.url),
  "utf8"
);
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const result = {
  allRegimesDetected: [
    trendUp.label,
    trendDown.label,
    range.label,
    breakout.label,
    highVolatility.label,
    lowVolatility.label
  ].join("|") === "Trend Up|Trend Down|Range|Breakout|High Volatility|Low Volatility",
  realIndicatorsUsed: ["ema20", "ema50", "atr14", "adx14", "rsi14", "support", "resistance", "structure"]
    .every((metric) => Object.hasOwn(trendUp.metrics, metric)),
  signalRulesRegimeAware: signalGenerator.includes("Trend Up only favors") &&
    signalGenerator.includes("Trend Down only favors") &&
    signalGenerator.includes("Range conditions avoid trend trades") &&
    signalGenerator.includes("Breakout conditions require a confirmed breakout retest") &&
    signalGenerator.includes("Low volatility conditions do not justify forcing a trade") &&
    signalGenerator.includes("candidate.confidenceScore - 8"),
  sharedLiveAnalysis: marketDataService.includes("analyzeMarketRegime(marketData.candles)"),
  uiCardPresent: html.includes("market-regime-card") &&
    html.includes("regime-explanation") &&
    app.includes("renderMarketRegime"),
  performanceByRegime: performanceService.includes("aggregateRegimePerformance") &&
    performanceService.includes("bestRegime") &&
    html.includes("signals-by-regime")
};

console.log(JSON.stringify({
  ...result,
  labels: {
    trendUp: trendUp.label,
    trendDown: trendDown.label,
    range: range.label,
    breakout: breakout.label,
    highVolatility: highVolatility.label,
    lowVolatility: lowVolatility.label
  }
}, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}

function buildTrend(direction) {
  return Array.from({ length: 100 }, (_, index) => {
    const close = 100 + direction * index * 0.35 + Math.sin(index * 0.45) * 0.08;
    const open = close - direction * 0.12;
    return candle(index, open, close, 0.22);
  });
}

function buildRange() {
  return Array.from({ length: 100 }, (_, index) => {
    const close = 100 + Math.sin(index * 0.55) * 1.4;
    const open = 100 + Math.sin((index - 1) * 0.55) * 1.4;
    return candle(index, open, close, 0.28);
  });
}

function buildBreakout() {
  const candles = buildRange();
  const previous = candles[candles.length - 2].close;
  candles[candles.length - 1] = candle(99, previous, 103.8, 0.8);
  return candles;
}

function buildHighVolatility() {
  return Array.from({ length: 100 }, (_, index) => {
    const expanded = index >= 88;
    const amplitude = expanded ? 3.8 : 0.45;
    const close = 100 + Math.sin(index * 0.9) * amplitude;
    const open = 100 + Math.sin((index - 1) * 0.9) * amplitude;
    return candle(index, open, close, expanded ? 1.2 : 0.18);
  });
}

function buildLowVolatility() {
  return Array.from({ length: 100 }, (_, index) => {
    const compressed = index >= 72;
    const amplitude = compressed ? 0.04 : 1.2;
    const close = 100 + Math.sin(index * 0.7) * amplitude;
    const open = 100 + Math.sin((index - 1) * 0.7) * amplitude;
    return candle(index, open, close, compressed ? 0.025 : 0.35);
  });
}

function candle(index, open, close, wick) {
  return {
    time: 1_700_000_000 + index * 3600,
    open,
    high: Math.max(open, close) + wick,
    low: Math.min(open, close) - wick,
    close,
    volume: 1000 + index * 3
  };
}
