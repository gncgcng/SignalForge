// Keeps backtests from crowding out the scanner on Coinbase's public API.
// - Candles a backtest loads are cached for a few minutes per symbol and timeframe, so re-running a test, switching
//   presets or several users testing the same pair do not refetch.
// - Backtest loads that miss the cache run one at a time across all users, with a short gap between them. The Coinbase
//   provider allows 4 requests in flight; backtests use at most 1 of them, so scanner requests are never queued
//   behind a large backtest, and backtests add at most a few requests a second.
// - One running backtest per user and a few in total; anything more gets "busy, try again in a minute".
// - At most maxMarketsPerRun markets in one run.
export const backtestLimits = {
  cacheTtlMs: 5 * 60 * 1000,
  cacheMaxEntries: 600,
  loadSpacingMs: 400,
  maxRunsGlobal: 2,
  maxMarketsPerRun: 10
};

export const BACKTEST_BUSY_MESSAGE = "Backtesting is busy right now. Please try again in a minute.";

const cache = new Map();
const runningUsers = new Set();
let runningTotal = 0;
let loadChain = Promise.resolve();
let lastLoadAt = 0;
let clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

export function backtestBusyError() {
  const error = new Error(BACKTEST_BUSY_MESSAGE);
  error.statusCode = 429;
  error.code = "BACKTEST_BUSY";
  return error;
}

export function assertBacktestRunSize(symbols) {
  if (symbols.length > backtestLimits.maxMarketsPerRun) {
    const error = new Error(`Choose up to ${backtestLimits.maxMarketsPerRun} markets per backtest.`);
    error.statusCode = 400;
    error.code = "BACKTEST_TOO_MANY_MARKETS";
    throw error;
  }
}

export async function withBacktestRun(userId, run) {
  const key = String(userId || "anonymous");
  if (runningUsers.has(key) || runningTotal >= backtestLimits.maxRunsGlobal) throw backtestBusyError();
  runningUsers.add(key);
  runningTotal += 1;
  try {
    return await run();
  } finally {
    runningUsers.delete(key);
    runningTotal -= 1;
  }
}

// Cached, serialized load. A failed load is not cached.
export function loadBacktestCandles(symbol, timeframe, loader) {
  const key = `${symbol}:${timeframe}`;
  const cached = cache.get(key);
  if (cached && clock.now() - cached.at < backtestLimits.cacheTtlMs) return cached.promise;
  const promise = (loadChain = loadChain.catch(() => {}).then(async () => {
    const wait = lastLoadAt + backtestLimits.loadSpacingMs - clock.now();
    if (wait > 0) await clock.sleep(wait);
    try {
      return await loader(symbol, timeframe);
    } finally {
      lastLoadAt = clock.now();
    }
  }));
  cache.set(key, { at: clock.now(), promise });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  while (cache.size > backtestLimits.cacheMaxEntries) cache.delete(cache.keys().next().value);
  return promise;
}

// Tests only.
export function resetBacktestThrottle(overrides = {}) {
  cache.clear();
  runningUsers.clear();
  runningTotal = 0;
  loadChain = Promise.resolve();
  lastLoadAt = 0;
  clock = {
    now: overrides.now || (() => Date.now()),
    sleep: overrides.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  };
}
