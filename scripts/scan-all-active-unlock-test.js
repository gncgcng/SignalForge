process.env.CRYPTO_WATCHER_ENABLED = "false";
process.env.AUTO_SCAN_ENABLED = "false";
process.env.MARKET_VERIFICATION_ENABLED = "false";
process.env.MANUAL_SCAN_CONCURRENCY = "2";
process.env.MANUAL_SCAN_PROVIDER_DELAY_MS = "0";
process.env.CRYPTO_MAX_CONCURRENT_REQUESTS = "5";

import assert from "node:assert/strict";
import { Readable } from "node:stream";

const FIXED_NOW_MS = Date.UTC(2026, 7, 12, 12, 0, 0);
const HELD_SYMBOLS = new Set([
  "PEPE-USD", "BONK-USD", "WIF-USD", "FLOKI-USD", "FIL-USD",
  "ALGO-USD", "XLM-USD", "HBAR-USD", "SEI-USD"
]);
const RealDate = globalThis.Date;
const realFetch = globalThis.fetch;
let currentNowMs = FIXED_NOW_MS;
let providerCalls = 0;
const providerCallsBySymbol = new Map();
const deferredBySymbol = new Map();

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
globalThis.__signalForgeActiveScanMarketData = (symbol) => {
  if (!HELD_SYMBOLS.has(symbol)) return null;
  return getDeferred(symbol).promise.then(() => {
    const error = new Error(`${symbol} intentionally unavailable after held test request.`);
    error.code = "PROVIDER_UNSUPPORTED_MARKET";
    error.statusCode = 400;
    throw error;
  });
};

try {
  const transport = await import("./test-support/scan-all-active-unlock-db-transport.mock.js");
  const {
    getScanAllJobStatus,
    startScanAllJob
  } = await import("../src/modules/signals/signalService.js");
  const { handleSignalRoutes } = await import("../src/modules/signals/signalController.js");

  transport.resetActiveScanUnlockTransport();
  const user = buildUser("user-active-scan");
  const otherUser = buildUser("user-other-scan");
  transport.seedActiveScanUnlockUser(user);
  transport.seedActiveScanUnlockUser(otherUser);

  const started = await startScanAllJob(user, { marketType: "crypto" });
  assert.equal(started.status, "queued");
  const partial = await waitForJob(getScanAllJobStatus, user, started.jobId, (status) =>
    status.status === "running" && status.setups.length >= 3 && status.progress.scannedMarkets < status.progress.totalMarkets
  );

  assert.equal(partial.status, "running");
  assert.ok(partial.progress.totalMarkets >= 10, "focused universe must represent a multi-market scan");
  assert.ok(partial.progress.scannedMarkets < partial.progress.totalMarkets);
  assertPublicStatusIsSafe(partial);

  const btc = findSetup(partial, "BTC-USD");
  const sol = findSetup(partial, "SOL-USD");
  const eth = findSetup(partial, "ETH-USD");
  const generatedBeforeUnlock = transport.getActiveScanUnlockPersistence();
  const btcSnapshot = findGeneratedSnapshot(generatedBeforeUnlock, btc);
  const solSnapshot = findGeneratedSnapshot(generatedBeforeUnlock, sol);
  const providerCallsBeforeUnlock = providerCalls;
  const generatedSaveCallsBeforeUnlock = generatedBeforeUnlock.generatedSaveCalls.length;

  const wrongKey = await postGenerate(handleSignalRoutes, user, {
    symbol: btc.symbol,
    timeframe: btc.timeframe,
    setupKey: "wrong-active-setup-key"
  });
  assert.equal(wrongKey.statusCode, 404);

  const wrongUser = await postGenerate(handleSignalRoutes, otherUser, {
    symbol: btc.symbol,
    timeframe: btc.timeframe,
    setupKey: btc.setupKey
  });
  assert.equal(wrongUser.statusCode, 404);
  assert.equal(transport.getActiveScanUnlockPersistence().savedSignalInserts, 0);
  assert.equal(transport.getActiveScanUnlockPersistence().creditDebits, 0);

  assert.throws(
    () => getScanAllJobStatus(otherUser, started.jobId),
    (error) => error?.statusCode === 404
  );

  const otherStarted = await startScanAllJob(otherUser, { marketType: "commodities" });
  await waitForJob(getScanAllJobStatus, otherUser, otherStarted.jobId, (status) => status.status === "running");
  const crossJobLookup = await postGenerate(handleSignalRoutes, otherUser, {
    symbol: btc.symbol,
    timeframe: btc.timeframe,
    setupKey: btc.setupKey
  });
  assert.equal(crossJobLookup.statusCode, 404);

  const unlockedBtc = await postGenerate(handleSignalRoutes, user, {
    symbol: btc.symbol,
    timeframe: btc.timeframe,
    setupKey: btc.setupKey
  });
  assertExactUnlockedSnapshot(unlockedBtc, btcSnapshot);
  assert.equal(getScanAllJobStatus(user, started.jobId).status, "running");

  const unlockedSol = await postGenerate(handleSignalRoutes, user, {
    symbol: sol.symbol,
    timeframe: sol.timeframe,
    setupKey: sol.setupKey
  });
  assertExactUnlockedSnapshot(unlockedSol, solSnapshot);
  assert.notEqual(unlockedBtc.body.signal.setupKey, unlockedSol.body.signal.setupKey);
  assert.equal(providerCalls, providerCallsBeforeUnlock, "exact active Scan All unlock made a provider request");
  assert.equal(
    transport.getActiveScanUnlockPersistence().generatedSaveCalls.length,
    generatedSaveCallsBeforeUnlock,
    "exact active Scan All unlock ran signal generation again"
  );

  currentNowMs = FIXED_NOW_MS + 6 * 60 * 60 * 1000 + 60_000;
  releaseDeferred("PEPE-USD");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const refreshedRunning = await waitForJob(getScanAllJobStatus, user, started.jobId, (status) =>
    status.status === "running" && new Date(status.updatedAt).getTime() === currentNowMs
  );
  assert.equal(refreshedRunning.status, "running");

  const expired = await postGenerate(handleSignalRoutes, user, {
    symbol: eth.symbol,
    timeframe: eth.timeframe,
    setupKey: eth.setupKey
  });
  assert.equal(expired.statusCode, 410);
  assert.equal(transport.getActiveScanUnlockPersistence().savedSignalInserts, 2);
  assert.equal(transport.getActiveScanUnlockPersistence().creditDebits, 0);
  assert.equal(providerCalls, providerCallsBeforeUnlock, "failed exact lookups caused another provider scan");

  releaseAllDeferred();
  const completed = await waitForJob(getScanAllJobStatus, user, started.jobId, (status) =>
    status.status === "completed"
  );
  const otherCompleted = await waitForJob(getScanAllJobStatus, otherUser, otherStarted.jobId, (status) =>
    status.status === "completed"
  );
  assert.equal(completed.progress.scannedMarkets, completed.progress.totalMarkets);
  assert.equal(otherCompleted.progress.scannedMarkets, otherCompleted.progress.totalMarkets);
  assertPublicStatusIsSafe(completed);

  console.log(JSON.stringify({
    activeUnlock: {
      jobStatusAtUnlock: partial.status,
      totalMarkets: partial.progress.totalMarkets,
      scannedMarketsAtUnlock: partial.progress.scannedMarkets,
      readySetupsAtUnlock: partial.setups.length,
      unlockedSetupKeys: [unlockedBtc.body.signal.setupKey, unlockedSol.body.signal.setupKey],
      providerCallsAddedByUnlock: providerCalls - providerCallsBeforeUnlock,
      generationSavesAddedByUnlock: transport.getActiveScanUnlockPersistence().generatedSaveCalls.length - generatedSaveCallsBeforeUnlock
    },
    rejected: {
      wrongKey: wrongKey.statusCode,
      wrongUser: wrongUser.statusCode,
      crossJobLookup: crossJobLookup.statusCode,
      expired: expired.statusCode
    },
    isolation: {
      privateSnapshotsSerialized: false,
      creditDebits: transport.getActiveScanUnlockPersistence().creditDebits
    },
    completion: {
      firstUser: completed.status,
      secondUser: otherCompleted.status,
      scannedMarkets: completed.progress.scannedMarkets
    }
  }, null, 2));
} finally {
  releaseAllDeferred();
  globalThis.Date = RealDate;
  globalThis.fetch = realFetch;
  delete globalThis.__signalForgeActiveScanMarketData;
}

async function deterministicFetch(input) {
  const url = new URL(String(input));
  if (!url.pathname.includes("/candles")) {
    throw new Error(`Unexpected network boundary request: ${url.href}`);
  }
  const symbol = decodeURIComponent(url.pathname.match(/\/products\/([^/]+)\/candles/)?.[1] || "");
  providerCalls += 1;
  providerCallsBySymbol.set(symbol, Number(providerCallsBySymbol.get(symbol) || 0) + 1);

  const granularity = Number(url.searchParams.get("granularity"));
  const candles = buildFixedCandles(granularity).map((candle) => [
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

function buildFixedCandles(granularity) {
  const interval = Number.isFinite(granularity) && granularity > 0 ? granularity : 900;
  const latestTime = Math.floor(currentNowMs / 1000 / interval) * interval;
  const candles = [];
  for (let index = 0; index < 120; index += 1) {
    const close = 100 + index * 0.03 + Math.sin(index * 0.38 + 1.4) * 0.8;
    const previousClose = index ? candles[index - 1].close : close - 0.03;
    const open = index === 119 ? close - 0.096 : previousClose;
    const padding = 0.144;
    candles.push({
      time: latestTime - (119 - index) * interval,
      open,
      high: Math.max(open, close) + padding,
      low: Math.min(open, close) - padding,
      close,
      volume: index === 119 ? 1800 : 1000 + (index % 7) * 15
    });
  }
  return candles;
}

function getDeferred(symbol) {
  if (!deferredBySymbol.has(symbol)) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    deferredBySymbol.set(symbol, { promise, resolve, released: false });
  }
  return deferredBySymbol.get(symbol);
}

function releaseDeferred(symbol) {
  const deferred = getDeferred(symbol);
  if (!deferred.released) {
    deferred.released = true;
    deferred.resolve();
  }
}

function releaseAllDeferred() {
  for (const symbol of ["PEPE-USD", "BONK-USD", "WIF-USD", "FLOKI-USD", "FIL-USD", "ALGO-USD", "XLM-USD", "HBAR-USD", "SEI-USD"]) {
    releaseDeferred(symbol);
  }
}

async function waitForJob(getStatus, user, jobId, predicate, timeoutMs = 10_000) {
  const startedAt = RealDate.now();
  let last;
  while (RealDate.now() - startedAt < timeoutMs) {
    last = getStatus(user, jobId);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for scan job. Provider calls: ${JSON.stringify(Object.fromEntries(providerCallsBySymbol))}. ` +
    `Last status: ${JSON.stringify(last)}`
  );
}

function findSetup(status, symbol) {
  const setup = status.setups.find((item) => item.symbol === symbol);
  assert.ok(setup, `${symbol} was not present in partial public results`);
  assert.ok(String(setup.setupKey || "").trim());
  return setup;
}

function findGeneratedSnapshot(persistence, setup) {
  const row = persistence.generatedRows.find((item) => item.setup_key === setup.setupKey);
  assert.ok(row, `server-owned generated snapshot missing for ${setup.setupKey}`);
  return row;
}

function assertExactUnlockedSnapshot(response, snapshot) {
  assert.equal(response.statusCode, 201);
  const signal = response.body.signal;
  assert.equal(signal.setupKey, snapshot.setup_key);
  assert.equal(signal.symbol, snapshot.pair);
  assert.equal(signal.timeframe, snapshot.timeframe);
  assert.equal(signal.direction, snapshot.direction);
  assert.equal(signal.confidenceScore, Number(snapshot.confidence));
  assert.equal(signal.entryPrice, Number(snapshot.entry));
  assert.equal(signal.stopLoss, Number(snapshot.stop_loss));
  assert.equal(signal.takeProfit, Number(snapshot.take_profit));
  assert.equal(signal.riskRewardRatio, Number(snapshot.risk_reward));
}

function assertPublicStatusIsSafe(status) {
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes("privateFullSetups"), false);
  assert.equal(Object.hasOwn(status, "fullSetups"), false);
  for (const setup of status.setups) {
    assert.equal(Object.hasOwn(setup, "entryPrice"), false);
    assert.equal(Object.hasOwn(setup, "stopLoss"), false);
    assert.equal(Object.hasOwn(setup, "takeProfit"), false);
  }
}

function buildUser(id) {
  return {
    id,
    role: "tester",
    plan: "elite",
    emailVerifiedAt: new Date(FIXED_NOW_MS - 86_400_000).toISOString(),
    unlockCreditsBalance: 3,
    lifetimeUnlocksUsed: 0,
    trialSignalsUsed: 0
  };
}

async function postGenerate(handleSignalRoutes, user, payload) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = "POST";
  req.user = user;
  req.url = "/api/signals/generate";
  req.headers = { host: "localhost" };
  const response = { statusCode: null, body: null };
  const res = {
    writeHead: (statusCode) => { response.statusCode = statusCode; },
    end: (body) => { response.body = JSON.parse(body); }
  };
  await handleSignalRoutes(req, res, "/api/signals/generate");
  return response;
}
