import assert from "node:assert/strict";

const scenario = process.argv[2];
const FIXED_NOW_MS = Date.UTC(2026, 1, 3, 8, 30, 0);
const RealDate = globalThis.Date;
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realLog = console.log;
const realWarn = console.warn;
const logs = [];
const warnings = [];
const marketRequests = [];
const scheduledTimeouts = [];
const scheduledIntervals = [];

class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [FIXED_NOW_MS])); }
  static now() { return FIXED_NOW_MS; }
}

globalThis.Date = FixedDate;
globalThis.fetch = deterministicFetch;
console.log = (...args) => logs.push(args.map(String).join(" "));
console.warn = (...args) => warnings.push(args.map(String).join(" "));
globalThis.setTimeout = (callback, delay) => {
  scheduledTimeouts.push({ callback, delay });
  return scheduledTimeouts.length;
};
globalThis.setInterval = (callback, delay) => {
  scheduledIntervals.push({ callback, delay });
  return scheduledIntervals.length;
};

try {
  const db = await import("./test-support/auto-crypto-watcher-db-transport.mock.js");
  const { startAutoCryptoAlertScanner } = await import("../src/modules/alerts/autoScanService.js");
  db.resetAutoCryptoWatcherTransport();

  if (!["disabled", "auto-disabled", "partial", "empty", "invalid"].includes(scenario)) {
    configureUsers(db);
  }

  startAutoCryptoAlertScanner();
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
  marketRequests.length = 0;

  let result;
  if (scenario === "disabled") {
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(scheduledIntervals.length, 0);
    assert.ok(logs.some((message) => message.includes("disabled by CRYPTO_WATCHER_ENABLED=false")));
    result = { scheduled: false, scans: 0 };
  } else if (scenario === "auto-disabled") {
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(scheduledIntervals.length, 0);
    result = { scheduled: false, scans: 0 };
  } else if (["partial", "empty"].includes(scenario)) {
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(scheduledIntervals.length, 0);
    assert.ok(warnings.some((message) => message.includes("canary configuration incomplete; scheduler disabled")));
    result = { scheduled: false, scans: 0, failedClosed: scenario === "empty" ? "empty" : "incomplete" };
  } else if (scenario === "invalid") {
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(scheduledIntervals.length, 0);
    assert.ok(warnings.some((message) => message.includes("canary timeframe invalid (2h); scheduler disabled")));
    result = { scheduled: false, scans: 0, failedClosed: "invalid_timeframe" };
  } else {
    assert.equal(scheduledTimeouts.length, 1);
    assert.equal(scheduledTimeouts[0].delay, 1000);
    assert.equal(scheduledIntervals.length, 1);
    assert.ok(scheduledIntervals[0].delay >= 60_000);

    if (scenario === "overlap") {
      const cleanup = db.holdNextAvoidLearningCleanup();
      scheduledTimeouts[0].callback();
      await cleanup.started;
      scheduledIntervals[0].callback();
      await waitFor(() => logs.some((message) => message.includes("skipped duplicates running_cycle=true")));
      cleanup.release();
      await waitFor(() => logs.some((message) => message.includes("[crypto-watch] scanned=")));
    } else {
      scheduledTimeouts[0].callback();
      await waitFor(() => logs.some((message) => message.includes("[crypto-watch] scanned=")));
    }

    const state = db.getAutoCryptoWatcherState();
    const userLookups = state.calls
      .filter((call) => call.sql.includes("from users u") && call.sql.includes("where u.id = $1"))
      .map((call) => String(call.params[0]));
    const marketBriefRefreshed = state.calls.some((call) =>
      call.sql.includes("insert into daily_market_brief_observations")
    );

    if (scenario === "broad") {
      assert.ok(marketRequests.some((request) => request.symbol === "BTC-USD"));
      assert.ok(marketRequests.some((request) => request.symbol === "ETH-USD"));
      assert.ok(userLookups.includes("user-a"));
      assert.ok(userLookups.includes("user-b"));
      assert.equal(marketBriefRefreshed, true);
    } else {
      assert.deepEqual([...new Set(userLookups)], ["user-a"]);
      if (scenario !== "overlap") {
        assert.ok(state.generatedRows.length >= 1);
        assert.ok(state.candidates.length >= 1);
      }
      assert.equal(state.generatedRows.every((row) => row.pair === "BTC-USD" && row.timeframe === "15m"), true);
      assert.equal(state.candidates.every((row) => row.symbol === "BTC-USD" && row.timeframe === "15m"), true);
      assert.equal(state.queueRows.every((row) => row.user_id === "user-a"), true);
      assert.equal(marketBriefRefreshed, false);
      assert.ok(logs.some((message) =>
        message.includes("canary scheduler enabled user=user-a symbol=BTC-USD timeframe=15m")
      ));
    }

    result = {
      scheduled: true,
      users: [...new Set(userLookups)],
      providerContextSymbols: [...new Set(marketRequests.map((request) => request.symbol))],
      generatedScopes: [...new Set(state.generatedRows.map((row) => `${row.pair}:${row.timeframe}`))],
      candidateScopes: [...new Set(state.candidates.map((row) => `${row.symbol}:${row.timeframe}`))],
      queuedUsers: [...new Set(state.queueRows.map((row) => row.user_id))],
      marketBriefRefreshed,
      overlapSkipped: logs.some((message) => message.includes("skipped duplicates running_cycle=true"))
    };
  }

  realLog(`SCHEDULER_CANARY_RESULT=${JSON.stringify({ scenario, result })}`);
} finally {
  globalThis.Date = RealDate;
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
  console.log = realLog;
  console.warn = realWarn;
}

function configureUsers(db) {
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
    symbols: ["ETH-USD"],
    timeframes: ["1h"],
    chatId: "10002"
  });
  db.configureAlertPreference({ userId: "user-a", symbol: "BTC-USD", timeframe: "15m" });
  db.configureAlertPreference({ userId: "user-b", symbol: "ETH-USD", timeframe: "1h" });
}

async function deterministicFetch(input) {
  const url = new URL(String(input));
  if (!url.pathname.includes("/candles")) {
    throw new Error(`Unexpected network boundary request: ${url.href}`);
  }
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
  const noSetup = scenario === "overlap";
  for (let index = 0; index < 120; index += 1) {
    const close = noSetup
      ? 100 + Math.sin(index * 0.38) * 0.02
      : 100 + index * 0.03 + Math.sin(index * 0.38 + 1.4) * 0.8;
    const previousClose = index ? candles[index - 1].close : close - (noSetup ? 0 : 0.03);
    const open = index === 119 && !noSetup ? close - 0.096 : previousClose;
    candles.push({
      time: latestTime - (119 - index) * interval,
      open,
      high: Math.max(open, close) + (noSetup ? 0.04 : 0.144),
      low: Math.min(open, close) - (noSetup ? 0.04 : 0.144),
      close,
      volume: index === 119 && !noSetup ? 1800 : 1000 + (index % 7) * 15
    });
  }
  return candles;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const started = RealDate.now();
  while (!predicate()) {
    if (RealDate.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${scenario} watcher cycle.`);
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
}
