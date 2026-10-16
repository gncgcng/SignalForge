// Backtesting Lab UI: the market picker is built from /api/backtesting/markets (any Coinbase USD pair), a selected
// pair below the liquidity floor shows "Low liquidity: backtest results may be unreliable.", results repeat it,
// the page has "Want stocks & ETFs? Tell us", and Admin shows the request count.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("../public/index.html");
const app = read("../public/app.js");
const controller = read("../src/modules/backtesting/backtestController.js");
const service = read("../src/modules/backtesting/backtestService.js");
const warning = "Low liquidity: backtest results may be unreliable.";

const result = {
  pickerFromServer: app.includes('api.request("/api/backtesting/markets")') &&
    html.includes('id="lab-market-options"') &&
    html.includes('id="lab-market-search"'),
  pickerMarksPairs: app.includes("lab-market-low-liquidity") &&
    app.includes("Low liquidity</small>") &&
    app.includes("Not scanned</small>"),
  warningOnSelection: html.includes('id="lab-market-warning"') &&
    app.includes(`\`${warning} (`) &&
    app.includes('labMarketOptions?.addEventListener("change", updateBacktestLiquidityWarning)'),
  warningOnResults: app.includes("report.warnings") && service.includes(`"${warning}"`),
  stocksAsk: html.includes("Want stocks &amp; ETFs?") &&
    html.includes('id="lab-stocks-request"') && html.includes(">Tell us</button>") &&
    app.includes('"/api/backtesting/stocks-request", { method: "POST"'),
  stocksRouteBeforePaidGate: controller.indexOf("/api/backtesting/stocks-request") < controller.indexOf("hasPaidAccess(req.user)"),
  marketsRouteAfterPaidGate: controller.indexOf("/api/backtesting/markets") > controller.indexOf("hasPaidAccess(req.user)"),
  adminCount: app.includes('["Stocks & ETFs requests", analytics.stocksEtfsRequests]'),
  noStockData: !/twelve|stock.*candles|getOhlcv/i.test(read("../src/modules/backtesting/featureRequestService.js"))
};

console.log(JSON.stringify(result, null, 2));
assert.ok(Object.values(result).every(Boolean), "backtest market picker checks failed");
