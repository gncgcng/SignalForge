import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  backtestSymbols,
  backtestTimeframes,
  calculateBacktestMetrics,
  strategyComponentNames
} from "../src/modules/backtesting/backtestService.js";

const metrics = calculateBacktestMetrics([
  trade("Hit TP", 2),
  trade("Hit TP", 1.8),
  trade("Hit SL", -1),
  trade("Hit SL", -1),
  trade("Hit SL", -1),
  trade("Hit TP", 2.2),
  trade("Expired", 0)
]);

assert.equal(metrics.totalTrades, 7);
assert.equal(metrics.profitFactor, 2);
assert.equal(metrics.consecutiveWins, 2);
assert.equal(metrics.consecutiveLosses, 3);
assert.equal(metrics.expectancy, 0.43);

const service = readFileSync(new URL("../src/modules/backtesting/backtestService.js", import.meta.url), "utf8");
const controller = readFileSync(new URL("../src/modules/backtesting/backtestController.js", import.meta.url), "utf8");
const generator = readFileSync(new URL("../src/modules/signals/signalGenerator.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const requiredSymbols = [
  "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "ADA-USD", "DOGE-USD",
  "LINK-USD", "AVAX-USD", "LTC-USD", "XAU/USD", "XAG/USD", "WTI", "BRENT"
];
const result = {
  marketCoverage: requiredSymbols.every((symbol) => backtestSymbols.includes(symbol)),
  timeframeCoverage: ["15m", "1h", "4h"].every((timeframe) => backtestTimeframes.includes(timeframe)),
  componentCoverage: [
    "marketRegime", "multiTimeframe", "ema", "rsi", "adx", "atr", "supportResistance"
  ].every((component) => strategyComponentNames.includes(component)),
  historicalOnly: service.includes("candles.slice(0, index + 1)") &&
    service.includes("candle.time <= decisionTime") &&
    service.includes("candles.slice(index + 1, finalIndex + 1)"),
  requestedMetrics: [
    "profitFactor", "averageR", "maxDrawdownR", "consecutiveWins",
    "consecutiveLosses", "expectancy"
  ].every((metric) => service.includes(metric)),
  curvesAndBreakdowns: service.includes("equityCurve") &&
    service.includes("markets: aggregateWinRate") &&
    service.includes("timeframes: aggregateWinRate") &&
    service.includes("regimes: aggregateWinRate") &&
    service.includes("confluence: aggregateWinRate"),
  noEdgeState: service.includes('"No edge found"') && html.includes("lab-evaluation"),
  pagePresent: html.includes('data-view-link="backtesting"') &&
    html.includes('data-view="backtesting"') &&
    app.includes("renderBacktestingLab"),
  apiAuthenticated: controller.includes("Authentication required.") &&
    controller.includes("/api/backtesting/run"),
  productionIsolated: !service.includes("generateMarketDataSetup") &&
    generator.includes("export function generateMarketDataSetup")
};

console.log(JSON.stringify({ ...result, metrics }, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}

function trade(outcome, realizedR) {
  return { outcome, realizedR, qualityScore: 80 };
}
