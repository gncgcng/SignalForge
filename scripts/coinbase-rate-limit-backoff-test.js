// A Coinbase 429 pauses every Coinbase request and is retried once, and a rate-limited pair waits out that short
// backoff instead of the 6h cooldown. No database: the cooldown writes fail and are ignored, as in
// crypto-market-operations-test. Run with DATABASE_URL unset.
import assert from "node:assert/strict";
import { appConfig } from "../src/config/appConfig.js";
import {
  getCoinbaseRequestState,
  getHistoricalCandlesFromCoinbase
} from "../src/modules/market-data/coinbaseMarketDataProvider.js";
import { getCryptoMarketState, recordCryptoMarketFailure } from "../src/modules/markets/cryptoMarketService.js";

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
  globalThis.fetch = async () => {
    calls.push(Date.now());
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

  // 4. A rate-limited pair cools down for the backoff only; a real failure still gets the 6h cooldown.
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
