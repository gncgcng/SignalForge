// Backtest throttle: candles are cached per symbol and timeframe, cache misses load one at a time with a gap, one run
// per user and a small global cap answer "busy, try again in a minute", and a run is capped at 10 markets.
// No database, no network: the loader and the clock are fakes.
import assert from "node:assert/strict";
import {
  BACKTEST_BUSY_MESSAGE,
  assertBacktestRunSize,
  backtestLimits,
  loadBacktestCandles,
  resetBacktestThrottle,
  withBacktestRun
} from "../src/modules/backtesting/backtestThrottle.js";

let now = 1_000_000;
const sleeps = [];
resetBacktestThrottle({ now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });

// 1. Cache: the same symbol and timeframe loads once within the TTL, again after it.
let calls = 0;
let inFlight = 0;
let maxInFlight = 0;
const loader = async (symbol, timeframe) => {
  calls += 1;
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((resolve) => setImmediate(resolve));
  inFlight -= 1;
  return { symbol, timeframe, candles: [calls] };
};
const first = await loadBacktestCandles("PENGU-USD", "1h", loader);
const second = await loadBacktestCandles("PENGU-USD", "1h", loader);
assert.equal(calls, 1, "second load is served from the cache");
assert.equal(second, first);
now += backtestLimits.cacheTtlMs + 1;
await loadBacktestCandles("PENGU-USD", "1h", loader);
assert.equal(calls, 2, "reloaded after the TTL");

// 2. Misses run one at a time with at least loadSpacingMs between them; parallel callers of one key share a load.
calls = 0;
sleeps.length = 0;
const keys = ["A-USD", "B-USD", "C-USD", "D-USD"];
await Promise.all([...keys, "A-USD", "B-USD"].map((symbol) => loadBacktestCandles(symbol, "15m", loader)));
assert.equal(calls, 4, "duplicate keys share one load");
assert.equal(maxInFlight, 1, "never more than one backtest load in flight");
assert.ok(sleeps.length >= 3 && sleeps.every((ms) => ms <= backtestLimits.loadSpacingMs), `spaced loads: ${sleeps}`);

// 3. A failed load is not cached.
let failures = 0;
const flaky = async () => { failures += 1; if (failures === 1) throw new Error("Coinbase 429"); return { ok: true }; };
await assert.rejects(() => loadBacktestCandles("E-USD", "4h", flaky), /429/);
assert.deepEqual(await loadBacktestCandles("E-USD", "4h", flaky), { ok: true });
assert.equal(failures, 2);

// 4. One run per user; a small global cap; both answer the friendly busy message.
resetBacktestThrottle();
let release;
const blocked = new Promise((resolve) => { release = resolve; });
const runA = withBacktestRun("user-a", () => blocked);
await assert.rejects(() => withBacktestRun("user-a", async () => "again"), (error) =>
  error.statusCode === 429 && error.code === "BACKTEST_BUSY" && error.message === BACKTEST_BUSY_MESSAGE);
const runB = withBacktestRun("user-b", () => blocked);
await assert.rejects(() => withBacktestRun("user-c", async () => "third"), { message: BACKTEST_BUSY_MESSAGE });
release("done");
assert.deepEqual(await Promise.all([runA, runB]), ["done", "done"]);
assert.equal(await withBacktestRun("user-a", async () => "free again"), "free again", "slots are released");
await assert.rejects(() => withBacktestRun("user-a", async () => { throw new Error("boom"); }), /boom/);
assert.equal(await withBacktestRun("user-a", async () => "after error"), "after error", "released after an error too");

// 5. At most 10 markets per run.
assert.equal(backtestLimits.maxMarketsPerRun, 10);
assertBacktestRunSize(Array.from({ length: 10 }, (_, index) => `M${index}-USD`));
assert.throws(() => assertBacktestRunSize(Array.from({ length: 11 }, (_, index) => `M${index}-USD`)),
  (error) => error.statusCode === 400 && /up to 10 markets/.test(error.message));

console.log(JSON.stringify({ cached: true, serialized: maxInFlight, spacing: sleeps, busy: BACKTEST_BUSY_MESSAGE }, null, 2));
