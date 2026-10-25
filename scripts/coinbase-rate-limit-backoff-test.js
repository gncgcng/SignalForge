// A Coinbase 429 pauses every Coinbase request and is retried once, and a rate-limited pair waits out that short
// backoff instead of the 6h cooldown. No database: the cooldown writes fail and are ignored, as in
// crypto-market-operations-test. Run with DATABASE_URL unset.
import assert from "node:assert/strict";
import { appConfig } from "../src/config/appConfig.js";
import {
  getCoinbaseRequestState,
  getHistoricalCandlesFromCoinbase
} from "../src/modules/market-data/coinbaseMarketDataProvider.js";
import { withRetries, withTimeout } from "../src/modules/markets/cryptoMarketMonitor.js";
import {
  getCryptoMarketState,
  isRateLimitOnlyFailure,
  recordCryptoMarketFailure
} from "../src/modules/markets/cryptoMarketService.js";

appConfig.cryptoMarkets.rateLimitBackoffMs = 300;
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const warnings = [];
console.warn = (line) => warnings.push(String(line));

const hourMs = 3600 * 1000;
const to = Math.floor(Date.now() / hourMs) * hourMs - hourMs;
const window = { from: new Date(to - 59 * hourMs).toISOString(), to: new Date(to).toISOString() };
const rows = Array.from({ length: 60 }, (_, index) => {
  const time = (to - index * hourMs) / 1000;
  return [time, 99, 101, 100, 100.5, 10];
});
const ok = () => new Response(JSON.stringify(rows), { status: 200 });
const tooMany = (headers = {}) => new Response("[]", { status: 429, headers });

// Sequence of responses; records when each fetch actually went out.
function scriptFetch(responses) {
  const calls = [];
  globalThis.fetch = async (_url, options = {}) => {
    calls.push(Date.now());
    if (options.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra Coinbase request");
    return next();
  };
  return calls;
}

async function waitForPauseToEnd() {
  while (getCoinbaseRequestState().rateLimitedUntil) await new Promise((resolve) => setTimeout(resolve, 20));
}

try {
  // 1. One 429 without Retry-After: paused for rateLimitBackoffMs, retried once, and the data comes back.
  let calls = scriptFetch([() => tooMany(), ok]);
  const result = await getHistoricalCandlesFromCoinbase("BTC-USD", "1h", window);
  assert.equal(calls.length, 2, "the 429 is retried once");
  assert.ok(calls[1] - calls[0] >= 280, `the retry waits out the backoff (${calls[1] - calls[0]}ms)`);
  assert.ok(result.candles.length > 0, "the retried request returns candles");
  assert.equal(warnings.filter((line) => line.startsWith("[coinbase] rate_limited pause_ms=300")).length, 1);
  await waitForPauseToEnd();

  // 2. Retry-After wins, and the pause holds back every Coinbase request, not only the one that hit the 429.
  calls = scriptFetch([() => tooMany({ "retry-after": "1" }), ok, ok]);
  const first = getHistoricalCandlesFromCoinbase("BTC-USD", "1h", window);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(getCoinbaseRequestState().rateLimitedUntil, "the pause is visible in the request state");
  const second = getHistoricalCandlesFromCoinbase("ETH-USD", "1h", window);
  await Promise.all([first, second]);
  assert.equal(calls.length, 3);
  assert.ok(calls[1] - calls[0] >= 950 && calls[2] - calls[0] >= 950,
    `no request goes out during the Retry-After pause (${calls.slice(1).map((at) => at - calls[0]).join(", ")}ms)`);
  await waitForPauseToEnd();

  // 3. Retried once only: a second 429 is reported as RATE_LIMITED.
  calls = scriptFetch([() => tooMany(), () => tooMany()]);
  await assert.rejects(() => getHistoricalCandlesFromCoinbase("BTC-USD", "1h", window), { code: "RATE_LIMITED" });
  assert.equal(calls.length, 2);
  await waitForPauseToEnd();

  // 4. A request waiting out the pause holds no slot, and its timeout starts only once it has one: with a 400ms
  // request timeout and a 1s pause, it still succeeds.
  const requestTimeoutMs = appConfig.marketData.requestTimeoutMs;
  appConfig.marketData.requestTimeoutMs = 400;
  try {
    calls = scriptFetch([() => tooMany({ "retry-after": "1" }), ok, ok]);
    const hit = getHistoricalCandlesFromCoinbase("BTC-USD", "1h", window);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiting = getHistoricalCandlesFromCoinbase("ETH-USD", "1h", window);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(getCoinbaseRequestState().active, 0, "no slot is held during the pause");
    const [hitResult, waitingResult] = await Promise.all([hit, waiting]);
    assert.ok(hitResult.candles.length > 0 && waitingResult.candles.length > 0, "the timeout did not run during the pause");
  } finally {
    appConfig.marketData.requestTimeoutMs = requestTimeoutMs;
  }
  await waitForPauseToEnd();

  // 5. Verification: a timeout that ran into the pause is RATE_LIMITED (short cooldown), other timeouts keep their
  // code, and a rate limit is not retried.
  const never = new Promise(() => {});
  await assert.rejects(() => withTimeout(never, 50, "MARKET_DATA_TIMEOUT"), { code: "MARKET_DATA_TIMEOUT" });
  scriptFetch([() => tooMany({ "retry-after": "1" })]);
  const paused = getHistoricalCandlesFromCoinbase("BTC-USD", "1h", window).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(() => withTimeout(never, 100, "MARKET_DATA_TIMEOUT"), { code: "RATE_LIMITED" });
  scriptFetch([ok]);
  await paused;
  await waitForPauseToEnd();
  let attempts = 0;
  await assert.rejects(() => withRetries(async () => { attempts += 1; throw Object.assign(new Error("429"), { code: "RATE_LIMITED" }); }, 2),
    { code: "RATE_LIMITED" });
  assert.equal(attempts, 1, "a rate limit is not retried");
  attempts = 0;
  await assert.rejects(() => withRetries(async () => { attempts += 1; throw Object.assign(new Error("502"), { code: "PROVIDER_RESPONSE_ERROR" }); }, 1));
  assert.equal(attempts, 2, "other failures still retry");

  // 6. Verification and rebuild cool a pair down for the backoff only when every failed check was a rate limit.
  assert.equal(isRateLimitOnlyFailure([{ available: true }, { available: false, code: "RATE_LIMITED" }]), true);
  assert.equal(isRateLimitOnlyFailure([{ available: false, code: "EMPTY_CANDLES" }, { available: false, code: "RATE_LIMITED" }]), false);
  assert.equal(isRateLimitOnlyFailure([{ available: true }]), false);

  // 7. A rate-limited pair cools down for the backoff only; a real failure still gets the 6h cooldown.
  const before = Date.now();
  await recordCryptoMarketFailure("ETH-USD", "4h", { code: "RATE_LIMITED", message: "Rate limited" });
  const rateLimitedCooldown = new Date(getCryptoMarketState("ETH-USD").cooldownUntil).getTime() - before;
  assert.ok(rateLimitedCooldown <= 300 + 1000, `rate-limit cooldown is the backoff (${rateLimitedCooldown}ms)`);
  await recordCryptoMarketFailure("SOL-USD", "4h", { code: "EMPTY_CANDLES", message: "No candle data from provider" });
  const failureCooldown = new Date(getCryptoMarketState("SOL-USD").cooldownUntil).getTime() - before;
  assert.ok(failureCooldown >= appConfig.cryptoMarkets.unavailableCooldownMs - 1000, "a real failure keeps the 6h cooldown");
} finally {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
}

console.log("coinbase rate-limit backoff: passed");
process.exit(0);
