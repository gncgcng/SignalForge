import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculatePaperStats } from "../src/modules/paper-trading/paperTradingService.js";

const trades = [
  trade("BTC-USD", "1h", "Hit TP", 2),
  trade("BTC-USD", "4h", "Hit SL", -1),
  trade("ETH-USD", "1h", "Hit TP", 2.5),
  trade("SOL-USD", "15m", "Expired", 0),
  trade("XAU/USD", "4h", "Open", 0)
];
const stats = calculatePaperStats(trades);

assert.equal(stats.totalPaperTrades, 5);
assert.equal(stats.winRate, 67);
assert.equal(stats.averageR, 0.88);
assert.equal(stats.bestMarket.label, "ETH-USD");
assert.equal(stats.bestTimeframe.label, "1h");

const migration = readFileSync(
  new URL("../migrations/009_paper_trades.sql", import.meta.url),
  "utf8"
);
const repositories = readFileSync(
  new URL("../src/db/repositories.js", import.meta.url),
  "utf8"
);
const service = readFileSync(
  new URL("../src/modules/paper-trading/paperTradingService.js", import.meta.url),
  "utf8"
);
const controller = readFileSync(
  new URL("../src/modules/paper-trading/paperTradingController.js", import.meta.url),
  "utf8"
);
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const result = {
  persistentAndUserScoped: migration.includes("CREATE TABLE IF NOT EXISTS paper_trades") &&
    migration.includes("UNIQUE (user_id, saved_signal_id)") &&
    repositories.includes("WHERE p.user_id = $1 AND s.user_id = $1"),
  unlockedSignalsOnly: repositories.includes("JOIN unlocked_signals u") &&
    repositories.includes("u.user_id = $2"),
  outcomeTrackingReused: repositories.includes("LEFT JOIN signal_outcomes o") &&
    repositories.includes('signal.status === "Active" ? "Open" : signal.status') &&
    service.includes("updateSignalsForUser(user)"),
  rMultipleOnly: repositories.includes("realizedR") &&
    repositories.includes("signal.riskRewardRatio") &&
    app.includes("formatR("),
  statsCorrect: stats.totalPaperTrades === 5 &&
    stats.winRate === 67 &&
    stats.averageR === 0.88 &&
    stats.bestMarket.label === "ETH-USD" &&
    stats.bestTimeframe.label === "1h",
  apiProtected: controller.includes("Authentication required.") &&
    server.includes("handlePaperTradingRoutes"),
  noCreditsChanged: !service.includes("recordSignalUsage") &&
    !service.includes("incrementTrialSignalsUsed"),
  uiPresent: html.includes('data-view-link="paper-portfolio"') &&
    html.includes('data-view="paper-portfolio"') &&
    app.includes("data-paper-signal-id"),
  disclaimerPresent: html.includes("Paper trading only. No real orders are placed."),
  noBrokerIntegration: ![
    migration,
    repositories,
    service,
    controller,
    app
  ].join("\n").toLowerCase().includes("broker")
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}

function trade(symbol, timeframe, status, realizedR) {
  return { symbol, timeframe, status, realizedR };
}
