import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  analyzeAdvancedMarketStructure,
  evaluateAdvancedStructure
} from "../src/modules/market-data/advancedMarketStructureService.js";
import {
  buildCorrelationContext,
  buildCorrelationSnapshot,
  evaluateCorrelationContext
} from "../src/modules/market-data/correlationService.js";
import { strategyComponentNames } from "../src/modules/backtesting/backtestService.js";
import { buildPerformanceAnalytics } from "../src/modules/performance/performanceService.js";

const candles = buildCandles(1);
const structure = analyzeAdvancedMarketStructure(candles);
assert.equal(structure.available, true);
assert.ok(Number.isFinite(structure.vwap.session.value));
assert.ok(Number.isFinite(structure.vwap.anchored.value));
assert.ok(Number.isFinite(structure.volumeProfile.poc));
assert.ok(structure.volumeProfile.valueAreaHigh > structure.volumeProfile.valueAreaLow);
assert.ok(structure.chartZones.profile.length === 3);

const longStructure = evaluateAdvancedStructure(structure, "long", candles.at(-1).close);
assert.equal(longStructure.available, true);
assert.equal(longStructure.factors.length, 2);

const unavailable = analyzeAdvancedMarketStructure(
  candles.map((candle) => ({ ...candle, volume: 0 })),
  { volumeAvailable: false }
);
assert.equal(unavailable.available, false);

const snapshot = buildCorrelationSnapshot({
  "BTC-USD": buildCandles(1),
  "ETH-USD": buildCandles(1.02),
  "SOL-USD": buildCandles(-0.9)
}, "1h");
const context = buildCorrelationContext(snapshot, "BTC-USD");
assert.equal(context.available, true);
assert.ok(context.peers.some((peer) => peer.symbol === "ETH-USD" && peer.correlation > 0.9));

const aligned = evaluateCorrelationContext(context, "long");
assert.ok(Number.isFinite(aligned.confidenceAdjustment));

const breakdownSnapshot = buildCorrelationSnapshot({
  "BTC-USD": candlesFromReturns([
    ...Array.from({ length: 35 }, (_, index) => 0.002 + Math.sin(index) * 0.001),
    ...Array.from({ length: 35 }, (_, index) => 0.002 + Math.cos(index) * 0.001)
  ]),
  "ETH-USD": candlesFromReturns([
    ...Array.from({ length: 35 }, (_, index) => 0.002 + Math.sin(index) * 0.001),
    ...Array.from({ length: 35 }, (_, index) => -(0.002 + Math.cos(index) * 0.001))
  ])
}, "1h");
assert.equal(
  buildCorrelationContext(breakdownSnapshot, "BTC-USD").peers[0].breakdown,
  true
);

for (const component of ["vwap", "volumeProfile", "correlation"]) {
  assert.ok(strategyComponentNames.includes(component));
}

const performance = buildPerformanceAnalytics([
  signal("Hit TP", true, true, true),
  signal("Hit SL", false, false, false)
]);
assert.equal(performance.vwapPerformance.length, 2);
assert.equal(performance.volumeProfilePerformance.length, 2);
assert.equal(performance.correlationPerformance.length, 2);

const correlationSource = readFileSync(
  new URL("../src/modules/market-data/correlationService.js", import.meta.url),
  "utf8"
);
const backtesting = readFileSync(
  new URL("../src/modules/backtesting/backtestService.js", import.meta.url),
  "utf8"
);
const generator = readFileSync(
  new URL("../src/modules/signals/signalGenerator.js", import.meta.url),
  "utf8"
);
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

assert.ok(correlationSource.includes("getCachedOhlcv(symbol, timeframe)"));
assert.ok(correlationSource.includes('category === "Crypto"'));
assert.ok(backtesting.includes("candle.time <= latest.time"));
assert.ok(backtesting.includes("advancedStructureComparison"));
assert.ok(generator.includes("evaluateAdvancedStructure"));
assert.ok(generator.includes("evaluateCorrelationContext"));
assert.ok(html.includes("Correlation Matrix"));
assert.ok(app.includes("chart-profile-zone"));

console.log("Advanced Market Structure tests passed.");

function buildCandles(direction) {
  return Array.from({ length: 100 }, (_, index) => {
    const base = 100 + direction * index * 0.18;
    const close = base + Math.sin(index * 0.4) * 0.25;
    const open = base - direction * 0.08;
    return {
      time: 1_700_000_000 + index * 3600,
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
      volume: 1000 + (index % 12) * 100
    };
  });
}

function signal(status, vwapAligned, volumeProfileAligned, correlationAligned) {
  return {
    symbol: "BTC-USD",
    timeframe: "1h",
    direction: "long",
    generatedAt: "2026-06-01T00:00:00.000Z",
    status,
    riskRewardRatio: 2,
    confidenceScore: 80,
    indicators: {
      regime: "Trend Up",
      confluenceScore: 80,
      vwapAligned,
      volumeProfileAligned,
      correlationAligned,
      correlationConflict: false
    }
  };
}

function candlesFromReturns(returns) {
  let close = 100;
  return [
    {
      time: 1_700_000_000,
      open: close,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 1000
    },
    ...returns.map((value, index) => {
      const open = close;
      close *= Math.exp(value);
      return {
        time: 1_700_000_000 + (index + 1) * 3600,
        open,
        high: Math.max(open, close) + 0.1,
        low: Math.min(open, close) - 0.1,
        close,
        volume: 1000
      };
    })
  ];
}
