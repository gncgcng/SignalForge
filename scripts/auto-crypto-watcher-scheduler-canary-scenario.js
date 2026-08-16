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
const configurationFailureScenarios = new Set([
  "partial", "empty", "invalid", "both-symbol-modes", "list-partial", "list-empty", "list-too-many"
]);
const knownEligibleSymbols = new Set([
  "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "ADA-USD", "AVAX-USD", "LINK-USD", "LTC-USD"
]);

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

  if (!["disabled", "auto-disabled"].includes(scenario) && !configurationFailureScenarios.has(scenario)) {
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
  } else if (["partial", "empty", "list-partial"].includes(scenario)) {
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(scheduledIntervals.length, 0);
    assert.ok(warnings.some((message) => message.includes("canary configuration incomplete; scheduler disabled")));
    result = { scheduled: false, scans: 0, failedClosed: scenario === "empty" ? "empty" : "incomplete" };
  } else if (scenario === "invalid") {
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(scheduledIntervals.length, 0);
    assert.ok(warnings.some((message) => message.includes("canary timeframe invalid (2h); scheduler disabled")));
    result = { scheduled: false, scans: 0, failedClosed: "invalid_timeframe" };
  } else if (scenario === "both-symbol-modes") {
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(scheduledIntervals.length, 0);
    assert.ok(warnings.some((message) => message.includes("canary symbol configuration conflicts; scheduler disabled")));
    result = { scheduled: false, scans: 0, failedClosed: "symbol_conflict" };
  } else if (scenario === "list-empty") {
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(scheduledIntervals.length, 0);
    assert.ok(warnings.some((message) => message.includes("canary symbol list empty or invalid; scheduler disabled")));
    result = { scheduled: false, scans: 0, failedClosed: "empty_symbol_list" };
  } else if (scenario === "list-too-many") {
    assert.equal(scheduledTimeouts.length, 0);
    assert.equal(scheduledIntervals.length, 0);
    assert.ok(warnings.some((message) => message.includes("canary symbol limit exceeded (11/10); scheduler disabled")));
    result = { scheduled: false, scans: 0, failedClosed: "symbol_limit" };
  } else {
    assert.equal(scheduledTimeouts.length, 1);
    assert.equal(scheduledTimeouts[0].delay, 1000);
    assert.equal(scheduledIntervals.length, 1);
    assert.ok(scheduledIntervals[0].delay >= 60_000);

    const listMode = Boolean(process.env.AUTO_SCAN_CANARY_SYMBOLS !== undefined);
    const overlapScenario = scenario === "overlap" || scenario === "multi-overlap";
    if (overlapScenario) {
      const cleanup = db.holdNextAvoidLearningCleanup();
      scheduledTimeouts[0].callback();
      await cleanup.started;
      scheduledIntervals[0].callback();
      await waitFor(() => logs.some((message) => message.includes("skipped duplicates running_cycle=true")));
      cleanup.release();
      await waitFor(() => logs.some((message) => message.includes(
        listMode ? "[crypto-watch] canary cycle requested_symbols=" : "[crypto-watch] scanned="
      )));
    } else {
      scheduledTimeouts[0].callback();
      await waitFor(() => logs.some((message) => message.includes(
        listMode ? "[crypto-watch] canary cycle requested_symbols=" : "[crypto-watch] scanned="
      )));
    }

    const state = db.getAutoCryptoWatcherState();
    const userLookups = state.calls
      .filter((call) => call.sql.includes("from users u") && call.sql.includes("where u.id = $1"))
      .map((call) => String(call.params[0]));
    const marketBriefRefreshed = state.calls.some((call) =>
      call.sql.includes("insert into daily_market_brief_observations")
    );

    const requestedSymbols = listMode ? parseSymbolList(process.env.AUTO_SCAN_CANARY_SYMBOLS) : [];
    const eligibleSymbols = requestedSymbols.filter((symbol) => knownEligibleSymbols.has(symbol));
    const cycleSummary = parseCycleSummary(logs);

    if (scenario === "broad") {
      assert.ok(marketRequests.some((request) => request.symbol === "BTC-USD"));
      assert.ok(marketRequests.some((request) => request.symbol === "ETH-USD"));
      assert.ok(userLookups.includes("user-a"));
      assert.ok(userLookups.includes("user-b"));
      assert.equal(marketBriefRefreshed, true);
    } else if (listMode) {
      assert.deepEqual([...new Set(userLookups)], ["user-a"]);
      if (!overlapScenario) {
        assert.ok(state.generatedRows.length >= eligibleSymbols.length);
        assert.ok(state.candidates.length >= eligibleSymbols.length);
      }
      assert.equal(state.generatedRows.every((row) => eligibleSymbols.includes(row.pair) && row.timeframe === "15m"), true);
      assert.equal(state.candidates.every((row) => eligibleSymbols.includes(row.symbol) && row.timeframe === "15m"), true);
      assert.equal(state.queueRows.every((row) => row.user_id === "user-a"), true);
      assert.equal(marketBriefRefreshed, false);
      assert.deepEqual(cycleSummary, { requested: requestedSymbols.length, scanned: eligibleSymbols.length });
      assert.ok(logs.some((message) =>
        message.includes(
          `canary scheduler enabled user=user-a symbols=${requestedSymbols.join(",")} timeframe=15m`
        )
      ));
    } else {
      assert.deepEqual([...new Set(userLookups)], ["user-a"]);
      if (!overlapScenario) {
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
      overlapSkipped: logs.some((message) => message.includes("skipped duplicates running_cycle=true")),
      requestedSymbols: cycleSummary?.requested || null,
      scannedSymbols: cycleSummary?.scanned || null,
      skippedSymbols: warnings
        .filter((message) => message.includes(" skipped: "))
        .map((message) => message.match(/\[auto-scan\] ([^ ]+) /)?.[1])
        .filter(Boolean)
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
  const configuredSymbols = process.env.AUTO_SCAN_CANARY_SYMBOLS !== undefined
    ? parseSymbolList(process.env.AUTO_SCAN_CANARY_SYMBOLS).filter((symbol) => knownEligibleSymbols.has(symbol))
    : ["BTC-USD"];
  db.configureWatcherUser({
    userId: "user-a",
    minimumConfidence: 90,
    symbols: configuredSymbols,
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
  for (const symbol of configuredSymbols) {
    db.configureAlertPreference({ userId: "user-a", symbol, timeframe: "15m" });
  }
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
  const noSetup = scenario === "overlap" || scenario === "multi-overlap";
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

function parseSymbolList(value) {
  return [...new Set(String(value || "").split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
}

function parseCycleSummary(messages) {
  const message = messages.find((entry) => entry.includes("[crypto-watch] canary cycle requested_symbols="));
  if (!message) return null;
  const match = message.match(/requested_symbols=(\d+) scanned=(\d+)/);
  return match ? { requested: Number(match[1]), scanned: Number(match[2]) } : null;
}
