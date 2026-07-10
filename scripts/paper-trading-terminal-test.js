import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  calculatePaperClose,
  evaluatePaperOrderCandle,
  normalizePaperOrder,
  validatePaperOrder
} from "../src/modules/paper-trading/paperTradingService.js";

const longMarket = normalizePaperOrder({
  symbol: "BTC-USD", timeframe: "15m", direction: "long", orderType: "market",
  positionSizeUsd: 1000, stopLoss: 95, takeProfit: 110
}, 100);
assert.equal(longMarket.status, "Open");
assert.equal(longMarket.quantity, 10);
assert.deepEqual(validatePaperOrder(longMarket), []);

const limit = normalizePaperOrder({
  symbol: "ETH-USD", timeframe: "1h", direction: "long", orderType: "limit",
  quantity: 2, limitPrice: 100, stopLoss: 95, takeProfit: 110
}, 103);
assert.equal(limit.status, "Pending");
assert.equal(evaluatePaperOrderCandle(limit, { low: 101, high: 105 }).action, "none");
assert.deepEqual(evaluatePaperOrderCandle(limit, { low: 99, high: 102 }), { action: "fill", price: 100 });

const openLong = { ...longMarket, status: "Open", entryPrice: 100 };
assert.equal(evaluatePaperOrderCandle(openLong, { low: 99, high: 111 }).status, "Hit TP");
assert.equal(evaluatePaperOrderCandle(openLong, { low: 94, high: 102 }).status, "Hit SL");

const openShort = { ...openLong, direction: "short", stopLoss: 105, takeProfit: 90 };
assert.equal(evaluatePaperOrderCandle(openShort, { low: 89, high: 102 }).status, "Hit TP");
assert.equal(evaluatePaperOrderCandle(openShort, { low: 98, high: 106 }).status, "Hit SL");
assert.equal(calculatePaperClose(openLong, 105).realizedPnl, 50);

assert.ok(validatePaperOrder({ ...longMarket, stopLoss: 101 }).some((error) => error.includes("below entry")));
assert.ok(validatePaperOrder({ ...openShort, intendedEntry: 100, stopLoss: 99 }).some((error) => error.includes("above entry")));
assert.ok(validatePaperOrder({ ...longMarket, quantity: NaN }).some((error) => error.includes("finite")));

const migration = readFileSync(new URL("../migrations/030_paper_trading_terminal.sql", import.meta.url), "utf8");
const repository = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const service = readFileSync(new URL("../src/modules/paper-trading/paperTradingService.js", import.meta.url), "utf8");
const controller = readFileSync(new URL("../src/modules/paper-trading/paperTradingController.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

const checks = {
  freeAuthenticatedAccess: controller.includes("Authentication required.") &&
    !controller.includes("subscription") && !service.includes("unlockCreditsBalance"),
  marketSwitching: app.includes("data-paper-market") && app.includes("state.paperTrading.selectedSymbol = button.dataset.paperMarket"),
  timeframeSwitching: app.includes("data-paper-timeframe") && app.includes("state.paperTrading.timeframe = button.dataset.paperTimeframe"),
  marketOrderOpens: longMarket.status === "Open" && controller.includes("placePaperOrder"),
  limitWaitsForTouch: limit.status === "Pending" && service.includes('event.action === "fill"'),
  longAndShortOutcomes: service.includes('order.direction === "long" ? low <= order.stopLoss') && service.includes('order.direction === "long" ? high >= order.takeProfit'),
  invalidLevelsRejected: service.includes("validatePaperOrder(normalized)") && service.includes("LONG stop loss must be below entry"),
  signalPrefill: app.includes("prefillPaperOrderFromSignal(signal)") && app.includes("paperOrderSignalId.value = signal.id") && app.includes('paperOrderType.value = "limit"'),
  duplicateSignalBlocked: migration.includes("idx_paper_orders_user_signal") && repository.includes("SELECT saved_signal_id FROM paper_trades") && repository.includes("ON CONFLICT"),
  legacyTradesPreserved: migration.includes("Migrated from SignalForge Paper Portfolio") && migration.includes("FROM paper_trades p") && migration.includes("ON CONFLICT DO NOTHING"),
  manualClosePersisted: controller.includes("closePaperPosition") && repository.includes("realized_pnl = $6") && repository.includes("balance = balance + $2"),
  resetRequiresConfirmation: app.includes("window.confirm") && service.includes('confirmation !== "RESET"') && repository.includes("archived_at = now()"),
  responsiveNoOverflow: css.includes(".paper-chart-panel { order: 1;") && css.includes(".paper-order-panel { order: 2;") && css.includes(".paper-order-table { overflow: visible;") && html.includes('id="paper-candle-chart"'),
  noBrokerOrCredits: ![migration, service, controller].join("\n").toLowerCase().includes("broker") && !service.includes("recordDiscoveryUsage")
};

for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, `Paper terminal check failed: ${name}`);
console.log(JSON.stringify(checks, null, 2));
