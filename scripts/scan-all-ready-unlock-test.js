process.env.CRYPTO_WATCHER_ENABLED = "false";
process.env.AUTO_SCAN_ENABLED = "false";
process.env.MARKET_VERIFICATION_ENABLED = "false";

import assert from "node:assert/strict";
import { Readable } from "node:stream";

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const RealDate = globalThis.Date;
const realFetch = globalThis.fetch;
let providerCalls = 0;

class FixedDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [NOW]));
  }
  static now() { return NOW; }
}

globalThis.Date = FixedDate;
globalThis.fetch = async () => {
  providerCalls += 1;
  throw new Error("Changed market fixture: No valid setup found");
};

try {
  const transport = await import("./test-support/scan-all-ready-unlock-db-transport.mock.js");
  const { handleSignalRoutes } = await import("../src/modules/signals/signalController.js");
  transport.resetUnlockTransport();

  const user = buildUser("user-ready");
  const otherUser = buildUser("user-other");
  transport.seedUnlockUser(user);
  transport.seedUnlockUser(otherUser);
  const ready = buildReadySetup();
  const expired = buildReadySetup({ setupKey: "expired-123", validUntil: new Date(NOW - 1).toISOString() });
  transport.seedScanAllCache(user.id, "scan-all:fixture:5m-15m-1h-4h", buildScanResult([ready, expired]));

  const unlocked = await postGenerate(handleSignalRoutes, user, {
    symbol: "READY-USD", timeframe: "15m", setupKey: ready.setupKey
  });
  assert.equal(unlocked.statusCode, 201);
  assert.equal(unlocked.body.signal.setupKey, "ready-123");
  assert.equal(unlocked.body.signal.symbol, "READY-USD");
  assert.equal(unlocked.body.signal.timeframe, "15m");
  assert.equal(unlocked.body.signal.direction, "long");
  assert.equal(unlocked.body.signal.confidenceScore, 92);
  assert.equal(unlocked.body.signal.entryPrice, 100);
  assert.equal(unlocked.body.signal.stopLoss, 98);
  assert.equal(unlocked.body.signal.takeProfit, 105);
  assert.equal(unlocked.body.signal.riskRewardRatio, 2.5);
  assert.equal(unlocked.body.signal.setupType, "Breakout retest");
  assert.equal(new Date(unlocked.body.signal.validUntil).toISOString(), ready.validUntil);
  assert.equal(providerCalls, 0, "exact Scan All unlock performed a second market scan");
  assert.equal(transport.getUnlockPersistence().creditDebits, 1);

  const wrongKey = await postGenerate(handleSignalRoutes, user, {
    symbol: "READY-USD", timeframe: "15m", setupKey: "wrong-123"
  });
  assert.equal(wrongKey.statusCode, 404);
  assert.equal(transport.getUnlockPersistence().creditDebits, 1);

  const wrongUser = await postGenerate(handleSignalRoutes, otherUser, {
    symbol: "READY-USD", timeframe: "15m", setupKey: ready.setupKey
  });
  assert.equal(wrongUser.statusCode, 404);
  assert.equal(transport.getUnlockPersistence().creditDebits, 1);

  const expiredResult = await postGenerate(handleSignalRoutes, user, {
    symbol: "READY-USD", timeframe: "15m", setupKey: expired.setupKey
  });
  assert.equal(expiredResult.statusCode, 410);
  assert.equal(transport.getUnlockPersistence().creditDebits, 1);

  const duplicate = await postGenerate(handleSignalRoutes, user, {
    symbol: "READY-USD", timeframe: "15m", setupKey: ready.setupKey
  });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.alreadyUnlocked, true);
  assert.equal(transport.getUnlockPersistence().creditDebits, 1);
  assert.equal(transport.getUnlockPersistence().savedSignalInserts, 1);
  assert.equal(providerCalls, 0);

  const ordinary = await postGenerate(handleSignalRoutes, user, {
    symbol: "BTC-USD", timeframe: "15m"
  });
  assert.ok(ordinary.statusCode >= 400);
  assert.ok(providerCalls > 0, "ordinary generate no longer reached the existing live scan path");

  console.log(JSON.stringify({
    exactReadyUnlock: {
      statusCode: unlocked.statusCode,
      setupKey: unlocked.body.signal.setupKey,
      confidence: unlocked.body.signal.confidenceScore,
      entry: unlocked.body.signal.entryPrice,
      stopLoss: unlocked.body.signal.stopLoss,
      takeProfit: unlocked.body.signal.takeProfit,
      providerCallsBeforeOrdinaryGenerate: 0
    },
    rejected: {
      wrongKey: wrongKey.statusCode,
      wrongUser: wrongUser.statusCode,
      expired: expiredResult.statusCode
    },
    credits: transport.getUnlockPersistence().creditDebits,
    duplicateUnlock: duplicate.body.alreadyUnlocked,
    ordinaryGenerateProviderCalls: providerCalls,
    watcherEnabled: false
  }, null, 2));
} finally {
  globalThis.Date = RealDate;
  globalThis.fetch = realFetch;
}

function buildReadySetup(overrides = {}) {
  return {
    id: "sig-ready-123",
    setupKey: "ready-123",
    symbol: "READY-USD",
    timeframe: "15m",
    direction: "long",
    entryPrice: 100,
    stopLoss: 98,
    takeProfit: 105,
    riskRewardRatio: 2.5,
    confidenceScore: 92,
    qualityScore: 100,
    readinessScore: 100,
    validationScore: 100,
    validationPassed: true,
    generatedQualityBlocked: false,
    confidenceCalibration: { blocked: false },
    resultType: "ready_signal",
    status: "Active",
    setupType: "Breakout retest",
    strategy: "Breakout retest",
    reasoning: "Exact server-owned Scan All snapshot.",
    confirmations: [],
    indicators: { readinessScore: 100 },
    marketSource: "coinbase-exchange",
    generatedAt: new Date(NOW - 60_000).toISOString(),
    validUntil: new Date(NOW + 60 * 60_000).toISOString(),
    ...overrides
  };
}

function buildScanResult(fullSetups) {
  return {
    publicResult: {
      setups: fullSetups.map(({ entryPrice, stopLoss, takeProfit, ...preview }) => preview),
      scanned: [],
      scanSummary: { ready: fullSetups.length }
    },
    fullSetups
  };
}

function buildUser(id) {
  return {
    id,
    role: "user",
    plan: "pro",
    emailVerifiedAt: new Date(NOW - 86_400_000).toISOString(),
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
