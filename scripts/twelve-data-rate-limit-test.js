import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
// Twelve Data rate-limit visibility, through the real Scan All job, the real adapter over HTTP to a
// local Twelve Data stand-in, and a real local Postgres.
// 1. The incident: a commodities Scan All fires ~20 requests at a plan allowing 8 per window. Without
//    the throttle, markets fail at the provider — and the result must now say so ("N of 5 commodities
//    couldn't be checked (provider rate limit)") instead of "No high-probability setups right now".
// 2. With the throttle at the plan limit, the same scan never exceeds the plan, checks every market
//    and reports a complete scan.
// 3. Adapter details: Twelve Data's two rate-limit styles, timezone=UTC, the boot credential check.
import assert from "node:assert/strict";
import { startTwelveDataStandIn } from "./test-support/twelve-data-stand-in.js";

const PLAN_CREDITS = 8;
const standIn = await startTwelveDataStandIn({ creditsPerMinute: PLAN_CREDITS, windowMs: 60_000 });
process.env.TWELVEDATA_API_BASE_URL = standIn.baseUrl;
process.env.TWELVEDATA_API_KEY = "rate-limit-test-key";
process.env.TWELVEDATA_MANUAL_SCAN_ENABLED = "true";
process.env.EMAIL_FEATURES_ENABLED = "false";

// Only the stand-in is reachable; anything else (Coinbase correlation peers, calendars) fails fast.
const realFetch = globalThis.fetch;
const reachable = [standIn.baseUrl];
globalThis.fetch = (url, options) => reachable.some((base) => String(url).startsWith(base))
  ? realFetch(url, options)
  : Promise.reject(new Error("network disabled in test"));

const { appConfig } = await import("../src/config/appConfig.js");
const { query, getPool } = await import("../src/db/client.js");
const { createUser, findUserById } = await import("../src/db/repositories.js");
const { startScanAllJob, getScanAllJobStatus, summarizeScanCoverage } = await import("../src/modules/signals/signalService.js");
const { getOhlcv, getPair } = await import("../src/modules/market-data/marketDataService.js");
const provider = await import("../src/modules/market-data/twelveDataMarketDataProvider.js");
const { setSessionClockForTest } = await import("../src/modules/markets/sessionService.js");
const { hashPassword } = await import("../src/modules/auth/authService.js");
const { createId } = await import("../src/shared/ids.js");
const { correlationSymbols } = await import("../src/modules/market-data/correlationService.js");

const commodities = ["XAU/USD", "XAG/USD", "WTI", "BRENT", "NATGAS"];
const testStart = new Date();
const email = `rate-limit-${Date.now().toString(36)}@example.test`;
const userId = createId("usr");
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(" ")); realWarn(...args); };
// Correlation peers fail (network disabled) and record that on their crypto rows; put them back.
const cryptoPeers = correlationSymbols.filter((symbol) => symbol.endsWith("-USD"));
const peerSnapshot = (await query("SELECT * FROM markets WHERE symbol = ANY($1)", [cryptoPeers])).rows;
const results = {};

async function runCommoditiesScan(user) {
  const started = await startScanAllJob(user, { marketType: "commodities" });
  const deadline = Date.now() + 120_000;
  for (;;) {
    const status = getScanAllJobStatus(user, started.jobId);
    if (["completed", "failed", "cancelled"].includes(status.status)) return status;
    if (Date.now() > deadline) throw new Error(`scan job did not finish: ${status.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const maxInAnyWindow = (requests, windowMs) => Math.max(0, ...requests.map((request) =>
  requests.filter((other) => other.at >= request.at && other.at - request.at < windowMs).length));

try {
  setSessionClockForTest("2026-01-14T15:00:00Z"); // a Wednesday: commodities are in session
  await createUser({ id: userId, name: "Rate Limit Test", email, password: hashPassword("rate-limit-pass"), emailVerifiedAt: new Date() });
  await query("UPDATE users SET role = 'tester' WHERE id = $1", [userId]);
  const user = await findUserById(userId);

  // ---------------------------------------------------------------- 1. the incident, unthrottled
  {
    // Pre-fix request pattern: no throttle, and (near) no back-off after the provider's 429s.
    appConfig.twelveData.requestsPerMinute = 10_000;
    appConfig.twelveData.rateWindowMs = 100;
    provider.resetTwelveDataStateForTest();
    standIn.resetRequests();
    standIn.configure({ creditsPerMinute: PLAN_CREDITS, windowMs: 60_000 });
    const job = await runCommoditiesScan(user);
    const timeSeries = standIn.requests.filter((request) => request.path === "/time_series");
    const rateLimited = timeSeries.filter((request) => request.outcome === "rate_limited");
    const coverage = job.coverage;
    const cached = (await query("SELECT count(*)::int AS n FROM scan_result_cache WHERE user_id = $1", [userId])).rows[0].n;
    results.unthrottledIncident = {
      reproducesBurst: timeSeries.length >= 15 && rateLimited.length > 0,
      jobStillCompletes: job.status === "completed",
      coverageIncomplete: coverage?.complete === false && coverage.uncheckedMarkets + coverage.partiallyCheckedMarkets > 0,
      summarySaysWhatWasMissed: new RegExp(`^\\d of 5 commodities (couldn't be checked|were only partially checked) \\(provider rate limit\\)`).test(coverage?.summary || "") || coverage?.summary,
      messageIsNotAFalseNegative: job.message !== "No high-probability setups right now" && job.message.startsWith("Scan incomplete:") || job.message,
      providerFailuresNotCountedAsRejections: job.scanSummary.rejected + job.scanSummary.providerErrors <= job.scanned.length &&
        job.scanned.filter((item) => item.providerError).length === job.scanSummary.providerErrors && job.scanSummary.providerErrors > 0,
      rateLimitClassifiedByCode: job.scanned.filter((item) => item.providerError)
        .every((item) => item.rejectionReasonCodes[0] === "provider_rate_limit"),
      incompleteScanNotCached: cached === 0,
      loggedAsIncomplete: warnings.some((line) => line.includes("[scanner] coverage complete=false") && line.includes("provider_rate_limit"))
    };
  }

  // ---------------------------------------------------------------- 2. same scan, throttled
  {
    // A short plan window keeps the test fast; the throttle and the plan share it.
    const windowMs = 2_000;
    appConfig.twelveData.requestsPerMinute = PLAN_CREDITS;
    appConfig.twelveData.rateWindowMs = windowMs;
    provider.resetTwelveDataStateForTest();
    standIn.resetRequests();
    standIn.configure({ creditsPerMinute: PLAN_CREDITS, windowMs });
    await query("DELETE FROM scan_result_cache WHERE user_id = $1", [userId]);
    const job = await runCommoditiesScan(user);
    const timeSeries = standIn.requests.filter((request) => request.path === "/time_series");
    const cached = (await query("SELECT count(*)::int AS n FROM scan_result_cache WHERE user_id = $1", [userId])).rows[0].n;
    results.throttledScan = {
      noRateLimitedRequests: timeSeries.length >= 15 && timeSeries.every((request) => request.outcome === "ok"),
      neverExceedsPlanInAnyWindow: maxInAnyWindow(standIn.requests, windowMs) <= PLAN_CREDITS,
      requestsWereQueuedNotDropped: timeSeries.at(-1).at - timeSeries[0].at >= windowMs,
      everyMarketChecked: job.coverage?.complete === true && job.coverage.checkedMarkets === 5,
      honestCleanResult: job.message === "No high-probability setups right now" || job.message === "Valid setups found.",
      completeScanCached: cached === 1,
      requestsAskForUtc: timeSeries.every((request) => request.timezone === "UTC")
    };
  }

  // ---------------------------------------------------------------- 3. adapter details
  {
    appConfig.twelveData.requestsPerMinute = 10_000;
    appConfig.twelveData.rateWindowMs = 2_000;
    provider.resetTwelveDataStateForTest();
    standIn.configure({ creditsPerMinute: 0, rateLimitStyle: "http" });
    const httpStyle = await getOhlcv("XAU/USD", "1h").catch((error) => error);
    const pausedAfter429 = provider.getTwelveDataThrottleState().pausedUntil !== null;
    provider.resetTwelveDataStateForTest();
    standIn.configure({ creditsPerMinute: 0, rateLimitStyle: "body" });
    const bodyStyle = await getOhlcv("XAG/USD", "1h").catch((error) => error);

    provider.resetTwelveDataStateForTest();
    standIn.configure({ creditsPerMinute: PLAN_CREDITS, rateLimitStyle: "body" });
    const ok = await provider.verifyTwelveDataCredentials();
    const liveBefore = getPair("XAU/USD").status;

    const rejecting = await startTwelveDataStandIn({
      fail: (_symbol, _interval, path) => path === "/api_usage"
        ? { status: 200, body: { code: 401, message: "**apikey** parameter is incorrect or not specified.", status: "error" } }
        : null
    });
    const originalBase = appConfig.twelveData.baseUrl;
    appConfig.twelveData.baseUrl = rejecting.baseUrl;
    // Unreachable first: an outage says nothing about the key, so commodities must stay in service.
    const unreachable = await provider.verifyTwelveDataCredentials();
    const liveWhileUnreachable = getPair("XAU/USD").status;
    reachable.push(rejecting.baseUrl);
    const rejected = await provider.verifyTwelveDataCredentials();
    const pairAfterRejection = getPair("XAU/USD");
    appConfig.twelveData.baseUrl = originalBase;
    await rejecting.close();
    provider.resetTwelveDataStateForTest();

    results.adapter = {
      http429IsRateLimited: httpStyle?.code === "RATE_LIMITED",
      body429IsRateLimited: bodyStyle?.code === "RATE_LIMITED",
      queuePausesAfterProvider429: pausedAfter429,
      bootCheckReadsPlanLimit: ok.status === "ok" && ok.planLimitPerMinute === PLAN_CREDITS && liveBefore === "active",
      rejectedKeyTakesCommoditiesOutOfService: rejected.status === "rejected" && pairAfterRejection.status !== "active" &&
        pairAfterRejection.availabilityCode === "PROVIDER_AUTH_FAILED",
      outageDoesNotDisableProvider: unreachable.status === "unverified" && liveWhileUnreachable === "active"
    };
  }

  // ---------------------------------------------------------------- 4. coverage wording
  {
    const markets = commodities.map((symbol) => ({ symbol, category: "Commodities" }));
    const fail = (symbol, timeframe, code) => ({ symbol, timeframe, providerError: true, rejectionReasonCodes: [code] });
    const pass = (symbol, timeframe) => ({ symbol, timeframe, valid: false, rejectionReasonCodes: ["strategy_not_matched"] });
    const scanned = [
      ...["5m", "15m", "1h", "4h"].map((tf) => fail("XAU/USD", tf, "provider_rate_limit")),
      ...["5m", "15m", "1h", "4h"].map((tf) => fail("XAG/USD", tf, "provider_rate_limit")),
      ...["5m", "15m", "1h", "4h"].map((tf) => fail("WTI", tf, "provider_rate_limit")),
      ...["5m", "15m", "1h", "4h"].map((tf) => pass("BRENT", tf)),
      ...["5m", "15m", "1h", "4h"].map((tf) => pass("NATGAS", tf))
    ];
    const coverage = summarizeScanCoverage(markets, scanned);
    const mixed = summarizeScanCoverage(markets.slice(0, 2), [
      fail("XAU/USD", "5m", "provider_unavailable"), pass("XAU/USD", "1h"), pass("XAG/USD", "1h")
    ]);
    results.wording = {
      specExample: coverage.summary === "3 of 5 commodities couldn't be checked (provider rate limit).",
      partialMarket: mixed.summary === "1 of 2 commodities were only partially checked (provider unavailable)." && !mixed.complete,
      cleanScanHasNoSummary: summarizeScanCoverage(markets, commodities.map((symbol) => pass(symbol, "1h"))).summary === null
    };
  }
} finally {
  setSessionClockForTest(null);
  console.warn = realWarn;
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
  await query("DELETE FROM generated_signals WHERE pair = ANY($1) AND created_at >= $2 AND generated_by = $3", [commodities, testStart, userId]);
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
console.log("twelve data rate-limit visibility checks passed");
