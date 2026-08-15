process.env.CRYPTO_WATCHER_ENABLED = "false";
process.env.AUTO_SCAN_ENABLED = "false";
process.env.CRYPTO_MAX_ACTIVE_SCANNER_PAIRS = "1";
process.env.AUTO_SCAN_CRYPTO_ONLY = "true";
process.env.MARKET_VERIFICATION_ENABLED = "false";
process.env.CANDIDATE_SCAN_MARKETS_PER_CYCLE = "1";
process.env.TELEGRAM_BOT_TOKEN = "fixture-bot-token";

import assert from "node:assert/strict";

const FIXED_NOW_MS = Date.UTC(2026, 1, 3, 8, 30, 0);
const RealDate = globalThis.Date;
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const marketRequests = [];

class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [FIXED_NOW_MS])); }
  static now() { return FIXED_NOW_MS; }
}

globalThis.Date = FixedDate;
globalThis.fetch = deterministicFetch;
console.warn = () => {};

try {
  const db = await import("./test-support/auto-crypto-watcher-db-transport.mock.js");
  const { reloadCryptoMarketSettings, listEligibleScannerCryptoMarkets, listScannerCryptoMarkets } = await import(
    "../src/modules/markets/cryptoMarketService.js"
  );
  const { listAutoScannerPairs } = await import("../src/modules/market-data/marketDataService.js");
  const { runAutoCryptoAlertScan } = await import("../src/modules/alerts/autoScanService.js");

  await loadMarkets(db, reloadCryptoMarketSettings, [marketRow("ADA-USD"), marketRow("BTC-USD")]);
  db.configureWatcherUser({
    userId: "user-a",
    minimumConfidence: 90,
    symbols: ["BTC-USD"],
    timeframes: ["15m"],
    chatId: "10001"
  });
  db.configureWatcherUser({
    userId: "user-b",
    minimumConfidence: 90,
    symbols: ["ADA-USD"],
    timeframes: ["1h"],
    chatId: "10002"
  });
  db.configureAlertPreference({ userId: "user-a", symbol: "BTC-USD", timeframe: "15m" });
  db.configureAlertPreference({ userId: "user-b", symbol: "ADA-USD", timeframe: "1h" });

  assert.deepEqual(listEligibleScannerCryptoMarkets().map((market) => market.symbol), ["ADA-USD", "BTC-USD"]);
  assert.deepEqual(listScannerCryptoMarkets().map((market) => market.symbol), ["ADA-USD"]);
  assert.deepEqual(listAutoScannerPairs().map((market) => market.symbol), ["ADA-USD"]);

  const result = await runAutoCryptoAlertScan({ userId: "user-a", symbol: " BTC-USD ", timeframe: "15M" });
  const state = db.getAutoCryptoWatcherState();
  const marketBriefRefreshed = state.calls.some((call) => call.sql.includes("insert into daily_market_brief_observations"));
  const userLookups = state.calls
    .filter((call) => call.sql.includes("from users u") && call.sql.includes("where u.id = $1"))
    .map((call) => String(call.params[0]));

  assert.equal(result.scanned, 2, "scoped alert and Telegram paths should both evaluate BTC");
  assert.ok(state.generatedRows.length >= 1);
  assert.ok(state.candidates.length >= 1);
  assert.equal(state.generatedRows.every((row) => row.pair === "BTC-USD" && row.timeframe === "15m"), true);
  assert.equal(state.candidates.every((row) => row.symbol === "BTC-USD" && row.timeframe === "15m"), true);
  assert.equal(state.generatedRows.some((row) => row.pair === "ADA-USD"), false);
  assert.equal(state.candidates.some((row) => row.symbol === "ADA-USD"), false);
  assert.deepEqual([...new Set(userLookups)], ["user-a"]);
  assert.equal(marketBriefRefreshed, false);

  await assertIneligible(db, reloadCryptoMarketSettings, runAutoCryptoAlertScan, marketRow("BTC-USD", {
    status: "unavailable",
    market_status: "unavailable"
  }), "AUTO_SCAN_SCOPE_INELIGIBLE_MARKET");
  await assertIneligible(db, reloadCryptoMarketSettings, runAutoCryptoAlertScan, marketRow("BTC-USD", {
    enabled: false
  }), "AUTO_SCAN_SCOPE_INELIGIBLE_MARKET");
  await assertIneligible(db, reloadCryptoMarketSettings, runAutoCryptoAlertScan, marketRow("BTC-USD", {
    scanner_enabled: false
  }), "AUTO_SCAN_SCOPE_INELIGIBLE_MARKET");
  await assertIneligible(db, reloadCryptoMarketSettings, runAutoCryptoAlertScan, marketRow("BTC-USD", {
    provider: "unregistered-provider"
  }), "AUTO_SCAN_SCOPE_INELIGIBLE_MARKET");
  await assertIneligible(db, reloadCryptoMarketSettings, runAutoCryptoAlertScan, marketRow("BTC-USD", {
    supported_timeframes: ["5m"]
  }), "AUTO_SCAN_SCOPE_UNSUPPORTED_TIMEFRAME");

  console.log(JSON.stringify({
    broadSelection: ["ADA-USD"],
    uncappedEligibleSelection: ["ADA-USD", "BTC-USD"],
    scoped: {
      symbol: "BTC-USD",
      timeframe: "15m",
      users: ["user-a"],
      generated: state.generatedRows.length,
      candidates: state.candidates.length,
      marketBriefRefreshed,
      providerContextSymbols: [...new Set(marketRequests.map((request) => request.symbol))]
    },
    failClosed: {
      unavailable: true,
      disabled: true,
      scannerDisabled: true,
      providerUnregistered: true,
      timeframeUnsupported: true
    }
  }, null, 2));
} finally {
  globalThis.Date = RealDate;
  globalThis.fetch = realFetch;
  console.warn = realWarn;
}

async function loadMarkets(db, reloadCryptoMarketSettings, rows) {
  db.resetAutoCryptoWatcherTransport();
  db.configureCryptoMarketRows(rows);
  await reloadCryptoMarketSettings();
}

async function assertIneligible(db, reloadCryptoMarketSettings, runAutoCryptoAlertScan, row, code) {
  await loadMarkets(db, reloadCryptoMarketSettings, [row]);
  await assert.rejects(
    runAutoCryptoAlertScan({ userId: "user-a", symbol: "BTC-USD", timeframe: "15m" }),
    (error) => error.code === code
  );
}

function marketRow(symbol, overrides = {}) {
  return {
    symbol,
    display_symbol: symbol.replace("-", ""),
    provider_symbol: symbol,
    name: symbol === "BTC-USD" ? "Bitcoin" : "Cardano",
    provider: "coinbase-exchange",
    liquidity_tier: "major",
    enabled: true,
    scanner_enabled: true,
    paper_trading_enabled: true,
    watchlist_enabled: true,
    provider_status: "available",
    supported_timeframes: ["5m", "15m", "1h", "4h"],
    unsupported_timeframes: [],
    base_asset: symbol.split("-")[0],
    quote_asset: "USD",
    product_status: "online",
    trading_enabled: true,
    market_status: "active",
    verification_status: "verified",
    status: "active",
    verification_details: {},
    last_successful_candle_at: new Date(FIXED_NOW_MS - 15 * 60 * 1000).toISOString(),
    last_checked_at: new Date(FIXED_NOW_MS).toISOString(),
    last_verification_attempt_at: new Date(FIXED_NOW_MS).toISOString(),
    last_verified_at: new Date(FIXED_NOW_MS).toISOString(),
    last_error: null,
    failure_code: null,
    cooldown_until: null,
    consecutive_failures: 0,
    replacement_symbol: null,
    created_at: new Date(FIXED_NOW_MS).toISOString(),
    updated_at: new Date(FIXED_NOW_MS).toISOString(),
    ...overrides
  };
}

async function deterministicFetch(input) {
  const url = new URL(String(input));
  if (!url.pathname.includes("/candles")) throw new Error(`Unexpected network request: ${url.href}`);
  const symbol = decodeURIComponent(url.pathname.split("/")[2] || "");
  const granularity = Number(url.searchParams.get("granularity"));
  marketRequests.push({ symbol, granularity });
  const candles = buildCandles(granularity).map((candle) => [
    candle.time, candle.low, candle.high, candle.open, candle.close, candle.volume
  ]).reverse();
  return new Response(JSON.stringify(candles), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function buildCandles(granularity) {
  const interval = Number.isFinite(granularity) && granularity > 0 ? granularity : 900;
  const latestTime = Math.floor(FIXED_NOW_MS / 1000 / interval) * interval;
  const candles = [];
  for (let index = 0; index < 120; index += 1) {
    const close = 100 + index * 0.03 + Math.sin(index * 0.38 + 1.4) * 0.8;
    const previousClose = index ? candles[index - 1].close : close - 0.03;
    const open = index === 119 ? close - 0.096 : previousClose;
    candles.push({
      time: latestTime - (119 - index) * interval,
      open,
      high: Math.max(open, close) + 0.144,
      low: Math.min(open, close) - 0.144,
      close,
      volume: index === 119 ? 1800 : 1000 + (index % 7) * 15
    });
  }
  return candles;
}
