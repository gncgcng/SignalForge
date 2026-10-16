// A Coinbase USD pair that is not in the scanner (imported by the product sync, never verified, below the liquidity
// floor) can be backtested and carries the low-liquidity warning, but it never reaches the scanner, a manual scan,
// the auto scanner or alerts, and the backtest does not change its market state. Free users still get no backtesting.
// DB-backed (local docker-compose Postgres); Coinbase is stubbed, no network.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";

Object.assign(process.env, {
  NODE_ENV: "development",
  EMAIL_FEATURES_ENABLED: "false",
  CRYPTO_MIN_24H_VOLUME_USD: "1000000",
  MARKET_LIQUIDITY_REFRESH_ENABLED: "false"
});

const { getPool, query } = await import("../src/db/client.js");
const { createHelperUser } = await import("./account-deletion-fixtures.js");
const {
  getCryptoMarketState,
  initializeCryptoMarketSettings,
  listScannerCryptoMarkets,
  reloadCryptoMarketSettings
} = await import("../src/modules/markets/cryptoMarketService.js");
const { loadMarketLiquidity } = await import("../src/modules/markets/marketLiquidityService.js");
const {
  getManualScannerUniverse,
  getPair,
  listAutoScannerPairs,
  listEligibleAutoScannerCryptoPairs
} = await import("../src/modules/market-data/marketDataService.js");
const {
  listBacktestMarkets,
  lowLiquidityBacktestWarning,
  runHistoricalBacktest
} = await import("../src/modules/backtesting/backtestService.js");
const { handleBacktestRoutes } = await import("../src/modules/backtesting/backtestController.js");
const { scanMarketSetupDetailed } = await import("../src/modules/signals/signalService.js");
const { runAutoCryptoAlertScan } = await import("../src/modules/alerts/autoScanService.js");

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
const pair = `SFBT${run}-USD`;
const userIds = [];
const insertedLiquidity = [];

// Coinbase candles stub: [time, low, high, open, close, volume] rows for the requested window, newest first.
const realFetch = globalThis.fetch;
const coinbaseRequests = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const match = url.pathname.match(/^\/products\/([^/]+)\/candles$/);
  if (!match) throw new Error(`unexpected request ${url}`);
  coinbaseRequests.push(decodeURIComponent(match[1]));
  const granularity = Number(url.searchParams.get("granularity"));
  const start = Math.floor(Date.parse(url.searchParams.get("start")) / 1000);
  const end = Math.floor(Date.parse(url.searchParams.get("end")) / 1000);
  const rows = [];
  for (let time = Math.ceil(start / granularity) * granularity; time <= end; time += granularity) {
    const step = time / granularity;
    const base = 1 + 0.2 * Math.sin(step / 9) + 0.08 * Math.sin(step / 2.3) + (step % 40) * 0.002;
    const open = base;
    const close = base * (1 + 0.004 * Math.sin(step / 1.7));
    rows.push([time, Math.min(open, close) * 0.992, Math.max(open, close) * 1.008, open, close, 1000 + (step % 17) * 40]);
  }
  return new Response(JSON.stringify(rows.reverse()), { status: 200, headers: { "content-type": "application/json" } });
};

function fakeResponse() {
  return {
    statusCode: 0,
    body: "",
    writeHead(status) { this.statusCode = status; return this; },
    setHeader() {},
    end(body = "") { this.body = String(body); }
  };
}

try {
  await initializeCryptoMarketSettings();
  // As importCoinbaseCryptoProducts stores a newly discovered product: enabled, scanner off, not verified.
  await query(`INSERT INTO crypto_markets (
      symbol, display_symbol, provider_symbol, name, provider, liquidity_tier,
      enabled, scanner_enabled, paper_trading_enabled, watchlist_enabled,
      provider_status, base_asset, quote_asset, product_status, trading_enabled,
      market_status, verification_status, status
    ) VALUES ($1,$2,$1,'Backtest Test Coin','coinbase-exchange','standard',true,false,true,true,'unchecked',$3,'USD','online',true,'unavailable','failed','unavailable')`,
  [pair, pair.replace("-", ""), pair.split("-")[0]]);
  // Liquidity: the test pair is far below the $1M floor; BTC-USD and ETH-USD are well above it.
  for (const [symbol, volume] of [[pair, 5000], ["BTC-USD", 5e9], ["ETH-USD", 2e9]]) {
    const result = await query(`INSERT INTO market_liquidity (symbol, volume_24h_usd, last_price, updated_at)
      VALUES ($1, $2, 1, now()) ON CONFLICT (symbol) DO NOTHING RETURNING symbol`, [symbol, volume]);
    if (result.rows.length) insertedLiquidity.push(symbol);
  }
  await reloadCryptoMarketSettings();
  await loadMarketLiquidity();
  const stateBefore = getCryptoMarketState(pair);

  // 1. The backtest market list offers it, marked as not in the scanner and low liquidity.
  const markets = listBacktestMarkets();
  const listed = markets.find((market) => market.symbol === pair);
  assert.ok(listed, "the non-scanner pair is offered for backtesting");
  assert.equal(listed.scannerReady, false);
  assert.equal(listed.lowLiquidity, true);
  assert.equal(listed.warning, lowLiquidityBacktestWarning);
  assert.equal(lowLiquidityBacktestWarning, "Low liquidity: backtest results may be unreliable.");
  const btc = markets.find((market) => market.symbol === "BTC-USD");
  assert.equal(btc.scannerReady, true, "BTC-USD is a scanner pair");
  assert.equal(btc.lowLiquidity, false, "BTC-USD has no warning");

  // 2. It can be backtested, and the result carries the warning.
  const user = await createHelperUser("btpair");
  userIds.push(user);
  const report = await runHistoricalBacktest({ id: user }, { symbol: pair, timeframe: "1h" });
  assert.equal(report.symbol, pair);
  assert.ok(report.candleCount >= 60, `enough candles (${report.candleCount})`);
  assert.ok(coinbaseRequests.includes(pair), "candles came from Coinbase for the pair");
  assert.deepEqual(report.warnings, [{ symbol: pair, code: "LOW_LIQUIDITY", message: lowLiquidityBacktestWarning }]);
  const btcReport = await runHistoricalBacktest({ id: user }, { symbol: "BTC-USD", timeframe: "1h" });
  assert.deepEqual(btcReport.warnings, [], "no warning above the floor");
  await assert.rejects(() => runHistoricalBacktest({ id: user }, { symbol: "NOTAPAIR-USD", timeframe: "1h" }), /supported backtesting market/);

  // 2b. Re-running is served from the backtest cache: no new Coinbase requests.
  const requestsBefore = coinbaseRequests.length;
  const rerun = await runHistoricalBacktest({ id: user }, { symbol: pair, timeframe: "1h" });
  assert.equal(rerun.candleCount, report.candleCount);
  assert.equal(coinbaseRequests.length, requestsBefore, "cached candles, no refetch");

  // 2c. A second backtest from the same user while one runs gets the friendly busy answer through the route.
  const paidUser = { id: user, role: "tester" };
  const running = runHistoricalBacktest(paidUser, { symbol: pair, timeframe: "4h" });
  const busy = fakeResponse();
  await handleBacktestRoutes({ method: "GET", user: paidUser }, busy, "/api/backtesting",
    new URL(`http://localhost/api/backtesting?symbol=${pair}&timeframe=1h`));
  assert.equal(busy.statusCode, 429);
  assert.equal(JSON.parse(busy.body).error.message, "Backtesting is busy right now. Please try again in a minute.");
  await running;
  await assert.rejects(() => runHistoricalBacktest({ id: user }, {
    symbols: listBacktestMarkets().slice(0, 11).map((market) => market.symbol), timeframe: "1h"
  }), /up to 10 markets/);

  // 3. The backtest did not verify, cool down or otherwise change the pair.
  const stateAfter = getCryptoMarketState(pair);
  for (const key of ["status", "marketStatus", "verificationStatus", "scannerEnabled", "effectiveScannerEnabled", "consecutiveFailures", "cooldownUntil", "lastSuccessfulCandleAt"]) {
    assert.deepEqual(stateAfter[key], stateBefore[key], `${key} unchanged`);
  }
  const row = (await query("SELECT status, market_status, scanner_enabled, consecutive_failures, last_successful_candle_at FROM crypto_markets WHERE symbol = $1", [pair])).rows[0];
  assert.deepEqual({ ...row }, { status: "unavailable", market_status: "unavailable", scanner_enabled: false, consecutive_failures: 0, last_successful_candle_at: null });

  // 4. Never in the scanner, scan results or alerts.
  assert.ok(!listScannerCryptoMarkets().some((market) => market.symbol === pair), "not in the scanner list");
  assert.ok(!listAutoScannerPairs().some((market) => market.symbol === pair), "not in the auto scanner");
  assert.ok(!listEligibleAutoScannerCryptoPairs().some((market) => market.symbol === pair), "not eligible for alerts");
  assert.ok(!getManualScannerUniverse().markets.some((market) => market.symbol === pair), "not in a manual scan");
  assert.equal(getPair(pair).effectiveScannerEnabled, false, "alert preferences on it are skipped");
  await assert.rejects(() => scanMarketSetupDetailed({ id: user }, { symbol: pair, timeframe: "1h" }), "a direct scan of the pair is refused");
  await assert.rejects(() => runAutoCryptoAlertScan({ userId: user, symbol: pair, timeframe: "1h" }),
    (error) => error.code === "AUTO_SCAN_SCOPE_INELIGIBLE_MARKET");
  for (const table of ["saved_signals", "detected_alerts"]) {
    const n = (await query(`SELECT COUNT(*)::integer AS n FROM ${table} WHERE symbol = $1`, [pair])).rows[0].n;
    assert.equal(n, 0, `no ${table} rows for the pair`);
  }

  // 5. Paid gating unchanged: a free user gets 402 from the market list and from a run.
  for (const [method, pathname] of [["GET", "/api/backtesting/markets"], ["GET", "/api/backtesting"]]) {
    const res = fakeResponse();
    await handleBacktestRoutes({ method, user: { id: user, role: "user", subscription: { status: "none" } } }, res, pathname,
      new URL(`http://localhost${pathname}?symbol=BTC-USD&timeframe=1h`));
    assert.equal(res.statusCode, 402, `${pathname} is paid-only`);
  }

  console.log(JSON.stringify({
    pair,
    listed,
    candleCount: report.candleCount,
    warnings: report.warnings,
    backtestMarkets: markets.length
  }, null, 2));
} finally {
  globalThis.fetch = realFetch;
  await query("DELETE FROM generated_signals WHERE pair = $1 OR generated_by = ANY($2)", [pair, userIds]);
  await query("DELETE FROM crypto_markets WHERE symbol = $1", [pair]);
  await query("DELETE FROM market_liquidity WHERE symbol = ANY($1)", [[pair, ...insertedLiquidity]]);
  if (userIds.length) await query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await getPool().end();
}
