import assert from "node:assert/strict";
import {
  calculateBacktestMetrics,
  evaluateTradeOutcome
} from "../src/modules/backtesting/backtestService.js";

const longSignal = {
  direction: "long",
  stopLoss: 98,
  takeProfit: 104,
  riskRewardRatio: 2
};

const targetOutcome = evaluateTradeOutcome(longSignal, [
  { high: 102, low: 99 },
  { high: 104.5, low: 100 }
], 10);
assert.equal(targetOutcome.status, "Hit TP");
assert.equal(targetOutcome.realizedR, 2);
assert.equal(targetOutcome.exitIndex, 11);

const stopOutcome = evaluateTradeOutcome(longSignal, [
  { high: 105, low: 97 }
], 20);
assert.equal(
  stopOutcome.status,
  "Hit SL",
  "A candle touching both levels must be scored conservatively as Hit SL."
);

const metrics = calculateBacktestMetrics([
  { outcome: "Hit TP", realizedR: 2, qualityScore: 88 },
  { outcome: "Hit SL", realizedR: -1, qualityScore: 80 },
  { outcome: "Hit SL", realizedR: -1, qualityScore: 82 },
  { outcome: "Hit TP", realizedR: 2.2, qualityScore: 90 },
  { outcome: "Expired", realizedR: 0, qualityScore: 84 }
]);

assert.equal(metrics.totalTrades, 5);
assert.equal(metrics.winRate, 50);
assert.equal(metrics.averageR, 0.44);
assert.equal(metrics.netR, 2.2);
assert.equal(metrics.maxDrawdownR, 2);
assert.equal(metrics.averageQualityScore, 84.8);

console.log(JSON.stringify({
  targetOutcome,
  stopOutcome,
  metrics
}, null, 2));
