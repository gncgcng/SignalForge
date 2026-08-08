process.env.CRYPTO_WATCHER_ENABLED = "false";
process.env.AUTO_SCAN_ENABLED = "false";
process.env.MARKET_VERIFICATION_ENABLED = "false";
process.env.CANDIDATE_SCAN_MARKETS_PER_CYCLE = "1";
process.env.TELEGRAM_BOT_TOKEN = "fixture-bot-token";

import assert from "node:assert/strict";

const LONDON_NOW_MS = Date.UTC(2026, 1, 3, 8, 30, 0);
const LOW_LIQUIDITY_NOW_MS = Date.UTC(2026, 1, 3, 23, 30, 0);
let currentNowMs = LONDON_NOW_MS;
let activeFixtures = new Map();
const telegramDeliveries = [];
const marketRequests = [];
const warnings = [];
const logs = [];
const RealDate = globalThis.Date;
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realLog = console.log;

class FixedDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [currentNowMs]));
  }

  static now() {
    return currentNowMs;
  }
}

globalThis.Date = FixedDate;
globalThis.fetch = deterministicFetch;
console.warn = (...args) => {
  warnings.push(args.map(String).join(" "));
  realWarn(...args);
};
console.log = (...args) => {
  logs.push(args.map(String).join(" "));
  realLog(...args);
};

let passed = 0;
const results = {};

try {
  const db = await import("./test-support/auto-crypto-watcher-db-transport.mock.js");
  const {
    runAutoCryptoAlertScan,
    startAutoCryptoAlertScanner
  } = await import("../src/modules/alerts/autoScanService.js");
  const { processTelegramQueue } = await import("../src/modules/notifications/notificationQueue.js");
  const { evaluateTelegramSignalEligibility } = await import(
    "../src/modules/notifications/notificationService.js"
  );
  const { runAutoCryptoWatcherSmokeCli } = await import("./run-auto-crypto-watcher-smoke.js");

  await testDisabledStartupGuard(startAutoCryptoAlertScanner);
  passed += 1;

  db.resetAutoCryptoWatcherTransport();
  db.configureWatcherUser({
    minimumConfidence: 90,
    symbols: ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD"]
  });
  currentNowMs = LONDON_NOW_MS;
  activeFixtures = new Map([
    ["BTC-USD", readyFixture()],
    ["ETH-USD", { ...readyFixture(), higherUnavailable: true }],
    ["SOL-USD", noSetupFixture()],
    ["XRP-USD", { providerFailure: true }]
  ]);

  const firstRun = await runAutoCryptoAlertScan();
  const firstState = db.getAutoCryptoWatcherState();
  const btc = generatedFor(firstState, "BTC-USD");
  const eth = generatedFor(firstState, "ETH-USD");

  assert.equal(firstRun.scanned, 4, "watcher did not scan every selected market");
  assertReadyGeneratedSignal(btc);
  assert.equal(Number(btc.confidence), 92);
  assert.equal(Number(eth.confidence), 88);
  assert.equal(eth.status, "Active");
  assert.equal(firstState.generatedRows.some((row) => row.pair === "SOL-USD" && row.status === "Active"), false);
  assert.equal(firstState.generatedRows.some((row) => row.pair === "XRP-USD"), false);
  assert.equal(firstState.queueRows.length, 1);
  assert.equal(firstState.queueRows[0].status, "queued");
  assert.equal(firstState.queueRows[0].payload.symbol, "BTC-USD");
  assert.equal(Number(firstState.queueRows[0].payload.confidenceScore), Number(btc.confidence));
  assert.equal(firstState.queueRows.some((row) => row.payload.symbol === "ETH-USD"), false);
  assert.equal(warnings.some((message) => message.includes("XRP-USD 15m skipped")), true);
  assert.equal(logs.some((message) => message.includes("telegram alert queued")), true);
  assert.equal(logs.some((message) => message.includes("telegram alert sent")), false);
  assertNoCreditWrites(firstState.calls);
  assertCanonicalSnapshot(firstState, btc);
  passed += 1;
  passed += 1;
  passed += 1;
  results.multipleMarketBatch = {
    scanned: firstRun.scanned,
    ready: { symbol: btc.pair, confidence: Number(btc.confidence), queued: true },
    belowThreshold: { symbol: eth.pair, confidence: Number(eth.confidence), queued: false },
    noSetup: "SOL-USD",
    providerFailure: "XRP-USD"
  };
  passed += 1;

  await processTelegramQueue();
  const deliveredState = db.getAutoCryptoWatcherState();
  assert.equal(deliveredState.queueRows[0].status, "sent");
  assert.equal(telegramDeliveries.length, 1);
  assert.equal(telegramDeliveries[0].chatId, "10001");
  passed += 1;
  results.delivery = { queuedBeforeWorker: true, statusAfterWorker: "sent" };

  const beforeDuplicate = snapshotGenerated(btc);
  const duplicateRun = await runAutoCryptoAlertScan();
  const duplicateState = db.getAutoCryptoWatcherState();
  const duplicateBtc = generatedFor(duplicateState, "BTC-USD");
  assert.equal(duplicateState.generatedRows.filter((row) => row.setup_key === btc.setup_key).length, 1);
  assert.deepEqual(snapshotGenerated(duplicateBtc), beforeDuplicate);
  assert.deepEqual(
    [...duplicateBtc.source_history].sort(),
    ["auto_crypto_watcher", "candidate_promotion", "telegram_alert"].sort()
  );
  assert.equal(duplicateState.queueRows.length, 1);
  assert.equal(telegramDeliveries.length, 1);
  assert.ok(duplicateRun.skippedDuplicates >= 1);
  passed += 1;
  results.duplicateSafety = {
    generatedRows: 1,
    queueRows: 1,
    sourceHistory: duplicateBtc.source_history
  };

  const canonicalPayload = firstState.queueRows[0].payload;
  const settings = {
    enabled: true,
    favoriteMarketsOnly: false,
    timeframes: [canonicalPayload.timeframe],
    direction: canonicalPayload.direction,
    minimumConfidence: 90
  };
  const boundary89 = evaluateTelegramSignalEligibility(
    settings,
    new Set(),
    { ...canonicalPayload, confidenceScore: 89 },
    LONDON_NOW_MS
  );
  const boundary90 = evaluateTelegramSignalEligibility(
    settings,
    new Set(),
    { ...canonicalPayload, confidenceScore: 90 },
    LONDON_NOW_MS
  );
  assert.equal(boundary89.eligible, false);
  assert.equal(boundary89.reason, "below_user_threshold");
  assert.equal(boundary90.eligible, true, boundary90.reason);
  assert.equal(settings.minimumConfidence, 90);
  passed += 1;
  results.telegramBoundary = {
    globalMinimum: 80,
    savedMinimum: 90,
    confidence89: boundary89.reason,
    confidence90: "eligible"
  };

  db.resetAutoCryptoWatcherTransport();
  db.configureWatcherUser({ minimumConfidence: 90, symbols: ["LTC-USD"] });
  currentNowMs = LOW_LIQUIDITY_NOW_MS;
  activeFixtures = new Map([["LTC-USD", readyFixture()]]);
  const shadowRun = await runAutoCryptoAlertScan();
  const shadowState = db.getAutoCryptoWatcherState();
  const shadow = generatedFor(shadowState, "LTC-USD");
  assert.equal(shadowRun.scanned, 1);
  assertReadyGeneratedSignal(shadow);
  assert.ok(Number(shadow.confidence) >= 80 && Number(shadow.confidence) <= 84);
  assert.equal(shadowState.queueRows.length, 0);
  assert.equal(shadow.realized_r ?? null, null);
  assert.equal(shadow.status, "Active");
  assertNoCreditWrites(shadowState.calls);
  passed += 1;
  results.forwardShadow = {
    symbol: shadow.pair,
    confidence: Number(shadow.confidence),
    persisted: true,
    queued: false,
    realizedR: shadow.realized_r ?? null
  };

  db.resetAutoCryptoWatcherTransport();
  db.configureWatcherUser({
    userId: "user-a",
    minimumConfidence: 90,
    symbols: ["BTC-USD", "ETH-USD", "SOL-USD"],
    timeframes: ["15m", "1h", "4h"],
    chatId: "10001"
  });
  db.configureWatcherUser({
    userId: "user-b",
    minimumConfidence: 80,
    symbols: ["BTC-USD", "ETH-USD", "SOL-USD"],
    timeframes: ["15m", "1h", "4h"],
    chatId: "10002"
  });
  db.configureAlertPreference({ userId: "user-a", symbol: "BTC-USD", timeframe: "15m" });
  db.configureAlertPreference({ userId: "user-a", symbol: "ETH-USD", timeframe: "1h" });
  db.configureAlertPreference({ userId: "user-b", symbol: "BTC-USD", timeframe: "15m" });
  db.configureAlertPreference({ userId: "user-b", symbol: "SOL-USD", timeframe: "4h" });
  currentNowMs = LONDON_NOW_MS;
  activeFixtures = new Map([
    ["BTC-USD", readyFixture()],
    ["ETH-USD", readyFixture()],
    ["SOL-USD", readyFixture()]
  ]);
  marketRequests.length = 0;

  const scopedRun = await runAutoCryptoAlertScan({
    symbol: "BTC-USD",
    timeframe: "15m",
    userId: "user-a"
  });
  const scopedState = db.getAutoCryptoWatcherState();
  assert.equal(scopedRun.scanned, 2, "scoped alert and Telegram paths were not both exercised");
    assert.equal(
      marketRequests.some((request) => request.symbol !== "BTC-USD"),
      false,
      "scoped smoke run must not fetch candles for unrelated markets"
    );
  assert.ok(scopedState.generatedRows.length >= 1);
  assert.equal(scopedState.generatedRows.every((row) => row.pair === "BTC-USD" && row.timeframe === "15m"), true);
  assert.ok(scopedState.candidates.length >= 1);
  assert.equal(scopedState.candidates.every((row) => row.symbol === "BTC-USD" && row.timeframe === "15m"), true);
  assert.equal(scopedState.detectedAlerts.length, 1);
  assert.equal(scopedState.detectedAlerts[0].user_id, "user-a");
  assert.equal(scopedState.detectedAlerts[0].symbol, "BTC-USD");
  assert.equal(scopedState.detectedAlerts[0].timeframe, "15m");
  assert.equal(scopedState.queueRows.length, 1);
  assert.equal(scopedState.queueRows[0].user_id, "user-a");
  assert.equal(scopedState.queueRows[0].payload.symbol, "BTC-USD");
  assert.equal(scopedState.queueRows[0].payload.timeframe, "15m");
  assertNoCreditWrites(scopedState.calls);
  passed += 1;
  results.scopedRun = {
    scanned: scopedRun.scanned,
    symbols: [...new Set(scopedState.generatedRows.map((row) => row.pair))],
    timeframes: [...new Set(scopedState.generatedRows.map((row) => row.timeframe))],
    usersQueued: [...new Set(scopedState.queueRows.map((row) => row.user_id))],
    candidateMarkets: [...new Set(scopedState.candidates.map((row) => `${row.symbol}:${row.timeframe}`))]
  };

  db.resetAutoCryptoWatcherTransport();
  await assert.rejects(
    runAutoCryptoAlertScan({ symbol: "BTC-USD", timeframe: "15m" }),
    (error) => error.code === "AUTO_SCAN_SCOPE_INCOMPLETE"
  );
  await assert.rejects(
    runAutoCryptoAlertScan({ symbol: "BTC-USD", timeframe: "2h", userId: "user-a" }),
    (error) => error.code === "AUTO_SCAN_SCOPE_UNSUPPORTED_TIMEFRAME"
  );
  await assert.rejects(
    runAutoCryptoAlertScan({ symbol: "NOT-A-MARKET", timeframe: "15m", userId: "user-a" }),
    (error) => error.code === "AUTO_SCAN_SCOPE_INELIGIBLE_MARKET"
  );
  db.configureWatcherUser({ userId: "disabled-user", symbols: ["BTC-USD"], enabled: false });
  await assert.rejects(
    runAutoCryptoAlertScan({ symbol: "BTC-USD", timeframe: "15m", userId: "disabled-user" }),
    (error) => error.code === "AUTO_SCAN_SCOPE_TELEGRAM_DISABLED"
  );
  const failedScopeState = db.getAutoCryptoWatcherState();
  assert.equal(failedScopeState.generatedRows.length, 0);
  assert.equal(failedScopeState.queueRows.length, 0);
  assert.equal(failedScopeState.candidates.length, 0);
  passed += 1;
  results.failClosed = {
    incomplete: true,
    unsupportedTimeframe: true,
    ineligibleMarket: true,
    disabledTelegramUser: true,
    writes: 0
  };

  let cliInvocations = 0;
  let cliCloses = 0;
  const cliOutput = [];
  const cliRuntime = async () => ({
    runAutoCryptoAlertScan: async (scope) => {
      cliInvocations += 1;
      assert.deepEqual(scope, { symbol: "BTC-USD", timeframe: "15m", userId: "user-a" });
      return { scanned: 1, alertsCreated: 0, telegramAlertsQueued: 0, skippedDuplicates: 0 };
    },
    close: async () => { cliCloses += 1; }
  });
  await assert.rejects(
    runAutoCryptoWatcherSmokeCli({
      argv: ["--symbol", "BTC-USD", "--timeframe", "15m", "--user-id", "user-a"],
      env: { CRYPTO_WATCHER_ENABLED: "true" },
      loadRuntime: cliRuntime,
      write: (value) => cliOutput.push(value)
    }),
    (error) => error.code === "AUTO_SCAN_SMOKE_WATCHER_NOT_DISABLED"
  );
  assert.equal(cliInvocations, 0);
  await runAutoCryptoWatcherSmokeCli({
    argv: ["--symbol", "BTC-USD", "--timeframe", "15m", "--user-id", "user-a"],
    env: { CRYPTO_WATCHER_ENABLED: "false" },
    loadRuntime: cliRuntime,
    write: (value) => cliOutput.push(value)
  });
  assert.equal(cliInvocations, 1);
  assert.equal(cliCloses, 1);
  const safety = JSON.parse(cliOutput[0]);
  assert.deepEqual(safety, {
    symbol: "BTC-USD",
    timeframe: "15m",
    userId: "user-a",
    watcherScheduled: false,
    singleRun: true
  });
  passed += 1;
  results.smokeCli = { enabledRefused: true, disabledPermitted: true, invocations: cliInvocations, closes: cliCloses };

  assert.equal(passed, 12);
  console.log(JSON.stringify({
    watcherFunctionExecuted: true,
    tests: { passed, failed: 0 },
    ...results
  }, null, 2));
} finally {
  globalThis.Date = RealDate;
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.log = realLog;
}

async function testDisabledStartupGuard(startAutoCryptoAlertScanner) {
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  let timeoutCalls = 0;
  let intervalCalls = 0;
  globalThis.setTimeout = () => { timeoutCalls += 1; return 1; };
  globalThis.setInterval = () => { intervalCalls += 1; return 1; };
  try {
    startAutoCryptoAlertScanner();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  }
  assert.equal(timeoutCalls, 0);
  assert.equal(intervalCalls, 0);
  assert.equal(logs.some((message) => message.includes("disabled by CRYPTO_WATCHER_ENABLED=false")), true);
  results.disabledGuard = { timeoutCalls, intervalCalls, watcherEnabled: false };
}

async function deterministicFetch(input, init = {}) {
  const url = new URL(String(input));
  if (url.hostname === "api.telegram.org") {
    const body = JSON.parse(String(init.body || "{}"));
    telegramDeliveries.push({ chatId: String(body.chat_id), text: body.text });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7001 } }), { status: 200 });
  }
  if (!url.pathname.includes("/candles")) {
    throw new Error(`Unexpected network boundary request: ${url.href}`);
  }
  const symbol = decodeURIComponent(url.pathname.split("/")[2] || "");
  marketRequests.push({ symbol, granularity: Number(url.searchParams.get("granularity")) });
  const fixture = activeFixtures.get(symbol) || readyFixture();
  if (fixture.providerFailure) {
    return new Response("provider failed", { status: 503 });
  }
  const granularity = Number(url.searchParams.get("granularity"));
  if (fixture.higherUnavailable && granularity !== 900) {
    return new Response("higher timeframe unavailable", { status: 503 });
  }
  const candles = buildCandles(granularity, fixture).map((candle) => [
    candle.time,
    candle.low,
    candle.high,
    candle.open,
    candle.close,
    candle.volume
  ]).reverse();
  return new Response(JSON.stringify(candles), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function readyFixture() {
  return { slope: 0.03, amplitude: 0.8, phase: 1.4, padding: 0.144, lastMove: 0.096, lastVolume: 1800 };
}

function noSetupFixture() {
  return { slope: 0, amplitude: 0.02, phase: 0, padding: 0.04, lastMove: 0, lastVolume: 1000 };
}

function buildCandles(granularity, fixture) {
  const interval = Number.isFinite(granularity) && granularity > 0 ? granularity : 900;
  const latestTime = Math.floor(currentNowMs / 1000 / interval) * interval;
  const candles = [];
  for (let index = 0; index < 120; index += 1) {
    const close = 100 + index * fixture.slope + Math.sin(index * 0.38 + fixture.phase) * fixture.amplitude;
    const previousClose = index ? candles[index - 1].close : close - fixture.slope;
    const open = index === 119 ? close - fixture.lastMove : previousClose;
    candles.push({
      time: latestTime - (119 - index) * interval,
      open,
      high: Math.max(open, close) + fixture.padding,
      low: Math.min(open, close) - fixture.padding,
      close,
      volume: index === 119 ? fixture.lastVolume : 1000 + (index % 7) * 15
    });
  }
  return candles;
}

function generatedFor(state, pair) {
  const rows = state.generatedRows.filter((row) => row.pair === pair && row.status === "Active");
  assert.ok(rows.length >= 1, `No Active generated signal persisted for ${pair}`);
  return rows[0];
}

function assertReadyGeneratedSignal(row) {
  assert.equal(row.status, "Active");
  assert.ok(row.setup_key);
  assert.ok(Number.isFinite(Number(row.confidence)));
  assert.ok(Number.isFinite(Number(row.entry)));
  assert.ok(Number.isFinite(Number(row.stop_loss)));
  assert.ok(Number.isFinite(Number(row.take_profit)));
  assert.ok(Number.isFinite(Number(row.risk_reward)));
  assert.equal(row.confidence_calibration?.blocked === true, false);
  assert.equal(row.validation_summary?.generatedQualityBlocked === true, false);
}

function assertCanonicalSnapshot(state, row) {
  const queuePayload = state.queueRows.find((item) => item.payload.setupKey === row.setup_key)?.payload;
  assert.ok(queuePayload, "canonical signal was not passed to Telegram eligibility");
  assert.equal(queuePayload.entryPrice, Number(row.entry));
  assert.equal(queuePayload.stopLoss, Number(row.stop_loss));
  assert.equal(queuePayload.takeProfit, Number(row.take_profit));
  assert.equal(queuePayload.riskRewardRatio, Number(row.risk_reward));
  assert.equal(queuePayload.confidenceScore, Number(row.confidence));
  assert.deepEqual(queuePayload.confidenceCalibration || {}, row.confidence_calibration || {});
}

function snapshotGenerated(row) {
  return {
    source: row.source,
    setupKey: row.setup_key,
    status: row.status,
    entry: row.entry,
    stopLoss: row.stop_loss,
    takeProfit: row.take_profit,
    riskReward: row.risk_reward,
    confidence: row.confidence,
    calibration: row.confidence_calibration,
    analysis: row.full_analysis,
    validUntil: row.valid_until
  };
}

function assertNoCreditWrites(calls) {
  const writes = calls.filter((call) => /(?:insert into|update|delete from) (?:credit_balances|setup_discovery_usage|unlocked_signals)/.test(call.sql));
  assert.deepEqual(writes, [], "watcher or Telegram rejection consumed credits");
}
