// Liquidity ranking and floor: Coinbase /products/{id}/stats mocked, DB transport mocked (admin-disabled loader),
// candles from deterministic fixtures. Drives the real auto scanner, alert preferences, scoped watcher and manual scan.
process.env.CRYPTO_WATCHER_ENABLED = "false";
process.env.AUTO_SCAN_ENABLED = "false";
process.env.MARKET_VERIFICATION_ENABLED = "false";
process.env.TELEGRAM_BOT_TOKEN = "fixture-bot-token";
delete process.env.CRYPTO_MIN_24H_VOLUME_USD;

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const START_MS = Date.UTC(2026, 1, 3, 8, 30, 0);
let currentNowMs = START_MS;
const RealDate = globalThis.Date;
const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;
const realInfo = console.info;
const warnings = [];
const infos = [];

class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [currentNowMs])); }
  static now() { return currentNowMs; }
}
const LONG_FIXTURE = { slope: 0.03, amplitude: 0.8, phase: 1.4, padding: 0.144, lastMove: 0.096, lastVolume: 1800 };
const SHORT_FIXTURE = { ...LONG_FIXTURE, slope: -0.03, phase: 1.4 + Math.PI, lastMove: -0.096 };
const fixtures = new Map([["BTC-USD", LONG_FIXTURE], ["ETH-USD", SHORT_FIXTURE]]);
const USER_ID = "watcher-user";
const MARKETS = [["BTC-USD", "major"], ["ETH-USD", "major"], ["SOL-USD", "major"], ["1INCH-USD", "standard"], ["ABT-USD", "standard"], ["ZRX-USD", "standard"], ["XYZ-USD", "standard"]];
const passed = [];

globalThis.Date = FixedDate;
globalThis.fetch = deterministicFetch;
console.log = () => {};
console.warn = (...args) => warnings.push(args.join(" "));
console.info = (...args) => infos.push(args.join(" "));

try {
  const db = await import("./test-support/admin-disabled-db-transport.mock.js");
  const { reloadCryptoMarketSettings, listScannerCryptoMarkets } = await import("../src/modules/markets/cryptoMarketService.js");
  const liquidity = await import("../src/modules/markets/marketLiquidityService.js");
  const { runAutoCryptoAlertScan } = await import("../src/modules/alerts/autoScanService.js");
  const { scanMarketSetupDetailed } = await import("../src/modules/signals/signalService.js");

  const check = async (name, fn) => { await fn(); passed.push(name); };
  const reset = async () => {
    currentNowMs += 31000;
    db.resetAutoCryptoWatcherTransport();
    db.clearValidationRejections();
    db.configureCryptoMarketRows(MARKETS.map(([symbol, tier]) => marketRow(symbol, tier)));
    await reloadCryptoMarketSettings();
    db.configureWatcherUser({ userId: USER_ID, minimumConfidence: 0, symbols: ["BTC-USD", "ETH-USD"] });
    db.setAdminOverrideRows([]);
  };
  const statsFetch = (volumes, calls = []) => async (url) => {
    const symbol = decodeURIComponent(new URL(String(url)).pathname.split("/")[2]);
    calls.push(symbol);
    const entry = volumes[symbol];
    if (entry === undefined || entry === "fail") return new Response("{}", { status: entry === "fail" ? 500 : 404 });
    return new Response(JSON.stringify({ volume: String(entry / 10), last: "10", open: "9" }), { status: 200 });
  };
  const generated = (pair) => db.getAutoCryptoWatcherState().generatedRows.filter((row) => row.pair === pair && row.status === "Active");
  const queued = (pair) => db.getAutoCryptoWatcherState().queueRows.filter((row) => row.payload.symbol === pair);
  const floorRejections = () => db.getValidationRejections().filter((item) => item.reasons[0].stage === "liquidity_floor");

  // ---------- fail-safe before any successful refresh ----------
  await reset();
  await liquidity.loadMarketLiquidity();
  await check("before any refresh: plain tier + symbol order, no floor, and a warning is logged", async () => {
    assert.deepEqual(listScannerCryptoMarkets().map((market) => market.symbol), ["BTC-USD", "ETH-USD", "SOL-USD", "1INCH-USD", "ABT-USD", "XYZ-USD", "ZRX-USD"]);
    assert.equal(liquidity.evaluateLiquidityFloor("ETH-USD").belowFloor, false);
    assert.ok(warnings.some((line) => line.includes("no liquidity refresh has succeeded yet")));
  });
  await runAutoCryptoAlertScan();
  await check("before any refresh: signals publish exactly as today (long and short both queued)", () => {
    assert.equal(generated("BTC-USD").length, 1);
    assert.equal(generated("ETH-USD").length, 1);
    assert.equal(queued("ETH-USD").length, 1);
    assert.deepEqual(floorRejections(), []);
  });

  // ---------- refresh ----------
  const calls = [];
  const sleeps = [];
  const volumes = { "BTC-USD": 80e6, "ETH-USD": 1e6, "SOL-USD": 90e6, "1INCH-USD": 1.5e6, "ABT-USD": 5e6, "ZRX-USD": 40e6 };
  const first = await liquidity.refreshMarketLiquidity(MARKETS.map(([symbol]) => symbol), { fetchImpl: statsFetch(volumes, calls), sleep: async (ms) => sleeps.push(ms) });
  await check("refresh: one stats request per market, throttled to <= 3 per second, volume = volume x last, summary logged", () => {
    assert.deepEqual(calls, MARKETS.map(([symbol]) => symbol));
    assert.ok(sleeps.length === MARKETS.length - 1 && sleeps.every((ms) => ms >= 334));
    assert.equal(liquidity.getMarketLiquidity("ABT-USD").volume24hUsd, 5e6);
    assert.deepEqual([first.updated, first.failed.length, first.belowFloor], [6, 1, 3]);
    assert.ok(infos.some((line) => /\[market-liquidity\] refreshed=6 failed=1 requested=7 below_floor=3 floor_usd=2000000/.test(line)));
  });

  // ---------- ranking ----------
  await reset();
  await check("ranking: majors first, then within each tier by 24h volume desc; below-floor and no-data markets get no slot", () => {
    assert.deepEqual(listScannerCryptoMarkets().map((market) => market.symbol), ["SOL-USD", "BTC-USD", "ZRX-USD", "ABT-USD"]);
    assert.equal(liquidity.compareByLiquidity("XYZ-USD", "ABT-USD") > 0, true, "no data sorts after data");
  });
  await check("after a successful refresh, a market with no row counts as below the floor", () => {
    const missing = liquidity.evaluateLiquidityFloor("XYZ-USD");
    assert.deepEqual([missing.belowFloor, missing.reason], [true, "Below liquidity floor (no 24h volume data)"]);
    assert.equal(liquidity.evaluateLiquidityFloor("ETH-USD").reason, "Below liquidity floor ($1.00M 24h volume)");
  });

  // ---------- floor on every generating path (ETH-USD at $1M) ----------
  await reset();
  db.configureAlertPreference({ userId: USER_ID, symbol: "ETH-USD", timeframe: "15m" });
  await runAutoCryptoAlertScan();
  await check("auto scanner + watchlist alerts: ETH is not published or queued, BTC is; the alert path records the floor rejection", () => {
    assert.equal(generated("BTC-USD").length, 1);
    assert.equal(queued("BTC-USD").length, 1);
    assert.equal(generated("ETH-USD").length, 0);
    assert.equal(queued("ETH-USD").length, 0);
    assert.deepEqual(floorRejections().map((item) => [item.symbol, item.source, item.reasons[0].reason]), [["ETH-USD", "auto_crypto_watcher", "Below liquidity floor ($1.00M 24h volume)"]]);
  });
  await reset();
  await runAutoCryptoAlertScan({ userId: USER_ID, symbol: "ETH-USD", timeframe: "15m" });
  await check("scoped watcher: the scoped ETH scan is blocked and recorded", () => {
    assert.equal(generated("ETH-USD").length, 0);
    assert.equal(queued("ETH-USD").length, 0);
    assert.equal(floorRejections()[0]?.symbol, "ETH-USD");
  });
  await reset();
  const manualShort = await scanMarketSetupDetailed({ id: USER_ID }, { symbol: "ETH-USD", timeframe: "15m" });
  const manualLong = await scanMarketSetupDetailed({ id: USER_ID }, { symbol: "BTC-USD", timeframe: "15m" });
  await check("manual scan (and scan-all, which uses the same scan): ETH is refused with the floor reason, BTC publishes", () => {
    assert.equal(manualShort.publicResult.valid, false);
    assert.deepEqual(manualShort.analysis.rejectionReasonCodes, ["liquidity_floor"]);
    // Users see the public wording; the internal reason stays in rejectedReasons and the recorded rejection.
    assert.deepEqual(manualShort.analysis.rejectionReasons, ["This market trades less than $2M per day. SignalForge doesn't generate signals on thin markets."]);
    assert.equal(manualShort.analysis.rejectedReasons[0].reason, "Below liquidity floor ($1.00M 24h volume)");
    assert.equal(manualLong.publicResult.valid, true);
    assert.equal(floorRejections()[0]?.source, "manual_scan");
  });

  // ---------- a failed product keeps its previous row ----------
  const second = await liquidity.refreshMarketLiquidity(["BTC-USD", "ETH-USD"], { fetchImpl: statsFetch({ "BTC-USD": 70e6, "ETH-USD": "fail" }), sleep: async () => {} });
  await check("a product whose stats request fails keeps its previous volume", () => {
    assert.deepEqual([second.updated, second.failed.map((item) => item.symbol)], [1, ["ETH-USD"]]);
    assert.equal(liquidity.getMarketLiquidity("ETH-USD").volume24hUsd, 1e6);
    assert.equal(liquidity.getMarketLiquidity("BTC-USD").volume24hUsd, 70e6);
  });

  // ---------- floor default and env override ----------
  await check("CRYPTO_MIN_24H_VOLUME_USD: default $2M, overridable, invalid values fall back to the default", () => {
    assert.equal(liquidity.getLiquidityFloorUsd(), 2000000);
    const floorWith = (value) => {
      const env = { ...process.env, CRYPTO_MIN_24H_VOLUME_USD: value };
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", "const { appConfig } = await import('./src/config/appConfig.js'); console.log(appConfig.cryptoMarkets.minVolume24hUsd);"], { env, encoding: "utf8" });
      return Number(child.stdout.trim());
    };
    assert.equal(floorWith("5000000"), 5000000);
    assert.equal(floorWith("0"), 0);
    assert.equal(floorWith("not-a-number"), 2000000);
    assert.equal(floorWith(""), 2000000);
  });
  await check("the floor value decides: ABT at $5M passes a $2M floor and fails a $6M floor", async () => {
    assert.equal(liquidity.evaluateLiquidityFloor("ABT-USD").belowFloor, false);
    const child = spawnSync(process.execPath, ["--import", "./scripts/register-admin-disabled-group-block-loader.js", "--input-type=module", "-e", `
      const liquidity = await import("./src/modules/markets/marketLiquidityService.js");
      console.info = () => {};
      await liquidity.refreshMarketLiquidity(["ABT-USD"], { fetchImpl: async () => new Response(JSON.stringify({ volume: "500000", last: "10" })), sleep: async () => {} });
      console.log(JSON.stringify(liquidity.evaluateLiquidityFloor("ABT-USD")));`], { env: { ...process.env, CRYPTO_MIN_24H_VOLUME_USD: "6000000" }, encoding: "utf8" });
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.deepEqual([result.belowFloor, result.floorUsd], [true, 6000000]);
  });

  realLog(`Market liquidity tests passed (${passed.length} checks):\n${passed.map((name) => `  ok ${name}`).join("\n")}`);
} finally {
  globalThis.Date = RealDate;
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.warn = realWarn;
  console.info = realInfo;
}

function marketRow(symbol, tier) {
  const at = new Date(START_MS).toISOString();
  return {
    symbol, display_symbol: symbol.replace("-", ""), provider_symbol: symbol, name: symbol, provider: "coinbase-exchange",
    liquidity_tier: tier, enabled: true, scanner_enabled: true, paper_trading_enabled: true, watchlist_enabled: true,
    provider_status: "available", supported_timeframes: ["5m", "15m", "1h", "4h"], unsupported_timeframes: [],
    base_asset: symbol.split("-")[0], quote_asset: "USD", product_status: "online", trading_enabled: true,
    market_status: "active", verification_status: "verified", status: "active", verification_details: {},
    last_successful_candle_at: at, last_checked_at: at, last_verification_attempt_at: at, last_verified_at: at,
    last_error: null, failure_code: null, cooldown_until: null, consecutive_failures: 0, replacement_symbol: null,
    created_at: at, updated_at: at
  };
}

async function deterministicFetch(input) {
  const url = new URL(String(input));
  if (!url.pathname.includes("/candles")) throw new Error(`Unexpected network request: ${url.href}`);
  const symbol = decodeURIComponent(url.pathname.split("/")[2] || "");
  const fixture = fixtures.get(symbol);
  if (!fixture) return new Response("no fixture", { status: 503 });
  const granularity = Number(url.searchParams.get("granularity"));
  const candles = buildCandles(granularity, fixture, {
    start: new Date(url.searchParams.get("start")).getTime() / 1000,
    end: new Date(url.searchParams.get("end")).getTime() / 1000
  }).map((candle) => [candle.time, candle.low, candle.high, candle.open, candle.close, candle.volume]).reverse();
  return new Response(JSON.stringify(candles), { status: 200, headers: { "content-type": "application/json" } });
}

// Same candle construction as auto-crypto-watcher-e2e-test.js: the trigger is the last completed bar.
function buildCandles(granularity, fixture, window = {}) {
  const interval = Number.isFinite(granularity) && granularity > 0 ? granularity : 900;
  const latestTime = Math.floor(currentNowMs / 1000 / interval) * interval;
  const firstTime = Math.ceil(Number(window.start ?? latestTime - 119 * interval) / interval) * interval;
  const lastTime = Math.floor(Number(window.end ?? latestTime) / interval) * interval;
  const candles = [];
  for (let time = firstTime; time <= lastTime; time += interval) {
    const index = 120 + Math.round((time - latestTime) / interval);
    const close = 100 + index * fixture.slope + Math.sin(index * 0.38 + fixture.phase) * fixture.amplitude;
    const priorClose = candles.at(-1)?.close ?? close - fixture.slope;
    const isLastCompleted = time === latestTime - interval;
    const open = isLastCompleted ? close - fixture.lastMove : priorClose;
    candles.push({ time, open, high: Math.max(open, close) + fixture.padding, low: Math.min(open, close) - fixture.padding, close, volume: isLastCompleted ? fixture.lastVolume : 1000 + (Math.abs(index) % 7) * 15 });
  }
  return candles;
}
