import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildDynamicRiskPlan,
  calculatePositionSizing,
  maximumRiskPercent
} from "../src/modules/risk/riskEngineService.js";
import { calculateAccountGrowthCurve } from "../src/modules/paper-trading/paperTradingService.js";

const strongTrend = buildDynamicRiskPlan({
  direction: "long",
  entry: 100,
  atr: 2,
  regime: { label: "Trend Up", trendStrength: 0.85 },
  setupType: "Trend continuation",
  qualityScore: 90
});
const range = buildDynamicRiskPlan({
  direction: "long",
  entry: 100,
  atr: 2,
  regime: { label: "Range", trendStrength: 0.2 },
  setupType: "Reversal",
  qualityScore: 88
});
const highVolatility = buildDynamicRiskPlan({
  direction: "short",
  entry: 100,
  atr: 2,
  regime: { label: "High Volatility", trendStrength: 0.6 },
  setupType: "Trend continuation",
  qualityScore: 88
});

assert.equal(strongTrend.riskRewardRatio, 2.6);
assert.equal(range.riskRewardRatio, 1.8);
assert.ok(highVolatility.stopDistance > range.stopDistance);
assert.equal(maximumRiskPercent, 2);

const highQuality = calculatePositionSizing({
  accountSize: 10000,
  requestedRiskPercent: 2,
  qualityScore: 90,
  entryPrice: 100,
  stopLoss: 98,
  takeProfit: 104
});
assert.equal(highQuality.riskAmount, 200);
assert.equal(highQuality.positionSize, 100);
assert.equal(highQuality.potentialProfit, 400);

const mediumQuality = calculatePositionSizing({
  accountSize: 10000,
  requestedRiskPercent: 2,
  qualityScore: 82,
  entryPrice: 100,
  stopLoss: 98,
  takeProfit: 104
});
assert.equal(mediumQuality.effectiveRiskPercent, 1);
assert.equal(mediumQuality.riskAmount, 100);

const lowQuality = calculatePositionSizing({
  accountSize: 10000,
  requestedRiskPercent: 1,
  qualityScore: 70,
  entryPrice: 100,
  stopLoss: 98,
  takeProfit: 104
});
assert.equal(lowQuality.tradeAllowed, false);

const growth = calculateAccountGrowthCurve([
  paperTrade("2026-01-01", "Hit TP", 200),
  paperTrade("2026-01-02", "Hit SL", -100)
]);
assert.deepEqual(growth.map((point) => point.value), [10000, 10200, 10100]);

const migration = readFileSync(
  new URL("../migrations/011_dynamic_risk_paper_trades.sql", import.meta.url),
  "utf8"
);
const generator = readFileSync(
  new URL("../src/modules/signals/signalGenerator.js", import.meta.url),
  "utf8"
);
const backtesting = readFileSync(
  new URL("../src/modules/backtesting/backtestService.js", import.meta.url),
  "utf8"
);
const performance = readFileSync(
  new URL("../src/modules/performance/performanceService.js", import.meta.url),
  "utf8"
);
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

assert.ok(migration.includes("effective_risk_percent <= 2"));
assert.ok(generator.includes("newsRisk.blockSignal"));
assert.ok(generator.includes("buildDynamicRiskPlan"));
assert.ok(backtesting.includes('"fixed"') && backtesting.includes('"dynamic"'));
assert.ok(performance.includes("expectancyByRiskLevel"));
assert.ok(html.includes("Account growth curve"));
assert.ok(app.includes("Dynamic Risk Engine"));

console.log("Dynamic Risk Engine tests passed.");

function paperTrade(enteredAt, status, realizedPnl) {
  return {
    enteredAt,
    resolvedAt: enteredAt,
    status,
    accountSize: 10000,
    realizedPnl
  };
}
