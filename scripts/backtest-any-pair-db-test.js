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
  listEligibleScannerCryptoMarkets,
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
const { backtestLimits, resetBacktestThrottle } = await import("../src/modules/backtesting/backtestThrottle.js");
const { scanMarketSetupDetailed } = await import("../src/modules/signals/signalService.js");
const { runAutoCryptoAlertScan } = await import("../src/modules/alerts/autoScanService.js");

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
const pair = `SFBT${run}-USD`;
const extraPairs = Array.from({ length: 10 }, (_, index) => `SFBT${run}X${index}-USD`);
const failingPair = extraPairs[0]; // Coinbase answers 500 for its candles
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
  if (decodeURIComponent(match[1]) === failingPair) return new Response("{}", { status: 500 });
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
    headers: {},
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; return this; },
    setHeader() {},
    write(chunk) { this.body += String(chunk); return true; },
    end(body = "") { this.body += String(body); }
  };
}

// A POST to the run route with a JSON body and the given accept header.
async function postRun(user, body, accept = "application/x-ndjson") {
  const res = fakeResponse();
  const req = {
    method: "POST",
    user,
    headers: { accept },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); }
  };
  await handleBacktestRoutes(req, res, "/api/backtesting/run", new URL("http://localhost/api/backtesting/run"));
  return res;
}

try {
  await initializeCryptoMarketSettings();
  // As importCoinbaseCryptoProducts stores a newly discovered product: enabled, scanner off, not verified.
  // The extra pairs only make an 11-pair run for the per-run cap.
  for (const symbol of [pair, ...extraPairs]) {
    await query(`INSERT INTO crypto_markets (
        symbol, display_symbol, provider_symbol, name, provider, liquidity_tier,
        enabled, scanner_enabled, paper_trading_enabled, watchlist_enabled,
        provider_status, base_asset, quote_asset, product_status, trading_enabled,
        market_status, verification_status, status
      ) VALUES ($1,$2,$1,'Backtest Test Coin','coinbase-exchange','standard',true,false,true,true,'unchecked',$3,'USD','online',true,'unavailable','failed','unavailable')`,
    [symbol, symbol.replace("-", ""), symbol.split("-")[0]]);
  }
  // Liquidity: the test pair is far below the $1M floor; BTC-USD, ETH-USD and the other scanner-eligible seeds are
  // well above it.
  const scannerSeeds = listEligibleScannerCryptoMarkets().map((market) => market.symbol)
    .filter((symbol) => !["BTC-USD", "ETH-USD"].includes(symbol));
  for (const [symbol, volume] of [[pair, 5000], ["BTC-USD", 5e9], ["ETH-USD", 2e9], ...scannerSeeds.map((symbol) => [symbol, 1e8])]) {
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
  // ...but a scanner-only run is never gated: with no run slots at all it still goes through.
  backtestLimits.maxRunsGlobal = 0;
  try {
    await assert.rejects(() => runHistoricalBacktest(paidUser, { symbol: pair, timeframe: "1h" }), { code: "BACKTEST_BUSY" });
    const scannerWhileBusy = await runHistoricalBacktest(paidUser, { symbol: "BTC-USD", timeframe: "1h" });
    assert.equal(scannerWhileBusy.symbol, "BTC-USD");
  } finally {
    backtestLimits.maxRunsGlobal = 2;
  }
  await assert.rejects(() => runHistoricalBacktest({ id: user }, { symbols: [pair, ...extraPairs], timeframe: "1h" }),
    (error) => error.statusCode === 400 && /up to 10 "Not scanned" pairs/.test(error.message));

  // 2d. Scanner pairs and commodities have no per-run cap and never go through the throttled loader.
  const scannerOnly = listBacktestMarkets().filter((market) => market.scannerReady || market.category !== "Crypto")
    .map((market) => market.symbol);
  assert.ok(scannerOnly.length > 10, `more than 10 scanner pairs and commodities (${scannerOnly.length})`);
  const throttleSleeps = [];
  resetBacktestThrottle({ sleep: async (ms) => { throttleSleeps.push(ms); } });
  const uncapped = await runHistoricalBacktest({ id: user }, { symbols: scannerOnly, timeframe: "1h" });
  assert.ok(uncapped, "an 11+ market scanner run is accepted");
  assert.deepEqual(throttleSleeps, [], "no throttle spacing on scanner loads");
  await runHistoricalBacktest({ id: user }, { symbols: [pair, "BTC-USD"], timeframes: ["15m", "1h"] });
  assert.ok(throttleSleeps.length > 0, "the Not scanned pair's loads are still spaced");

  // 2e. Streamed run: "Loading candles X of Y" progress lines, then the result. A pair whose candles fail still
  // counts its skipped loads, so the progress reaches its total.
  resetBacktestThrottle();
  const streamed = await postRun(paidUser, { symbols: [pair, failingPair, "BTC-USD"], timeframes: ["15m", "1h"] });
  assert.equal(streamed.statusCode, 200);
  assert.match(streamed.headers["content-type"], /application\/x-ndjson/);
  const lines = streamed.body.trim().split("\n").map((line) => JSON.parse(line));
  const progressLines = lines.filter((line) => line.type === "progress");
  const total = progressLines[0].total;
  // Per bundle: the timeframe, the higher timeframes (15m: 2, 1h: 1) and 6 peers (7 for a pair outside the peers).
  assert.equal(total, 2 * ((1 + 2 + 7) + (1 + 1 + 7)) + ((1 + 2 + 6) + (1 + 1 + 6)));
  assert.equal(progressLines[0].loaded, 0, "first line before any load");
  assert.ok(progressLines.every((line, index) => index === 0 || line.loaded > progressLines[index - 1].loaded), "progress only grows");
  assert.equal(progressLines.at(-1).loaded, total, "progress reaches its total");
  assert.equal(lines.at(-1).type, "result");
  assert.ok(lines.at(-1).backtest.errors.some((error) => error.symbol === failingPair), "the failing pair is reported");
  // Errors before the first load keep their status and plain JSON: busy (429) and too many pairs (400).
  backtestLimits.maxRunsGlobal = 0;
  try {
    const busyStream = await postRun(paidUser, { symbol: pair, timeframe: "1h" });
    assert.equal(busyStream.statusCode, 429);
    assert.equal(JSON.parse(busyStream.body).error.message, "Backtesting is busy right now. Please try again in a minute.");
  } finally {
    backtestLimits.maxRunsGlobal = 2;
  }
  const tooMany = await postRun(paidUser, { symbols: [pair, ...extraPairs], timeframe: "1h" });
  assert.equal(tooMany.statusCode, 400);
  assert.match(JSON.parse(tooMany.body).error.message, /up to 10 "Not scanned" pairs/);
  // Without the accept header the route answers plain JSON as before.
  const plain = await postRun(paidUser, { symbol: "BTC-USD", timeframe: "1h" }, "application/json");
  assert.equal(plain.statusCode, 200);
  assert.equal(JSON.parse(plain.body).backtest.symbol, "BTC-USD");

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
  await query("DELETE FROM crypto_markets WHERE symbol = ANY($1)", [[pair, ...extraPairs]]);
  await query("DELETE FROM market_liquidity WHERE symbol = ANY($1)", [[pair, ...insertedLiquidity]]);
  if (userIds.length) await query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  await getPool().end();
}
