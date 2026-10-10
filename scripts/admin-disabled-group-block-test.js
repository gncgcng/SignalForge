// Admin "disabled_by_admin" overrides block publication on every path, with the signal_strategy_statuses loader
// mocked at the DB transport (no production DB, no network). Drives the real auto-scan cycle (scan + Telegram
// enqueue), manual scan, and the three unlock re-validations against deterministic Coinbase candle fixtures.
process.env.CRYPTO_WATCHER_ENABLED = "false";
process.env.AUTO_SCAN_ENABLED = "false";
process.env.MARKET_VERIFICATION_ENABLED = "false";
process.env.TELEGRAM_BOT_TOKEN = "fixture-bot-token";

import assert from "node:assert/strict";

const START_MS = Date.UTC(2026, 1, 3, 8, 30, 0);
const CACHE_WINDOW_MS = 30 * 1000;
let currentNowMs = START_MS;
const RealDate = globalThis.Date;
const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;

class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [currentNowMs])); }
  static now() { return currentNowMs; }
}

// BTC-USD produces a long Multi-timeframe continuation; ETH-USD is its mirror image and produces the short.
const LONG_FIXTURE = { slope: 0.03, amplitude: 0.8, phase: 1.4, padding: 0.144, lastMove: 0.096, lastVolume: 1800 };
const SHORT_FIXTURE = { ...LONG_FIXTURE, slope: -0.03, phase: 1.4 + Math.PI, lastMove: -0.096 };
const fixtures = new Map([["BTC-USD", LONG_FIXTURE], ["ETH-USD", SHORT_FIXTURE]]);
const USER = { id: "watcher-user", role: "tester", plan: "tester", unlockCreditsBalance: 0, lifetimeUnlocksUsed: 0, trialSignalsUsed: 0 };
const SHORT_DISABLED = [{ group_key: "direction:short", status: "disabled_by_admin", admin_note: "pause shorts" }];
const passed = [];

globalThis.Date = FixedDate;
globalThis.fetch = deterministicFetch;
console.log = () => {};
console.warn = () => {};

try {
  const db = await import("./test-support/admin-disabled-db-transport.mock.js");
  const { runAutoCryptoAlertScan } = await import("../src/modules/alerts/autoScanService.js");
  const { scanMarketSetupDetailed, createSignal, unlockTelegramSignal } = await import("../src/modules/signals/signalService.js");
  const { findAdminDisabledGroup, updateSignalGroupStatus } = await import("../src/modules/signals/signalConfidenceCalibrationService.js");

  const check = async (name, fn) => { await fn(); passed.push(name); };
  // Each scenario starts a fresh cache window, so the override rows it sets are what the loader returns.
  const nextWindow = () => { currentNowMs += CACHE_WINDOW_MS + 1000; };
  const resetWatcher = (rows) => {
    db.resetAutoCryptoWatcherTransport();
    db.clearValidationRejections();
    db.clearGroupStats();
    db.configureWatcherUser({ userId: USER.id, minimumConfidence: 0, symbols: ["BTC-USD", "ETH-USD"] });
    db.setAdminOverrideRows(rows);
  };
  const cycle = async (rows) => {
    nextWindow();
    resetWatcher(rows);
    const loadsBefore = db.getAdminOverrideLoads();
    await runAutoCryptoAlertScan();
    return { ...db.getAutoCryptoWatcherState(), rejections: db.getValidationRejections(), overrideLoads: db.getAdminOverrideLoads() - loadsBefore };
  };
  const active = (state, pair) => state.generatedRows.filter((row) => row.pair === pair && row.status === "Active");
  const queued = (state, pair) => state.queueRows.filter((row) => row.payload.symbol === pair);
  const isUnlockSave = (error) => error.code === db.UNLOCK_SAVE_REACHED;

  // ---------- baseline: no override rows ----------
  const baseline = await cycle([]);
  await check("no overrides: the long and the short both publish and queue to Telegram", () => {
    assert.equal(active(baseline, "BTC-USD")[0]?.direction, "long");
    assert.equal(active(baseline, "ETH-USD")[0]?.direction, "short");
    assert.equal(queued(baseline, "BTC-USD").length, 1);
    assert.equal(queued(baseline, "ETH-USD").length, 1);
    assert.deepEqual(baseline.rejections, []);
  });
  await check("overrides are loaded once per scan cycle, not per signal or group", () => {
    assert.equal(baseline.overrideLoads, 1);
  });

  // ---------- rows that are not disabled_by_admin, or match nothing: identical output ----------
  const unrelated = await cycle([
    { group_key: "direction:long", status: "quarantined" },
    { group_key: "timeframe:1h", status: "watchlist" },
    { group_key: "pair:sol-usd", status: "disabled_by_admin" }
  ]);
  await check("admin rows that are not disabled_by_admin, or match no signal, change nothing", () => {
    assert.deepEqual(snapshot(unrelated), snapshot(baseline));
  });

  // ---------- direction:short disabled: auto_crypto_watcher scan + Telegram enqueue ----------
  const shortDisabled = await cycle(SHORT_DISABLED);
  await check("direction:short disabled: the short is not saved Active and not queued to Telegram", () => {
    assert.equal(active(shortDisabled, "ETH-USD").length, 0);
    assert.equal(queued(shortDisabled, "ETH-USD").length, 0);
  });
  await check("direction:short disabled: the long still publishes and queues unchanged", () => {
    assert.deepEqual(snapshot(shortDisabled, "BTC-USD"), snapshot(baseline, "BTC-USD"));
  });
  await check("direction:short disabled: recorded as an admin_disabled rejection naming the group", () => {
    assert.equal(shortDisabled.rejections.length, 1);
    const [rejection] = shortDisabled.rejections;
    assert.deepEqual([rejection.symbol, rejection.direction, rejection.source], ["ETH-USD", "short", "auto_crypto_watcher"]);
    assert.equal(rejection.reasons[0].stage, "admin_disabled");
    assert.equal(rejection.reasons[0].reason, "Direction short disabled by admin");
    const candidate = shortDisabled.candidates.find((item) => item.symbol === "ETH-USD");
    assert.equal(candidate.status, "rejected");
    assert.equal(candidate.rejection_reason, "Direction short disabled by admin");
  });

  // ---------- direction:short disabled: manual scan ----------
  nextWindow();
  resetWatcher(SHORT_DISABLED);
  const manualShort = await scanMarketSetupDetailed(USER, { symbol: "ETH-USD", timeframe: "15m" });
  const manualLong = await scanMarketSetupDetailed(USER, { symbol: "BTC-USD", timeframe: "15m" });
  await check("manual scan: the disabled short is not publishable, the long is", () => {
    assert.equal(manualShort.publicResult.valid, false);
    assert.equal(manualShort.fullSetup, null);
    assert.deepEqual(manualShort.analysis.rejectionReasonCodes, ["admin_disabled"]);
    assert.deepEqual(manualShort.analysis.rejectionReasons, ["Direction short disabled by admin"]);
    assert.equal(manualLong.publicResult.valid, true);
    assert.equal(manualLong.fullSetup.direction, "long");
    assert.equal(db.getValidationRejections()[0].source, "manual_scan");
  });

  // ---------- strategy groups ----------
  const strategy = active(baseline, "BTC-USD")[0].strategy;
  const otherStrategy = await cycle([{ group_key: "strategy:Momentum breakout", status: "disabled_by_admin" }]);
  await check("strategy:Momentum breakout disabled: signals of other strategies are untouched", () => {
    assert.notEqual(strategy, "Momentum breakout");
    assert.deepEqual(snapshot(otherStrategy), snapshot(baseline));
  });
  const ownStrategy = await cycle([{ group_key: `strategy:${strategy}`, status: "disabled_by_admin" }]);
  await check(`strategy:${strategy} disabled (raw key with spaces): both its signals are blocked`, () => {
    assert.equal(ownStrategy.generatedRows.filter((row) => row.status === "Active").length, 0);
    assert.equal(ownStrategy.queueRows.length, 0);
    assert.deepEqual(ownStrategy.rejections.map((item) => item.reasons[0].reason), [
      `Strategy ${strategy} disabled by admin`,
      `Strategy ${strategy} disabled by admin`
    ]);
  });
  nextWindow();
  db.setAdminOverrideRows([{ group_key: "strategy:momentum-breakout", status: "disabled_by_admin" }]);
  await check("group matcher: only the disabled strategy matches", async () => {
    const signal = { symbol: "ETH-USD", timeframe: "15m", direction: "short", generationSource: "manual_scan", confidenceScore: 85 };
    assert.equal((await findAdminDisabledGroup({ ...signal, setupType: "Momentum breakout" }))?.groupKey, "strategy:momentum-breakout");
    assert.equal(await findAdminDisabledGroup({ ...signal, setupType: "Mean reversion" }), null);
  });

  // ---------- keys as the production calibration tab saves them (slugs) ----------
  nextWindow();
  db.setAdminOverrideRows([
    "strategy:momentum-breakout",
    "strategy:breakout-retest",
    "strategy:liquidity-sweep-reversal",
    "pair:ltc-usd",
    "market_regime:range"
  ].map((group_key) => ({ group_key, status: "disabled_by_admin" })));
  await check("slug rows block the strategies they name and pair:ltc-usd matches LTC-USD", async () => {
    const signal = { symbol: "ETH-USD", timeframe: "15m", direction: "long", generationSource: "auto_crypto_watcher", confidenceScore: 85 };
    for (const [setupType, groupKey] of [
      ["Momentum breakout", "strategy:momentum-breakout"],
      ["Breakout retest", "strategy:breakout-retest"],
      ["Liquidity sweep reversal", "strategy:liquidity-sweep-reversal"]
    ]) {
      const group = await findAdminDisabledGroup({ ...signal, setupType });
      assert.equal(group?.groupKey, groupKey);
      assert.equal(group.reason, `Strategy ${setupType} disabled by admin`);
    }
    const ltc = await findAdminDisabledGroup({ ...signal, symbol: "LTC-USD", setupType: "Mean reversion" });
    assert.equal(ltc?.groupKey, "pair:ltc-usd");
    assert.equal(ltc.reason, "Pair LTC-USD disabled by admin");
    // market_regime is a calibration-tab group but not one of a signal's group keys, so it never matches.
    assert.equal(await findAdminDisabledGroup({ ...signal, setupType: "Mean reversion" }), null);
  });
  nextWindow();
  resetWatcher([{ group_key: "pair:ltc-usd", status: "disabled_by_admin" }]);
  fixtures.set("LTC-USD", LONG_FIXTURE);
  const ltcScan = await scanMarketSetupDetailed(USER, { symbol: "LTC-USD", timeframe: "15m" });
  const btcScan = await scanMarketSetupDetailed(USER, { symbol: "BTC-USD", timeframe: "15m" });
  fixtures.delete("LTC-USD");
  await check("pair:ltc-usd disabled: a real LTC-USD scan is blocked, BTC-USD still publishes", () => {
    assert.equal(ltcScan.publicResult.valid, false);
    assert.equal(ltcScan.fullSetup, null);
    assert.deepEqual(ltcScan.analysis.rejectionReasons, ["Pair LTC-USD disabled by admin"]);
    assert.equal(btcScan.publicResult.valid, true);
  });

  // ---------- an auto-computed quarantine is advisory only ----------
  nextWindow();
  resetWatcher([]);
  db.setGroupStats("direction", "short", {
    total_signals: 40, active: 0, hit_tp: 5, hit_sl: 30, expired: 5, average_rr: 2,
    average_confidence: 85, average_realized_r: -0.6, last_7_days: 40, last_30_days: 40
  });
  await runAutoCryptoAlertScan();
  const quarantined = db.getAutoCryptoWatcherState();
  await check("auto-computed quarantined direction:short with no admin row: the short still publishes", () => {
    const short = active(quarantined, "ETH-USD")[0];
    assert.ok(short, "the short must still publish");
    const directionGroup = (short.confidence_calibration?.groups || []).find((group) => group.groupKey === "direction:short");
    assert.equal(directionGroup?.status, "quarantined", "the fixture must really produce an auto-computed quarantine");
    assert.equal(queued(quarantined, "ETH-USD").length, 1);
    assert.deepEqual(db.getValidationRejections(), []);
  });
  db.clearGroupStats();

  // ---------- unlock re-validation ----------
  // Discover the short while nothing is disabled (Telegram queue + cached manual scan), then disable shorts.
  nextWindow();
  resetWatcher([]);
  await runAutoCryptoAlertScan();
  const telegramSetupKey = queued(db.getAutoCryptoWatcherState(), "ETH-USD")[0].setup_key;
  const discovered = await scanMarketSetupDetailed(USER, { symbol: "ETH-USD", timeframe: "15m" });
  assert.equal(discovered.publicResult.valid, true);
  db.setCachedScanResult(USER.id, "single:ETH-USD:15m", discovered);
  const scannerSetupKey = discovered.fullSetup.setupKey;
  const unlockSingle = () => createSignal({ ...USER }, { symbol: "ETH-USD", timeframe: "15m" });
  const unlockScanner = () => createSignal({ ...USER }, { symbol: "ETH-USD", timeframe: "15m", setupKey: scannerSetupKey });
  const unlockTelegram = () => unlockTelegramSignal({ ...USER }, { setupKey: telegramSetupKey });

  nextWindow();
  db.clearValidationRejections();
  db.setAdminOverrideRows(SHORT_DISABLED);
  await check("unlock (cached single scan) re-checks and refuses the now-disabled short", async () => {
    const result = await unlockSingle();
    assert.equal(result.signal, null);
    assert.deepEqual(result.analysis.rejectionReasonCodes, ["admin_disabled"]);
  });
  await check("unlock (scanner setupKey) re-checks and refuses the now-disabled short", async () => {
    await assert.rejects(unlockScanner(), (error) => error.code === "SCAN_SETUP_NOT_READY");
  });
  await check("unlock (Telegram link) re-checks and refuses the now-disabled short", async () => {
    const result = await unlockTelegram();
    assert.equal(result.signal, null);
    assert.deepEqual(result.analysis.rejectionReasonCodes, ["admin_disabled"]);
  });
  await check("each refused unlock is recorded as an admin_disabled rejection", () => {
    assert.deepEqual(db.getValidationRejections().map((item) => [item.source, item.reasons[0].stage]), [
      ["unlock", "admin_disabled"],
      ["scan_unlock", "admin_disabled"],
      ["telegram_unlock", "admin_disabled"]
    ]);
  });

  // ---------- override set back to active: publishes again within one cache window ----------
  db.setAdminOverrideRows([{ ...SHORT_DISABLED[0], status: "active" }]);
  currentNowMs += 5 * 1000;
  await check("inside the same cache window the earlier disabled row still applies", async () => {
    assert.equal((await unlockSingle()).signal, null);
  });
  nextWindow();
  await check("override set back to active: all three unlock paths reach the save within one cache window", async () => {
    await assert.rejects(unlockSingle(), isUnlockSave);
    await assert.rejects(unlockScanner(), isUnlockSave);
    await assert.rejects(unlockTelegram(), isUnlockSave);
  });
  const reenabled = await cycle([{ ...SHORT_DISABLED[0], status: "active" }]);
  await check("override set back to active: the scan publishes and queues the short again", () => {
    assert.deepEqual(snapshot(reenabled), snapshot(baseline));
  });

  // ---------- saving a status in the calibration tab applies at once on this instance ----------
  db.setAdminOverrideRows([]);
  assert.equal(await findAdminDisabledGroup(discovered.fullSetup), null);
  db.setAdminOverrideRows(SHORT_DISABLED);
  await updateSignalGroupStatus({ groupKey: "direction:short", status: "disabled_by_admin" });
  await check("updateSignalGroupStatus clears the override cache", async () => {
    assert.equal((await findAdminDisabledGroup(discovered.fullSetup))?.groupKey, "direction:short");
  });

  // ---------- signals already Active are left alone ----------
  nextWindow();
  resetWatcher([]);
  await runAutoCryptoAlertScan();
  const before = active(db.getAutoCryptoWatcherState(), "ETH-USD")[0];
  nextWindow();
  db.setAdminOverrideRows(SHORT_DISABLED);
  await runAutoCryptoAlertScan();
  await check("a short already Active before the disable stays Active and unchanged", () => {
    const after = db.getAutoCryptoWatcherState().generatedRows.find((row) => row.id === before.id);
    assert.deepEqual(after, before);
  });

  realLog(`Admin-disabled group block tests passed (${passed.length} checks):\n${passed.map((name) => `  ok ${name}`).join("\n")}`);
} finally {
  globalThis.Date = RealDate;
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.warn = realWarn;
}

// What a cycle published: Active generated rows and Telegram queue payloads, without generated ids or timestamps.
function snapshot(state, pair = null) {
  const keep = (pairOf) => !pair || pairOf === pair;
  return {
    active: state.generatedRows.filter((row) => row.status === "Active" && keep(row.pair))
      .map((row) => [row.pair, row.direction, row.strategy, row.setup_key, Number(row.confidence), Number(row.entry), Number(row.stop_loss), Number(row.take_profit)]),
    queued: state.queueRows.filter((row) => keep(row.payload.symbol))
      .map((row) => [row.payload.symbol, row.payload.direction, row.setup_key, Number(row.payload.confidenceScore)])
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
    candles.push({
      time,
      open,
      high: Math.max(open, close) + fixture.padding,
      low: Math.min(open, close) - fixture.padding,
      close,
      volume: isLastCompleted ? fixture.lastVolume : 1000 + (Math.abs(index) % 7) * 15
    });
  }
  return candles;
}
