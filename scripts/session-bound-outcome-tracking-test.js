import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
// Outcome tracking for commodity (session-bound) signals, end to end: real local Postgres, the real
// Twelve Data adapter over HTTP to a local Twelve Data stand-in, real saved and generated signals.
//
// Before this fix the tracker never fetched commodity data (shouldFetchSignalOutcomeMarketData was
// false) and relied on a cache that was essentially never populated, so a commodity signal that hit
// its take profit was later marked "Expired" by the validity sweep. These scenarios pin that down:
//   A. TP crossed inside an open window          -> Hit TP (saved + generated), one request
//   B. TP crossed, window already over           -> the sweep leaves it alone, tracker records Hit TP
//   C. window over, no hit, candles cover it      -> Expired (verified, counts toward forward metrics)
//   D. window over, provider failing              -> stays Active within grace, then Expired *unverified*
//   E. market closed, no window ended             -> no provider request at all
import assert from "node:assert/strict";
import { generateSeries, startTwelveDataStandIn } from "./test-support/twelve-data-stand-in.js";

const H = 3_600_000;
const ENTRY = 2400;
const STOP = 2380;
const TARGET = 2440;
let crossings = {};
const standIn = await startTwelveDataStandIn({
  // A flat market at ENTRY; each scenario's symbol crosses TARGET at a chosen instant.
  series: (providerSymbol, interval) => {
    const stepMs = { "5min": 300_000, "15min": 900_000, "1h": H, "4h": 4 * H }[interval];
    const crossAt = crossings[providerSymbol];
    const endMs = crossings.endMs || Date.now();
    return generateSeries({ interval, endMs, startPrice: ENTRY, step: 0 }).map((value) => {
      const openedAt = Date.parse(`${value.datetime}Z`);
      const crosses = crossAt !== undefined && openedAt <= crossAt && crossAt < openedAt + stepMs;
      return { ...value, high: String(crosses ? TARGET + 5 : ENTRY + 2), low: String(ENTRY - 2) };
    });
  },
  fail: (providerSymbol) => providerSymbol === "XAG/USD"
    ? { status: 200, body: { code: 500, message: "Internal error", status: "error" } }
    : null
});
process.env.TWELVEDATA_API_BASE_URL = standIn.baseUrl;
process.env.TWELVEDATA_API_KEY = "outcome-tracking-test-key";
process.env.TWELVEDATA_CACHE_TTL_MS = "0";
process.env.EMAIL_FEATURES_ENABLED = "false";

const { query, getPool } = await import("../src/db/client.js");
const { createUser, saveUnlockedSignal, expireActiveSignalsPastValidity, listActiveSignals } = await import("../src/db/repositories.js");
const { listActiveGeneratedSignals, upsertGeneratedSignal } = await import("../src/modules/admin-signals/generatedSignalRepository.js");
const { trackSessionBoundSignalOutcomes, shouldFetchSignalOutcomeMarketData } = await import("../src/modules/signals/signalOutcomeService.js");
const { withSignalValidity } = await import("../src/modules/signals/signalValidityService.js");
const { isMarketOpen } = await import("../src/modules/markets/sessionService.js");
const { hashPassword } = await import("../src/modules/auth/authService.js");
const { createId } = await import("../src/shared/ids.js");

const savedIds = new Set();
const generatedIds = new Set();
const email = `outcome-tracking-${Date.now().toString(36)}@example.test`;
const userId = createId("usr");
const results = {};

// Instants where the commodity market is open for the whole span, so scenarios don't depend on the
// weekday the suite runs: one in the future (A) and one in the past (B-D).
const openThroughout = (endMs, hours) => Array.from({ length: hours + 1 }, (_, h) => endMs - h * H).every((ms) => isMarketOpen("XAU/USD", ms));
function findOpenInstant(fromMs, direction) {
  let candidate = Math.floor(fromMs / H) * H;
  while (!openThroughout(candidate, 12)) candidate += direction * H;
  return candidate;
}
const future = findOpenInstant(Date.now() + 48 * H, 1);
const past = findOpenInstant(Date.now() - 30 * H, -1);

const trackerDeps = (now) => ({
  now: () => now,
  listActiveSignals: async () => (await listActiveSignals()).filter((signal) => savedIds.has(signal.id)),
  listActiveGeneratedSignals: async () => (await listActiveGeneratedSignals(5000)).filter((signal) => generatedIds.has(signal.id))
});

async function seedSaved(symbol, { generatedAt, validUntil = null, takeProfit = TARGET }) {
  const signal = withSignalValidity({
    id: createId("sig"), symbol, timeframe: "1h", direction: "long",
    entryPrice: ENTRY, stopLoss: STOP, takeProfit, riskRewardRatio: 2, confidenceScore: 80, qualityScore: 80,
    setupType: "Outcome tracking test", reasoning: "test", confirmations: [], indicators: {},
    marketSource: "twelve-data", generatedAt: new Date(generatedAt).toISOString(),
    // saveUnlockedSignal refuses already-expired signals; past windows are moved back afterwards.
    ...(validUntil ? { validUntil: new Date(Date.now() + 24 * H).toISOString() } : {})
  });
  await saveUnlockedSignal(userId, signal);
  if (validUntil) await query("UPDATE saved_signals SET valid_until = $2 WHERE id = $1", [signal.id, new Date(validUntil)]);
  savedIds.add(signal.id);
  return signal.id;
}

async function seedGenerated(symbol, { generatedAt, validUntil, takeProfit = TARGET }) {
  const stored = await upsertGeneratedSignal({
    id: createId("sig"), symbol, timeframe: "1h", direction: "long", entryPrice: ENTRY, stopLoss: STOP,
    takeProfit, riskRewardRatio: 2, confidenceScore: 80, marketSource: "twelve-data",
    setupType: "Outcome tracking test", generatedAt: new Date(generatedAt), validUntil: new Date(validUntil).toISOString()
  }, { source: "manual_scan", generatedBy: "outcome-tracking-test" });
  generatedIds.add(stored.id);
  return stored.id;
}

const savedState = async (id) => (await query(`SELECT o.status, o.status_reason, o.resolved_at, s.expired_at
  FROM saved_signals s JOIN signal_outcomes o ON o.saved_signal_id = s.id WHERE s.id = $1`, [id])).rows[0];
const generatedState = async (id) => (await query(
  "SELECT status, result_reason, hit_tp_at, expired_at, realized_r FROM generated_signals WHERE id = $1", [id])).rows[0];
const requestsFor = (symbol) => standIn.requests.filter((request) => request.symbol === symbol);

try {
  await createUser({ id: userId, name: "Outcome Tracking Test", email, password: hashPassword("outcome-pass"), emailVerifiedAt: new Date() });
  await query("UPDATE users SET role = 'tester' WHERE id = $1", [userId]);

  // ---------------------------------------------------------------- A. TP inside an open window
  {
    const generatedAt = future - 3 * H;
    crossings = { "XAU/USD": generatedAt + 90 * 60_000, endMs: future };
    const saved = await seedSaved("XAU/USD", { generatedAt });
    const generated = await seedGenerated("XAU/USD", { generatedAt, validUntil: future + 20 * H });
    standIn.resetRequests();
    const summary = await trackSessionBoundSignalOutcomes(trackerDeps(future));
    const savedRow = await savedState(saved);
    const generatedRow = await generatedState(generated);
    results.A_tpInsideWindow = {
      oldTrackerNeverFetchedCommodities: shouldFetchSignalOutcomeMarketData({ symbol: "XAU/USD" }) === false,
      savedSignalHitTp: savedRow.status === "Hit TP" && savedRow.resolved_at.getTime() === crossings["XAU/USD"],
      generatedSignalHitTp: generatedRow.status === "Hit TP" && Number(generatedRow.realized_r) > 0,
      oneRequestServesBothSignals: summary.requests === 1 && requestsFor("XAU/USD").length === 1,
      usedProviderSymbolAndKey: requestsFor("XAU/USD")[0]?.apikey === "outcome-tracking-test-key"
    };
  }

  // ---------------------------------------------------------------- B. TP inside a window that is already over
  {
    const generatedAt = past - 6 * H;
    crossings = { "XBR/USD": generatedAt + 2 * H };
    const saved = await seedSaved("BRENT", { generatedAt, validUntil: past - H });
    const generated = await seedGenerated("BRENT", { generatedAt, validUntil: past - H });
    await expireActiveSignalsPastValidity();
    const afterSweep = await savedState(saved);
    await trackSessionBoundSignalOutcomes(trackerDeps(Date.now()));
    const savedRow = await savedState(saved);
    results.B_tpBeforeWindowEnded = {
      validitySweepDoesNotBlindlyExpire: afterSweep.status === "Active",
      savedSignalHitTpNotExpired: savedRow.status === "Hit TP" && savedRow.resolved_at.getTime() === crossings["XBR/USD"],
      generatedSignalHitTpNotExpired: (await generatedState(generated)).status === "Hit TP"
    };
  }

  // ---------------------------------------------------------------- C. no hit, full window covered
  {
    const generatedAt = past - 6 * H;
    crossings = {};
    const saved = await seedSaved("WTI", { generatedAt, validUntil: past - H });
    const generated = await seedGenerated("WTI", { generatedAt, validUntil: past - H });
    await trackSessionBoundSignalOutcomes(trackerDeps(Date.now()));
    const savedRow = await savedState(saved);
    const generatedRow = await generatedState(generated);
    results.C_verifiedExpiry = {
      savedExpiredAtWindowEnd: savedRow.status === "Expired" && savedRow.resolved_at.getTime() === past - H &&
        savedRow.expired_at?.getTime() === past - H && /full window/.test(savedRow.status_reason),
      generatedExpiredWithForwardMetrics: generatedRow.status === "Expired" && generatedRow.realized_r !== null
    };
  }

  // ---------------------------------------------------------------- D. provider failing at the final check
  {
    // The window ended 30 minutes ago: inside the default grace period.
    const validUntil = Date.now() - 30 * 60_000;
    const generatedAt = validUntil - 5 * H;
    const saved = await seedSaved("XAG/USD", { generatedAt, validUntil });
    const generated = await seedGenerated("XAG/USD", { generatedAt, validUntil });
    const withinGrace = await trackSessionBoundSignalOutcomes(trackerDeps(Date.now()));
    const stillActive = (await savedState(saved)).status === "Active" && (await generatedState(generated)).status === "Active";
    const afterGrace = await trackSessionBoundSignalOutcomes({ ...trackerDeps(Date.now()), finalCheckGraceMs: 0 });
    const savedRow = await savedState(saved);
    const generatedRow = await generatedState(generated);
    results.D_providerFailure = {
      reportedAsProviderFailure: withinGrace.providerFailures === 1 && withinGrace.pending === 2,
      waitsWithinGrace: stillActive,
      expiresExplicitlyUnverifiedAfterGrace: afterGrace.expiredUnverified === 2 && savedRow.status === "Expired" &&
        /unverified/.test(savedRow.status_reason) && generatedRow.status === "Expired" && /unverified/.test(generatedRow.result_reason),
      unverifiedKeptOutOfForwardMetrics: generatedRow.realized_r === null
    };
  }

  // ---------------------------------------------------------------- E. closed market, nothing due
  {
    let saturday = Math.floor((future + 24 * H) / H) * H;
    while (isMarketOpen("NATGAS", saturday)) saturday += H;
    const generated = await seedGenerated("NATGAS", { generatedAt: saturday - 30 * H, validUntil: saturday + 48 * H });
    standIn.resetRequests();
    const summary = await trackSessionBoundSignalOutcomes(trackerDeps(saturday));
    results.E_closedMarket = {
      noProviderRequest: summary.requests === 0 && standIn.requests.length === 0 && summary.skippedClosed === 1,
      signalWaits: (await generatedState(generated)).status === "Active"
    };
  }

  // ---------------------------------------------------------------- F. old and fresh signal on one market
  {
    // The old signal needs hourly candles to reach back to it; the fresh one's TP touch happens 20
    // minutes after it was generated, inside an hourly candle that opened *before* it — only finer
    // candles can attribute it. Each signal must get candles fine enough for its own window.
    const fresh = future - 2 * H + 7 * 60_000;
    crossings = { "XTI/USD": fresh + 20 * 60_000, endMs: future };
    const old = await seedGenerated("WTI", { generatedAt: future - 70 * H, validUntil: future + 10 * H, takeProfit: TARGET + 100 });
    const recent = await seedGenerated("WTI", { generatedAt: fresh, validUntil: future + H });
    standIn.resetRequests();
    await trackSessionBoundSignalOutcomes(trackerDeps(future));
    results.F_mixedAges = {
      freshSignalResolvedOnFineCandles: (await generatedState(recent)).status === "Hit TP",
      oldSignalStillTracked: (await generatedState(old)).status === "Active",
      // (Other still-active test signals, e.g. E's NATGAS, are fetched too; count WTI only.)
      oneRequestPerGranularity: requestsFor("XTI/USD").map((request) => request.interval).sort().join() === "1h,5min"
    };
  }
} finally {
  if (generatedIds.size) await query("DELETE FROM generated_signals WHERE id = ANY($1)", [[...generatedIds]]);
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
console.log("session-bound outcome tracking checks passed");
