import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  filterAndSortSignals,
  filtersFromSignalParams,
  getSignalStatusCounts,
  signalFiltersToParams
} from "../public/signalFilters.js";

const app = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");
const css = readFileSync("public/styles.css", "utf8");
const serviceWorker = readFileSync("public/service-worker.js", "utf8");
const now = new Date("2026-07-10T18:00:00.000Z");
const markets = [
  { symbol: "BTC-USD", displaySymbol: "BTCUSD", name: "Bitcoin", provider: "coinbase-exchange", providerLabel: "Coinbase" },
  { symbol: "ETH-USD", displaySymbol: "ETHUSD", name: "Ethereum", provider: "coinbase-exchange", providerLabel: "Coinbase" }
];
const signals = [
  signal("active-btc", "BTC-USD", "15m", "long", "Active", "Breakout Retest", 88, 2.2, "2026-07-10T16:00:00Z"),
  signal("active-eth", "ETH-USD", "1h", "short", "Active", "Trend Continuation", 82, 1.9, "2026-07-09T12:00:00Z"),
  signal("tp-btc", "BTC-USD", "15m", "long", "Hit TP", "Breakout Retest", 91, 2.5, "2026-07-08T12:00:00Z"),
  signal("sl-eth", "ETH-USD", "4h", "short", "Hit SL", "Trend Continuation", 78, 1.8, "2026-06-20T12:00:00Z"),
  signal("expired-btc", "BTC-USD", "1h", "long", "Expired", "Range Bounce", 74, 2, "2026-05-20T12:00:00Z"),
  { ...signal("manual-btc", "BTC-USD", "4h", "long", "Closed", "VWAP Reclaim", 80, 2, "2026-07-01T12:00:00Z"), resultR: 0.6 }
];

assert.deepEqual(filterAndSortSignals(signals, { status: "active" }, markets, now).map((item) => item.id), ["active-btc", "active-eth"]);
assert.deepEqual(filterAndSortSignals(signals, { status: "hit-tp" }, markets, now).map((item) => item.id), ["tp-btc"]);
assert.deepEqual(filterAndSortSignals(signals, { status: "hit-sl" }, markets, now).map((item) => item.id), ["sl-eth"]);
assert.deepEqual(filterAndSortSignals(signals, { status: "expired" }, markets, now).map((item) => item.id), ["expired-btc"]);
assert.deepEqual(filterAndSortSignals(signals, { status: "closed" }, markets, now).map((item) => item.id), ["tp-btc", "manual-btc", "sl-eth", "expired-btc"]);

assert.deepEqual(getSignalStatusCounts(signals), {
  all: 6,
  active: 2,
  "hit-tp": 1,
  "hit-sl": 1,
  expired: 1,
  closed: 4
});

assert.deepEqual(
  filterAndSortSignals(signals, {
    status: "active", pair: "BTC-USD", timeframe: "15m", direction: "long"
  }, markets, now).map((item) => item.id),
  ["active-btc"]
);
assert.deepEqual(filterAndSortSignals(signals, { search: "BTCUSD" }, markets, now).map((item) => item.symbol), ["BTC-USD", "BTC-USD", "BTC-USD", "BTC-USD"]);
assert.deepEqual(filterAndSortSignals(signals, { search: "BTC-USD" }, markets, now).map((item) => item.symbol), ["BTC-USD", "BTC-USD", "BTC-USD", "BTC-USD"]);
assert.equal(filterAndSortSignals(signals, { search: "Bitcoin" }, markets, now).length, 4);
assert.equal(filterAndSortSignals(signals, { search: "Coinbase BTC-USD" }, markets, now).length, 4);
assert.deepEqual(filterAndSortSignals(signals, { strategy: "Breakout Retest", dateRange: "7d" }, markets, now).map((item) => item.id), ["active-btc", "tp-btc"]);

const loaded = filtersFromSignalParams(new URLSearchParams("status=hit-tp&pair=BTCUSD&timeframe=15m&direction=long&sort=confidence&q=bitcoin"), signals);
assert.equal(loaded.status, "hit-tp");
assert.equal(loaded.pair, "BTCUSD");
assert.equal(loaded.timeframe, "15m");
assert.equal(loaded.direction, "long");
assert.equal(loaded.sort, "confidence");
assert.equal(loaded.search, "bitcoin");
assert.equal(filtersFromSignalParams(new URLSearchParams(), signals).status, "active");
assert.equal(filtersFromSignalParams(new URLSearchParams(), signals.filter((item) => item.status !== "Active")).status, "all");
assert.equal(signalFiltersToParams(loaded).get("status"), "hit-tp");

for (const text of [
  "No active signals right now.",
  "No take-profit signals yet.",
  "No stop-loss signals yet.",
  "No expired signals yet.",
  "Go to Scanner",
  "Open Paper Trading"
]) assert.match(app, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

assert.match(html, /id="history-status-filters"/);
assert.match(html, /Search pair, strategy, or notes/);
assert.match(app, /applySignalFiltersFromRoute\(params\)/);
assert.match(app, /signalFiltersToParams/);
assert.match(css, /\.signal-status-filters[\s\S]*overflow-x: auto/);
assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.history-filters[\s\S]*grid-template-columns: 1fr/);
assert.match(css, /html,[\s\S]*body[\s\S]*overflow-x: hidden/);
assert.match(serviceWorker, /"\/signalFilters\.js"/);

console.log("Signal history filtering tests passed.");

function signal(id, symbol, timeframe, direction, status, setupType, confidenceScore, riskRewardRatio, generatedAt) {
  return {
    id,
    symbol,
    timeframe,
    direction,
    status,
    setupType,
    confidenceScore,
    riskRewardRatio,
    generatedAt,
    reasoning: `${setupType} analysis notes`
  };
}
