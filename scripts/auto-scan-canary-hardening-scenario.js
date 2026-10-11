// One auto-scan scheduler scenario, configured by the environment of the process (appConfig is read at import).
// Starts the real scheduler with timers captured, runs the first scheduled cycle against the mocked DB and candle
// fixtures, and prints what happened as JSON. Driven by auto-scan-canary-hardening-test.js.
process.env.CRYPTO_WATCHER_ENABLED = "true";
process.env.AUTO_SCAN_ENABLED = "true";
process.env.MARKET_VERIFICATION_ENABLED = "false";
process.env.TELEGRAM_BOT_TOKEN = "fixture-bot-token";

const START_MS = Date.UTC(2026, 1, 3, 8, 30, 0);
let currentNowMs = START_MS;
const RealDate = globalThis.Date;
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realLog = console.log;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [currentNowMs])); }
  static now() { return currentNowMs; }
}
const LONG_FIXTURE = { slope: 0.03, amplitude: 0.8, phase: 1.4, padding: 0.144, lastMove: 0.096, lastVolume: 1800 };
const SHORT_FIXTURE = { ...LONG_FIXTURE, slope: -0.03, phase: 1.4 + Math.PI, lastMove: -0.096 };
const fixtures = new Map([["BTC-USD", LONG_FIXTURE], ["ETH-USD", SHORT_FIXTURE]]);
const errors = [];
const warnings = [];
const logs = [];
const timeouts = [];
const intervals = [];

globalThis.Date = FixedDate;
globalThis.fetch = deterministicFetch;
console.log = (...args) => logs.push(args.join(" "));
console.info = () => {};
console.warn = (...args) => warnings.push(args.join(" "));
console.error = (...args) => errors.push(args.join(" "));

const db = await import("./test-support/admin-disabled-db-transport.mock.js");
const scanner = await import("../src/modules/alerts/autoScanService.js");
db.resetAutoCryptoWatcherTransport();
db.configureWatcherUser({ userId: "user-a", minimumConfidence: 0, symbols: ["BTC-USD", "ETH-USD"] });

globalThis.setTimeout = (callback, delay) => { timeouts.push({ callback, delay }); return timeouts.length; };
globalThis.setInterval = (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; };
scanner.startAutoCryptoAlertScanner();
globalThis.setTimeout = realSetTimeout;
globalThis.setInterval = realSetInterval;

const result = {
  timeouts: timeouts.map((item) => item.delay),
  intervals: intervals.map((item) => item.delay),
  startedLine: logs.find((line) => line.startsWith("[auto-scan] started")) || null
};
const heartbeat = [];
if (process.argv[2] === "heartbeat") {
  // No cycle runs: the heartbeat must stay quiet for 30 minutes, then warn once per 30 minutes.
  for (const minutes of [29, 31, 45, 62]) {
    const before = warnings.length;
    scanner.checkAutoScanHeartbeat(START_MS + minutes * 60000);
    heartbeat.push({ minutes, warned: warnings.length > before, warning: warnings.slice(before).join(" ") });
  }
  result.healthAt31 = scanner.getAutoScanHealth(START_MS + 31 * 60000);
} else if (timeouts.length) {
  await timeouts[0].callback();
  await new Promise((resolve) => realSetTimeout(resolve, 0));
  for (let attempt = 0; attempt < 400 && !scanner.getAutoScanHealth().lastCompletedCycleAt; attempt += 1) {
    await new Promise((resolve) => realSetTimeout(resolve, 25));
  }
  const state = db.getAutoCryptoWatcherState();
  result.generatedPairs = [...new Set(state.generatedRows.filter((row) => row.status === "Active").map((row) => row.pair))].sort();
  // A cycle completed 10 minutes ago is fresh; the heartbeat stays quiet.
  const completedAt = Date.parse(scanner.getAutoScanHealth().lastCompletedCycleAt);
  const before = warnings.length;
  scanner.checkAutoScanHeartbeat(completedAt + 10 * 60000);
  result.heartbeatAfterCycle = { warned: warnings.length > before };
}
result.health = scanner.getAutoScanHealth();
result.errors = errors;
result.heartbeat = heartbeat;
realLog(JSON.stringify(result));
process.exit(0);

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
