import assert from "node:assert/strict";
import {
  analyzeSmartMoneyConcepts,
  evaluateSmcConfluence
} from "../src/modules/market-data/smartMoneyConceptsService.js";
import { strategyComponentNames } from "../src/modules/backtesting/backtestService.js";
import { buildPerformanceAnalytics } from "../src/modules/performance/performanceService.js";

const candles = [
  candle(0, 100, 102, 98, 101),
  candle(1, 101, 104, 99, 103),
  candle(2, 103, 106, 101, 105),
  candle(3, 105, 108, 103, 107),
  candle(4, 107, 110, 105, 108),
  candle(5, 108, 109, 103, 104),
  candle(6, 104, 106, 98, 100),
  candle(7, 100, 102, 94, 96),
  candle(8, 96, 99, 90, 94),
  candle(9, 94, 100, 92, 98),
  candle(10, 98, 104, 96, 102),
  candle(11, 102, 108, 100, 106),
  candle(12, 106, 111, 104, 108),
  candle(13, 108, 113, 107, 112),
  candle(14, 112, 114, 111, 113),
  candle(15, 114, 117, 113.5, 116),
  candle(16, 116, 118, 115, 117),
  candle(17, 117, 119, 114, 115)
];

const analysis = analyzeSmartMoneyConcepts(candles);
assert.equal(analysis.liquiditySweep?.type, "buy-side");
assert.ok(analysis.structure.events.some((event) => event.direction === "long"));
assert.ok(analysis.fairValueGaps.recent.some((gap) => gap.type === "bullish"));
assert.ok(analysis.orderBlocks.recent.some((block) => block.direction === "long"));

const longConfluence = evaluateSmcConfluence(analysis, "long", {
  label: "Trend Up",
  preferredDirection: "long"
});
assert.ok(longConfluence.factors.some((factor) => factor.passed));
assert.equal(longConfluence.conflict, false);

const conflictingShort = evaluateSmcConfluence(analysis, "short", {
  label: "Trend Up",
  preferredDirection: "long"
});
assert.equal(conflictingShort.conflict, true);
assert.ok(conflictingShort.confidenceAdjustment < 0);

for (const component of ["liquiditySweeps", "fairValueGaps", "orderBlocks", "structure"]) {
  assert.ok(strategyComponentNames.includes(component));
}

const performance = buildPerformanceAnalytics([
  performanceSignal("Hit TP", 2, longConfluence.factors),
  performanceSignal("Hit SL", 2, longConfluence.factors)
]);
assert.equal(performance.smcPerformance.length, 4);
assert.ok(performance.smcPerformance.some((item) => item.totalSignals === 2));

console.log("Smart Money Concepts tests passed.");

function candle(index, open, high, low, close) {
  return {
    time: 1_700_000_000 + index * 3600,
    open,
    high,
    low,
    close,
    volume: 1000 + index
  };
}

function performanceSignal(status, riskRewardRatio, factors) {
  return {
    symbol: "BTC-USD",
    timeframe: "1h",
    direction: "long",
    generatedAt: "2026-06-01T00:00:00.000Z",
    status,
    riskRewardRatio,
    confidenceScore: 80,
    indicators: {
      regime: "Trend Up",
      confluenceScore: 80,
      smcFactors: factors
    }
  };
}
