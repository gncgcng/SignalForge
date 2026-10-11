// Publication-gate reasons reach users as written for them, chosen by stage, never rewritten by keyword rules:
// single scan, scan-all cards and "Most common avoid reason". Mocked DB, Coinbase stats and candles; no network.
process.env.CRYPTO_WATCHER_ENABLED = "false";
process.env.AUTO_SCAN_ENABLED = "false";
process.env.MARKET_VERIFICATION_ENABLED = "false";
delete process.env.CRYPTO_MIN_24H_VOLUME_USD;

import assert from "node:assert/strict";

const START_MS = Date.UTC(2026, 1, 3, 8, 30, 0);
let currentNowMs = START_MS;
const RealDate = globalThis.Date;
const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;
const realInfo = console.info;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [currentNowMs])); }
  static now() { return currentNowMs; }
}
const LONG_FIXTURE = { slope: 0.03, amplitude: 0.8, phase: 1.4, padding: 0.144, lastMove: 0.096, lastVolume: 1800 };
const SHORT_FIXTURE = { ...LONG_FIXTURE, slope: -0.03, phase: 1.4 + Math.PI, lastMove: -0.096 };
const fixtures = new Map([["BTC-USD", LONG_FIXTURE], ["ETH-USD", SHORT_FIXTURE]]);
const USER = { id: "scan-user", role: "tester", plan: "tester" };
const LIQUIDITY_TEXT = "This market trades less than $2M per day. SignalForge doesn't generate signals on thin markets.";
const SHORTS_PAUSED = "Short setups are paused while we review their performance.";
const GROUP_PAUSED = "This setup type is paused by SignalForge.";
const passed = [];

globalThis.Date = FixedDate;
globalThis.fetch = deterministicFetch;
console.log = () => {};
console.warn = () => {};
console.info = () => {};

try {
  const db = await import("./test-support/admin-disabled-db-transport.mock.js");
  const { reloadCryptoMarketSettings } = await import("../src/modules/markets/cryptoMarketService.js");
  const liquidity = await import("../src/modules/markets/marketLiquidityService.js");
  const { scanMarketSetupDetailed, scanAllMarketsDetailed } = await import("../src/modules/signals/signalService.js");
  const { buildAvoidTradeResult, toAvoidGuidance } = await import("../src/modules/signals/avoidTradeService.js");

  const check = async (name, fn) => { await fn(); passed.push(name); };
  const reset = async (adminRows = []) => {
    currentNowMs += 31000;
    db.resetAutoCryptoWatcherTransport();
    db.clearValidationRejections();
    db.configureCryptoMarketRows([marketRow("BTC-USD"), marketRow("ETH-USD")]);
    await reloadCryptoMarketSettings();
    db.setAdminOverrideRows(adminRows);
  };
  const refresh = (volumes) => liquidity.refreshMarketLiquidity(Object.keys(volumes), {
    fetchImpl: async (url) => {
      const symbol = decodeURIComponent(new URL(String(url)).pathname.split("/")[2]);
      return new Response(JSON.stringify({ volume: String(volumes[symbol] / 10), last: "10" }), { status: 200 });
    },
    sleep: async () => {}
  });
  const rejectedAnalysis = (stage, reason, extra = {}) => ({
    rejectedReasons: [{ stage, reason, ...extra }],
    rejectionReasons: [reason],
    rejectionReasonCodes: [stage],
    rejectionSummary: `No setup found because: ${reason}.`
  });

  // ---------- the translation itself ----------
  await check("candle-volume reasons still map exactly as before", () => {
    assert.equal(toAvoidGuidance("Volume confirmation is missing.").reason, "Volume is below average, so the move is not confirmed yet.");
    const avoid = buildAvoidTradeResult({ symbol: "BTC-USD", timeframe: "15m", analysis: rejectedAnalysis("confirmation", "Volume confirmation is missing.") });
    assert.deepEqual([avoid.reason, avoid.marketCondition, avoid.gateStage], ["Volume is below average, so the move is not confirmed yet.", "Weak participation", undefined]);
  });
  await check("gates are matched on stage, not on words in the text", () => {
    const floor = buildAvoidTradeResult({ symbol: "ETH-USD", timeframe: "15m", analysis: rejectedAnalysis("liquidity_floor", "Below liquidity floor ($1.00M 24h volume)", { floorUsd: 2000000 }) });
    assert.deepEqual([floor.reason, floor.marketCondition, floor.gateStage], [LIQUIDITY_TEXT, "Low liquidity", "liquidity_floor"], "'24h volume' must not become a candle-volume reason");
    const lookalike = buildAvoidTradeResult({ symbol: "ETH-USD", timeframe: "15m", analysis: rejectedAnalysis("price", "Below liquidity floor and admin disabled") });
    assert.notEqual(lookalike.reason, LIQUIDITY_TEXT, "gate wording in another stage's text is not a gate");
    assert.equal(lookalike.gateStage, undefined);
    const custom = buildAvoidTradeResult({ symbol: "ETH-USD", timeframe: "15m", analysis: rejectedAnalysis("liquidity_floor", "x", { floorUsd: 2500000 }) });
    assert.match(custom.reason, /less than \$2\.5M per day/, "the floor amount comes from the gate");
  });

  // ---------- liquidity floor: single scan ----------
  await reset();
  await refresh({ "BTC-USD": 80e6, "ETH-USD": 1e6 });
  const single = await scanMarketSetupDetailed(USER, { symbol: "ETH-USD", timeframe: "15m" });
  await check("single scan, liquidity floor: the no-setup card and the avoid card both say the market is too thin", () => {
    assert.equal(single.publicResult.valid, false);
    assert.deepEqual(single.publicResult.analysis.rejectionReasons, [LIQUIDITY_TEXT]);
    assert.equal(single.publicResult.analysis.rejectionSummary, `No setup found because: ${LIQUIDITY_TEXT}.`);
    assert.deepEqual([single.publicResult.avoidTrade.reason, single.publicResult.avoidTrade.marketCondition], [LIQUIDITY_TEXT, "Low liquidity"]);
    assert.ok(!JSON.stringify(single.publicResult).includes("Volume is below average"), "no candle-volume wording anywhere");
  });
  await check("the recorded rejection keeps its internal reason for the admin rejection counts", () => {
    const [rejection] = db.getValidationRejections();
    assert.deepEqual([rejection.reasons[0].stage, rejection.reasons[0].reason], ["liquidity_floor", "Below liquidity floor ($1.00M 24h volume)"]);
  });

  // ---------- liquidity floor: scan-all ----------
  await reset();
  const all = (await scanAllMarketsDetailed(USER)).publicResult;
  await check("scan-all: ETH's avoid card and 'Most common avoid reason' carry the liquidity text; BTC still publishes", () => {
    const ethCard = all.avoidTrades.find((item) => item.symbol === "ETH-USD");
    assert.deepEqual([ethCard?.reason, ethCard?.marketCondition], [LIQUIDITY_TEXT, "Low liquidity"]);
    assert.equal(all.scanSummary.topAvoidReason, LIQUIDITY_TEXT);
    assert.deepEqual(all.scanned.find((item) => item.symbol === "ETH-USD").rejectionReasons, [LIQUIDITY_TEXT]);
    assert.ok(all.setups.some((setup) => setup.symbol === "BTC-USD"));
  });

  // ---------- admin_disabled ----------
  await refresh({ "BTC-USD": 80e6, "ETH-USD": 80e6 });
  await reset([{ group_key: "direction:short", status: "disabled_by_admin" }]);
  const shortPaused = await scanMarketSetupDetailed(USER, { symbol: "ETH-USD", timeframe: "15m" });
  await check("admin_disabled direction:short: 'Short setups are paused while we review their performance.'", () => {
    assert.deepEqual(shortPaused.publicResult.analysis.rejectionReasons, [SHORTS_PAUSED]);
    assert.deepEqual([shortPaused.publicResult.avoidTrade.reason, shortPaused.publicResult.avoidTrade.marketCondition], [SHORTS_PAUSED, "Paused by SignalForge"]);
  });
  await reset([{ group_key: "pair:eth-usd", status: "disabled_by_admin" }]);
  const groupPaused = await scanMarketSetupDetailed(USER, { symbol: "ETH-USD", timeframe: "15m" });
  const allPaused = (await scanAllMarketsDetailed(USER)).publicResult;
  await check("admin_disabled on any other group: 'This setup type is paused by SignalForge.' in single scan and scan-all", () => {
    assert.deepEqual([groupPaused.publicResult.analysis.rejectionReasons, groupPaused.publicResult.avoidTrade.reason], [[GROUP_PAUSED], GROUP_PAUSED]);
    assert.equal(allPaused.avoidTrades.find((item) => item.symbol === "ETH-USD")?.reason, GROUP_PAUSED);
    assert.equal(allPaused.scanSummary.topAvoidReason, GROUP_PAUSED);
  });

  realLog(`Avoid-trade gate reason tests passed (${passed.length} checks):\n${passed.map((name) => `  ok ${name}`).join("\n")}`);
} finally {
  globalThis.Date = RealDate;
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.warn = realWarn;
  console.info = realInfo;
}

function marketRow(symbol) {
  const at = new Date(START_MS).toISOString();
  return {
    symbol, display_symbol: symbol.replace("-", ""), provider_symbol: symbol, name: symbol, provider: "coinbase-exchange",
    liquidity_tier: "major", enabled: true, scanner_enabled: true, paper_trading_enabled: true, watchlist_enabled: true,
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
