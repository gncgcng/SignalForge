import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
// Trading-session service (src/modules/markets/sessionService.js) and the places that consult it.
// A. Calendar rules at fixed instants: parity with the old hardcoded Sunday 22:00 -> Friday 22:00 UTC
//    week, DST, US holidays, nextOpen/nextClose, 24/7 crypto.
// B. Session-aware expiry: the Friday-before-the-close 4h signal keeps its 48h of open-market time,
//    persisted through the real saveUnlockedSignal path into a real local Postgres.
// C. Consumers: market status / signal validation, scan universe and single scan skip closed
//    markets without calling the provider.
import assert from "node:assert/strict";

process.env.TWELVEDATA_API_KEY = "trading-session-test-key";
process.env.EMAIL_FEATURES_ENABLED = "false";

const session = await import("../src/modules/markets/sessionService.js");
const { isMarketOpen, nextOpen, nextClose, addOpenMarketTime, openMarketMsBetween, setSessionClockForTest } = session;
const { getSignalValidUntil, withSignalValidity } = await import("../src/modules/signals/signalValidityService.js");
const { resolveMarketStatus, getManualScannerUniverse, getPair } = await import("../src/modules/market-data/marketDataService.js");
const { query, getPool } = await import("../src/db/client.js");
const { createUser, saveUnlockedSignal, expireActiveSignalsPastValidity } = await import("../src/db/repositories.js");
const { hashPassword } = await import("../src/modules/auth/authService.js");
const { createId } = await import("../src/shared/ids.js");
const { scanMarketSetupDetailed } = await import("../src/modules/signals/signalService.js");

const H = 3600_000;
const gold = { symbol: "XAU/USD", sessionCalendarId: "us_commodity_week" };
const at = (iso) => new Date(iso);
const iso = (date) => date?.toISOString() ?? null;
const results = {};

// The implementation this replaced, kept verbatim as the parity oracle.
function legacyIsCommodityMarketOpen(date) {
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  if (day === 0) return hour >= 22;
  if (day >= 1 && day <= 4) return true;
  if (day === 5) return hour < 22;
  return false;
}

// ---------------------------------------------------------------- A. calendar rules
{
  // Feb 1-14 2026: EST, no US market holidays (Presidents Day is Feb 16).
  const disagreements = [];
  for (let ms = Date.parse("2026-02-01T00:00:00Z"); ms < Date.parse("2026-02-15T00:00:00Z"); ms += 30 * 60_000) {
    if (isMarketOpen(gold, ms) !== legacyIsCommodityMarketOpen(new Date(ms))) disagreements.push(new Date(ms).toISOString());
  }
  results.calendar = {
    winterParityWithLegacyWeek: disagreements.length === 0 || disagreements.slice(0, 5),
    summerFridayClosesAt2100Utc: isMarketOpen(gold, at("2026-07-17T20:59:00Z")) && !isMarketOpen(gold, at("2026-07-17T21:00:00Z")),
    summerSundayOpensAt2100Utc: !isMarketOpen(gold, at("2026-07-19T20:59:00Z")) && isMarketOpen(gold, at("2026-07-19T21:00:00Z")),
    springForwardSundayOpensAt1700Local: iso(nextOpen(gold, at("2026-03-07T12:00:00Z"))) === "2026-03-08T21:00:00.000Z",
    fallBackSundayOpensAt1700Local: iso(nextOpen(gold, at("2026-10-31T12:00:00Z"))) === "2026-11-01T22:00:00.000Z",
    goodFridayClosed: !isMarketOpen(gold, at("2026-04-03T14:00:00Z")) && iso(nextClose(gold, at("2026-03-30T12:00:00Z"))) === "2026-04-02T21:00:00.000Z",
    christmasClosed: !isMarketOpen(gold, at("2026-12-25T15:00:00Z")),
    christmasEveHaltsAt1345Local: isMarketOpen(gold, at("2026-12-24T18:44:00Z")) && !isMarketOpen(gold, at("2026-12-24T18:46:00Z")),
    newYearsDay2027Closed: !isMarketOpen(gold, at("2027-01-01T15:00:00Z")),
    saturdayNewYear2028NotMovedIntoDec31: isMarketOpen(gold, at("2027-12-31T15:00:00Z")),
    thanksgivingHaltsAt1300Local: isMarketOpen(gold, at("2026-11-26T17:59:00Z")) && !isMarketOpen(gold, at("2026-11-26T18:01:00Z")) &&
      isMarketOpen(gold, at("2026-11-26T22:30:00Z")),
    independenceDayObservedFriday: !isMarketOpen(gold, at("2026-07-03T18:30:00Z")) && isMarketOpen(gold, at("2026-07-03T16:30:00Z")),
    nextCloseIsWeeklyCloseNotDailyRollover: iso(nextClose(gold, at("2026-07-15T12:00:00Z"))) === "2026-07-17T21:00:00.000Z",
    nextOpenFromClosedWeekend: iso(nextOpen(gold, at("2026-07-18T12:00:00Z"))) === "2026-07-19T21:00:00.000Z",
    fullWeekHas120OpenHours: openMarketMsBetween(gold, at("2026-07-12T00:00:00Z"), at("2026-07-19T00:00:00Z")) === 120 * H,
    cryptoAlwaysOpen: isMarketOpen("BTC-USD", at("2026-07-18T12:00:00Z")) && nextOpen("BTC-USD") === null && nextClose("BTC-USD") === null,
    symbolResolvesThroughRegistry: isMarketOpen("XAU/USD", at("2026-07-18T12:00:00Z")) === false,
    unknownCalendarIsAnErrorNotAlwaysOpen: (() => {
      try { isMarketOpen({ sessionCalendarId: "no_such_calendar" }); return false; } catch { return true; }
    })()
  };
}

// ---------------------------------------------------------------- B. session-aware expiry
{
  // The bug: a 4h signal (48h validity) generated Friday 21:00 UTC in winter expired Sunday 21:00,
  // an hour before the market reopened. Feb 6 2026 is a plain Friday (no holiday on either side).
  const friday = at("2026-02-06T21:00:00Z");
  const fridaySignal = { symbol: "XAU/USD", timeframe: "4h", generatedAt: friday.toISOString() };
  const wallClock = new Date(friday.getTime() + 48 * H);
  const sessionAware = at(getSignalValidUntil(fridaySignal));
  // Jan 16 2026 is the Friday before MLK Day: Monday halts at 13:00 New York, which also pauses the clock.
  const mlkFriday = at(getSignalValidUntil({ symbol: "XAU/USD", timeframe: "4h", generatedAt: "2026-01-16T21:00:00Z" }));
  results.expiry = {
    oldWallClockExpiredBeforeReopen: wallClock.getTime() < nextOpen(gold, friday).getTime(),
    fridaySignalExpiresTuesday: iso(sessionAware) === "2026-02-10T21:00:00.000Z",
    fullWindowOfOpenMarketTime: openMarketMsBetween(gold, friday, sessionAware) === 48 * H,
    holidayHaltAlsoPausesClock: iso(mlkFriday) === "2026-01-21T01:00:00.000Z",
    generatedWhileClosedStartsAtReopen: iso(at(getSignalValidUntil({ symbol: "XAU/USD", timeframe: "1h", generatedAt: "2026-02-07T12:00:00Z" }))) === "2026-02-09T22:00:00.000Z",
    cryptoStaysWallClock: getSignalValidUntil({ symbol: "BTC-USD", timeframe: "4h", generatedAt: friday.toISOString() }) === wallClock.toISOString(),
    persistedValidUntilWins: getSignalValidUntil({ ...fridaySignal, validUntil: "2026-02-07T00:00:00.000Z" }) === "2026-02-07T00:00:00.000Z"
  };

  // Same scenario through the real persistence path. The instant is derived from "now" (an hour
  // before the next closing bell) because saveUnlockedSignal rightly refuses already-expired signals.
  const generatedAt = new Date(nextClose(gold, new Date()).getTime() - H);
  const reopen = nextOpen(gold, new Date(generatedAt.getTime() + H));
  const email = `trading-session-${Date.now().toString(36)}@example.test`;
  const userId = createId("usr");
  try {
    await createUser({ id: userId, name: "Session Test", email, password: hashPassword("session-test-pass"), emailVerifiedAt: new Date() });
    await query("UPDATE users SET role = 'tester' WHERE id = $1", [userId]);
    const signal = withSignalValidity({
      id: createId("sig"), symbol: "XAU/USD", timeframe: "4h", direction: "long",
      entryPrice: 2400, stopLoss: 2380, takeProfit: 2440, riskRewardRatio: 2, confidenceScore: 80, qualityScore: 80,
      setupType: "Session test", reasoning: "Session test", confirmations: [], indicators: {},
      marketSource: "twelve-data", generatedAt: generatedAt.toISOString()
    });
    await saveUnlockedSignal(userId, signal);
    await expireActiveSignalsPastValidity();
    const row = (await query(`SELECT s.valid_until, o.status FROM saved_signals s
      JOIN signal_outcomes o ON o.saved_signal_id = s.id WHERE s.id = $1`, [signal.id])).rows[0];
    const expected = new Date(reopen.getTime() + 47 * H);
    results.expiryPersisted = {
      persistedValidUntilIsSessionAware: row.valid_until.getTime() === expected.getTime() || row.valid_until.toISOString(),
      wallClockWouldHaveExpiredWhileClosed: generatedAt.getTime() + 48 * H < reopen.getTime(),
      notExpiredByExpirySweep: row.status === "Active"
    };
  } finally {
    await query("DELETE FROM users WHERE email = $1", [email]);
  }
}

// ---------------------------------------------------------------- C. consumers
{
  const saturday = at("2026-07-18T12:00:00Z");
  const wednesday = at("2026-07-15T12:00:00Z");
  const closed = resolveMarketStatus(getPair("XAU/USD"), "1h", [], saturday.toISOString(), saturday);
  const open = resolveMarketStatus(getPair("XAU/USD"), "1h", [{ time: wednesday.getTime() / 1000 - 600 }], wednesday.toISOString(), wednesday);

  let providerCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error("provider must not be called for a closed market"); };
  try {
    setSessionClockForTest(saturday);
    const weekendUniverse = getManualScannerUniverse({ marketType: "all" });
    const closedScan = await scanMarketSetupDetailed({ id: "usr_session_test", role: "tester" }, { symbol: "XAU/USD", timeframe: "1h" });
    setSessionClockForTest(wednesday);
    const weekdayUniverse = getManualScannerUniverse({ marketType: "commodities" });

    const closedSkips = weekendUniverse.skipped.filter((item) => item.reasonCode === "market_closed");
    results.consumers = {
      validationSeesClosed: closed.code === "CLOSED" && closed.session?.nextOpen === "2026-07-19T21:00:00.000Z",
      validationSeesOpen: open.code === "LIVE" && open.session?.open === true,
      scanUniverseSkipsClosedCommodities: closedSkips.length === 5 &&
        !weekendUniverse.markets.some((m) => m.category === "Commodities") &&
        closedSkips.every((item) => item.reason === "Market is closed; reopens Sun 19 Jul 21:00 UTC."),
      scanUniverseKeepsCrypto: weekendUniverse.markets.some((m) => m.category === "Crypto"),
      scanUniverseIncludesOpenCommodities: weekdayUniverse.markets.length === 5,
      singleScanAnswersClosedWithoutFetching: closedScan.publicResult.valid === false &&
        closedScan.publicResult.analysis.rejectionReasonCodes[0] === "market_closed" && closedScan.fullSetup === null,
      providerNeverCalled: providerCalls === 0
    };
  } finally {
    setSessionClockForTest(null);
    globalThis.fetch = realFetch;
  }
}

await getPool().end();
console.log(JSON.stringify(results, null, 2));
for (const [group, checks] of Object.entries(results)) {
  for (const [name, value] of Object.entries(checks)) {
    assert.equal(value, true, `${group}.${name} failed: ${JSON.stringify(value)}`);
  }
}
console.log("trading session checks passed");
