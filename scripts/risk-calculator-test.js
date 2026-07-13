import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateRiskPosition } from "../public/riskCalculator.js";

const long = calculateRiskPosition({
  direction: "long",
  entryPrice: 100,
  stopLoss: 98,
  takeProfit: 104.8,
  accountSize: 100,
  riskPercent: 1
});
assert.equal(long.valid, true);
assert.equal(long.riskAmount, 1);
assert.equal(long.quantity, 0.5);
assert.equal(long.positionSize, 50);
assert.ok(Math.abs(long.potentialProfit - 2.4) < 1e-9);
assert.ok(Math.abs(long.riskReward - 2.4) < 1e-9);

const short = calculateRiskPosition({
  direction: "short",
  entryPrice: 250,
  stopLoss: 255,
  takeProfit: 240,
  accountSize: 5000,
  riskPercent: 0.5
});
assert.equal(short.valid, true);
assert.equal(short.riskAmount, 25);
assert.equal(short.quantity, 5);
assert.equal(short.positionSize, 1250);
assert.equal(short.potentialProfit, 50);
assert.equal(short.riskReward, 2);

assert.equal(calculateRiskPosition({ direction: "long", entryPrice: 100, stopLoss: 101, takeProfit: 110, accountSize: 1000, riskPercent: 1 }).valid, false);
assert.equal(calculateRiskPosition({ direction: "short", entryPrice: 100, stopLoss: 99, takeProfit: 90, accountSize: 1000, riskPercent: 1 }).valid, false);
assert.equal(calculateRiskPosition({ direction: "long", entryPrice: 100, stopLoss: 100, takeProfit: 110, accountSize: 1000, riskPercent: 1 }).valid, false);

const tinyPrice = calculateRiskPosition({
  direction: "long",
  entryPrice: 0.00001,
  stopLoss: 0.000009,
  takeProfit: 0.000012,
  accountSize: 1000,
  riskPercent: 1,
  customRiskAmount: 5
});
assert.equal(tinyPrice.valid, true);
assert.ok(Number.isFinite(tinyPrice.quantity));
assert.equal(tinyPrice.riskAmount, 5);
assert.equal(tinyPrice.riskPercent, 0.5);

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const reveal = app.slice(app.indexOf("function renderUnlockReveal()"), app.indexOf("function closeUnlockReveal()"));

assert.ok(reveal.indexOf("unlock-critical-levels") < reveal.indexOf("renderRiskCalculator(signal"));
assert.ok(reveal.indexOf("renderRiskCalculator(signal") < reveal.indexOf("renderPaperTradeAction(signal, true)"));
assert.ok(app.includes('data-risk-quick="${percent}"'));
assert.ok(app.includes("riskPercent > 3"));
assert.ok(app.includes("RISK_ACCOUNT_SIZE_KEY"));
assert.ok(app.includes("RISK_PERCENT_KEY"));
assert.ok(app.includes("paperOrderQuantity.value = formatCalculatorNumber(sizing.quantity"));
assert.ok(app.includes("paperOrderSize.value = formatCalculatorNumber(sizing.positionSize"));
assert.ok(css.includes(".signal-risk-calculator"));
assert.ok(css.includes(".risk-calculator-inputs {\n    grid-template-columns: 1fr;"));
assert.ok(css.includes("overflow-wrap: anywhere"));

console.log("Risk calculator tests passed.");
