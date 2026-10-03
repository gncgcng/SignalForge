import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
// Twelve Data daily request budget (TWELVEDATA_REQUESTS_PER_DAY), through the real adapter over HTTP
// to the local Twelve Data stand-in, the real outcome tracker, the real Scan All job and a real local
// Postgres:
// 1. Requests stop at the daily budget and fail fast as DAILY_LIMIT_REACHED, without network calls.
// 2. The session-bound outcome tracker skips instead of fetching, and never decides (or expires)
//    a signal because the budget ran out, also when it runs out mid-cycle.
// 3. Scan coverage says "daily provider limit reached", not a generic provider failure.
// 4. The counter resets at the UTC day boundary and starts from the provider's own count at boot.
import assert from "node:assert/strict";
import { generateSeries, startTwelveDataStandIn } from "./test-support/twelve-data-stand-in.js";

const H = 3_600_000;
const wednesday = Date.parse("2026-01-14T15:00:00Z"); // commodities in session; the suite's pinned "now"
// Candles end at the pinned "now", so fetched windows are genuinely covered.
const standIn = await startTwelveDataStandIn({ series: (_symbol, interval) => generateSeries({ interval, endMs: wednesday }) });
process.env.TWELVEDATA_API_BASE_URL = standIn.baseUrl;
process.env.TWELVEDATA_API_KEY = "daily-limit-test-key";
process.env.TWELVEDATA_REQUESTS_PER_MINUTE = "1000";
process.env.TWELVEDATA_REQUESTS_PER_DAY = "6";
process.env.TWELVEDATA_MANUAL_SCAN_ENABLED = "true";
process.env.EMAIL_FEATURES_ENABLED = "false";

const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => String(url).startsWith(standIn.baseUrl)
  ? realFetch(url, options)
  : Promise.reject(new Error("network disabled in test"));

const { appConfig } = await import("../src/config/appConfig.js");
const { query, getPool } = await import("../src/db/client.js");
const { createUser, findUserById } = await import("../src/db/repositories.js");
const { startScanAllJob, getScanAllJobStatus } = await import("../src/modules/signals/signalService.js");
const { trackSessionBoundSignalOutcomes } = await import("../src/modules/signals/signalOutcomeService.js");
const { getOhlcv } = await import("../src/modules/market-data/marketDataService.js");
const provider = await import("../src/modules/market-data/twelveDataMarketDataProvider.js");
const { setSessionClockForTest } = await import("../src/modules/markets/sessionService.js");
const { hashPassword } = await import("../src/modules/auth/authService.js");
const { createId } = await import("../src/shared/ids.js");
const { correlationSymbols } = await import("../src/modules/market-data/correlationService.js");

const LIMIT = appConfig.twelveData.requestsPerDay;
const commodities = ["XAU/USD", "XAG/USD", "WTI", "BRENT", "NATGAS"];
const testStart = new Date();
const email = `daily-limit-${Date.now().toString(36)}@example.test`;
const userId = createId("usr");
const cryptoPeers = correlationSymbols.filter((symbol) => symbol.endsWith("-USD"));
const peerSnapshot = (await query("SELECT * FROM markets WHERE symbol = ANY($1)", [cryptoPeers])).rows;
const timeSeriesRequests = () => standIn.requests.filter((request) => request.path === "/time_series").length;
const results = {};

const fakeSignal = (id, { ageMs, timeframe = "1h" }) => ({
  id, symbol: "XAU/USD", timeframe, direction: "long", entryPrice: 2400, stopLoss: 2380, takeProfit: 2440,
  status: "Active", generatedAt: new Date(wednesday - ageMs).toISOString(),
  validUntil: new Date(wednesday - H).toISOString() // window already over: due for its final check
});

try {
  setSessionClockForTest(wednesday);
  await createUser({ id: userId, name: "Daily Limit Test", email, password: hashPassword("daily-limit-pass"), emailVerifiedAt: new Date() });
  await query("UPDATE users SET role = 'tester' WHERE id = $1", [userId]);
  const user = await findUserById(userId);

  // ---------------------------------------------------------------- 1. the counter
  {
    provider.resetTwelveDataStateForTest();
    standIn.resetRequests();
    const combos = [["XAU/USD", "5m"], ["XAU/USD", "15m"], ["XAU/USD", "1h"], ["XAG/USD", "5m"], ["XAG/USD", "15m"], ["XAG/USD", "1h"]];
    const fetched = [];
    for (const [symbol, timeframe] of combos) fetched.push(await getOhlcv(symbol, timeframe).then(() => "ok", (error) => error.code));
    const blocked = await getOhlcv("WTI", "1h").catch((error) => error);
    const state = provider.getTwelveDataThrottleState();
    results.counter = {
      budgetIsSpentByRealRequests: fetched.every((outcome) => outcome === "ok") && state.usedToday === LIMIT,
      nextRequestFailsAsDailyLimit: blocked?.code === "DAILY_LIMIT_REACHED" && /resets 00:00 UTC/.test(blocked.message),
      blockedRequestNeverSent: timeSeriesRequests() === LIMIT,
      providerReportsExhausted: provider.twelveDataMarketDataProvider.isDailyLimitReached() === true
    };
  }

  // ---------------------------------------------------------------- 2. outcome tracker
  {
    const marked = [];
    const deps = (signals) => ({
      now: () => wednesday,
      finalCheckGraceMs: 0, // a fetch failure past the window would expire as "unverified" at once
      listActiveSignals: async () => signals,
      listActiveGeneratedSignals: async () => [],
      markSavedSignal: async (signal, status) => { marked.push({ id: signal.id, status }); }
    });

    standIn.resetRequests();
    const exhausted = await trackSessionBoundSignalOutcomes(deps([fakeSignal("sig-exhausted", { ageMs: 3 * H })]));

    // One request left; two signals on the market needing different candle granularity (5m, 1h).
    provider.resetTwelveDataStateForTest();
    provider.setTwelveDataDailyUsageForTest({ used: LIMIT - 1 });
    standIn.resetRequests();
    const midCycle = await trackSessionBoundSignalOutcomes(deps([
      fakeSignal("sig-fresh", { ageMs: 3 * H }),
      fakeSignal("sig-older", { ageMs: 30 * H })
    ]));

    results.tracker = {
      skipsWhenExhausted: exhausted.skippedDailyLimit === 1 && exhausted.requests === 0 && exhausted.pending === 1,
      noRequestWhenExhausted: timeSeriesRequests() === 1, // only the mid-cycle run's single allowed request
      neverDecidesBecauseOfTheLimit: !marked.some((item) => item.id === "sig-exhausted" || item.id === "sig-older"),
      midCycleExhaustionLeavesRestPending: midCycle.requests === 1 && midCycle.skippedDailyLimit === 1 &&
        midCycle.expiredUnverified === 0 && marked.some((item) => item.id === "sig-fresh")
    };
  }

  // ---------------------------------------------------------------- 3. scan coverage
  {
    provider.resetTwelveDataStateForTest();
    provider.setTwelveDataDailyUsageForTest({ used: LIMIT });
    standIn.resetRequests();
    const started = await startScanAllJob(user, { marketType: "commodities" });
    let job;
    for (const deadline = Date.now() + 60_000; ;) {
      job = getScanAllJobStatus(user, started.jobId);
      if (["completed", "failed", "cancelled"].includes(job.status)) break;
      if (Date.now() > deadline) throw new Error(`scan job did not finish: ${job.status}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    results.scan = {
      coverageNamesTheDailyLimit: job.coverage?.summary === "5 of 5 commodities couldn't be checked (daily provider limit reached)." || job.coverage?.summary,
      messageIsNotGeneric: job.message.startsWith("Scan incomplete: 5 of 5 commodities couldn't be checked (daily provider limit reached).") || job.message,
      everyFailureClassified: job.scanned.length > 0 && job.scanned.every((item) => item.providerError && item.rejectionReasonCodes[0] === "provider_daily_limit"),
      noProviderRequests: timeSeriesRequests() === 0
    };
  }

  // ---------------------------------------------------------------- 4. day boundary and boot seeding
  {
    provider.resetTwelveDataStateForTest();
    provider.setTwelveDataDailyUsageForTest({ day: "2026-01-13", used: LIMIT }); // yesterday, spent
    const afterRollover = await getOhlcv("XAU/USD", "4h").then(() => "ok", (error) => error.code);
    const usedAfterRollover = provider.getTwelveDataThrottleState().usedToday;

    provider.resetTwelveDataStateForTest();
    const configuredDaily = appConfig.twelveData.requestsPerDay;
    appConfig.twelveData.requestsPerDay = 800;
    standIn.configure({ dailyUsage: 42, planDailyLimit: 500 });
    const health = await provider.verifyTwelveDataCredentials();
    const seeded = provider.getTwelveDataThrottleState();
    appConfig.twelveData.requestsPerDay = configuredDaily;

    results.dayBoundary = {
      resetsAtUtcMidnight: afterRollover === "ok" && usedAfterRollover === 1,
      bootStartsFromProviderCount: health.status === "ok" && seeded.usedToday === 42,
      planDailyLimitApplied: seeded.requestsPerDay === 500
    };
  }
} finally {
  setSessionClockForTest(null);
  globalThis.fetch = realFetch;
  for (const row of peerSnapshot) {
    await query(`UPDATE markets SET status=$2, market_status=$3, verification_status=$4, provider_status=$5,
      last_checked_at=$6, last_error=$7, failure_code=$8, cooldown_until=$9, consecutive_failures=$10,
      verification_details=$11, last_successful_candle_at=$12, supported_timeframes=$13, unsupported_timeframes=$14,
      last_verified_at=$15, updated_at=$16 WHERE symbol=$1`, [row.symbol, row.status, row.market_status,
      row.verification_status, row.provider_status, row.last_checked_at, row.last_error, row.failure_code,
      row.cooldown_until, row.consecutive_failures, row.verification_details, row.last_successful_candle_at,
      row.supported_timeframes, row.unsupported_timeframes, row.last_verified_at, row.updated_at]);
  }
  await query("DELETE FROM setup_candidates WHERE symbol = ANY($1) AND created_at >= $2", [commodities, testStart]);
  await query("DELETE FROM avoid_trade_learning_events WHERE market = ANY($1) AND created_at >= $2", [commodities, testStart]);
  await query("DELETE FROM users WHERE email = $1", [email]);
  await standIn.close();
  await getPool().end();
}

console.log(JSON.stringify(results, null, 2));
for (const [group, checks] of Object.entries(results)) {
  for (const [name, value] of Object.entries(checks)) {
    assert.equal(value, true, `${group}.${name} failed: ${JSON.stringify(value)}`);
  }
}
console.log("twelve data daily limit checks passed");
