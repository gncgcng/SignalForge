// Pure tests for the HTF alignment outcome report: fixture rows only, no database, no network.
import assert from "node:assert/strict";
import { buildForwardOutcomeMetrics, FORWARD_OUTCOME_R_VERSION } from "../src/modules/admin-signals/generatedSignalRepository.js";
import {
  buildAlignmentReport,
  buildDailyTrendLookup,
  classifyBadge,
  classifyBtcDaily,
  classifyDaily,
  classifyDailyTrend,
  classifyFourHour,
  decide,
  fetchDailyCandles,
  loadDailyTrends,
  parseArguments,
  renderText,
  selectPopulation,
  summarizeBucket,
  toAlignmentRecord
} from "./htf-alignment-outcome-report.js";
import { buildDecomposition, wilsonInterval } from "./weekly-realized-r-decomposition.js";

const NOW = new Date("2026-10-01T12:00:00Z");
let sequence = 0;

function htf(timeframe, trend, extra = {}) {
  return { timeframe, available: true, regime: { label: "Range", metrics: {} }, trend, score: 50, ...extra };
}

function row({ status = "Hit SL", direction = "long", timeframe = "15m", strategy = "Momentum breakout", pair = "ETH-USD",
  riskReward = 2, createdAt = "2026-09-10T14:00:00Z", outcomeAt = "2026-09-11T10:00:00Z", badge = "Partial Alignment",
  higherTimeframes = [htf("1h", "neutral"), htf("4h", "long")], realizedR, rVersion } = {}) {
  sequence += 1;
  const outcome = status === "Active" ? null : buildForwardOutcomeMetrics(status, riskReward, outcomeAt);
  return {
    id: `agen_${sequence}`, pair, display_pair: pair, timeframe, direction, strategy, pattern: null, source: "auto_crypto_watcher",
    confidence: 80, calibrated_confidence: 80, confidence_version: "calibration_v1", status,
    realized_r: realizedR !== undefined ? realizedR : outcome?.realizedR ?? null,
    outcome_evaluated_at: outcome ? outcomeAt : null,
    hit_tp_at: status === "Hit TP" ? outcomeAt : null,
    hit_sl_at: status === "Hit SL" ? outcomeAt : null,
    expired_at: status === "Expired" ? outcomeAt : null,
    created_at: createdAt,
    risk_reward: riskReward,
    outcome_r_version: rVersion !== undefined ? rVersion : outcome?.outcomeRVersion ?? null,
    indicator_badge: badge,
    indicator_confluence_score: badge ? "55" : null,
    indicator_higher_timeframes: higherTimeframes,
    confluence_badge: null,
    confluence_higher_timeframes: null
  };
}
const record = (overrides) => toAlignmentRecord(row(overrides));

// ---------- Part A bucketing ----------

{
  // The drawing case: a 15m short while the 4h trends up, passed as Partial Alignment because the 1h pulled back.
  const result = classifyFourHour(record({ direction: "short", timeframe: "15m", badge: "Partial Alignment", higherTimeframes: [htf("1h", "short"), htf("4h", "long")] }));
  assert.equal(result.bucket, "4h_opposes");
  assert.equal(result.opposesButPassed, true);
  assert.equal(result.trendSource, "trend");
}
{
  // Opposed and labelled Countertrend: still 4h_opposes, but the averaging did not hide it.
  const result = classifyFourHour(record({ direction: "short", badge: "Countertrend", higherTimeframes: [htf("1h", "long"), htf("4h", "long")] }));
  assert.equal(result.bucket, "4h_opposes");
  assert.equal(result.opposesButPassed, false);
}
assert.equal(classifyFourHour(record({ direction: "long", higherTimeframes: [htf("4h", "long")] })).bucket, "4h_agrees");
assert.equal(classifyFourHour(record({ direction: "long", higherTimeframes: [htf("4h", "neutral")] })).bucket, "4h_neutral");
{
  // A 4h signal has no higher timeframe: excluded from Part A, kept in Part B as its own row.
  const fourHour = record({ timeframe: "4h", badge: "Partial Alignment", higherTimeframes: [] });
  assert.equal(classifyFourHour(fourHour), null);
  assert.equal(classifyBadge(fourHour), "no_higher_timeframe");
}
{
  // Missing higherTimeframes array: 4h_unknown, still counted.
  const missing = record({ higherTimeframes: null });
  assert.deepEqual([classifyFourHour(missing).bucket, classifyFourHour(missing).reason], ["4h_unknown", "no higherTimeframes array"]);
  assert.equal(classifyFourHour(record({ higherTimeframes: [htf("1h", "long")] })).reason, "no 4h entry");
  assert.equal(classifyFourHour(record({ higherTimeframes: [{ timeframe: "4h", available: false, error: "down" }] })).reason, "4h entry unavailable");
}
{
  // trend field absent but regime present: recomputed with the exported inferMultiTimeframeDirection.
  const result = classifyFourHour(record({ direction: "short", higherTimeframes: [{ timeframe: "4h", available: true, regime: { label: "Trend Up", metrics: {} } }] }));
  assert.equal(result.bucket, "4h_opposes");
  assert.equal(result.trendSource, "regime");
}
{
  // Older rows may only carry the confluence object; it is read as a fallback.
  const fallback = toAlignmentRecord({ ...row({ direction: "long" }), indicator_badge: null, indicator_higher_timeframes: null, confluence_badge: "Full Alignment", confluence_higher_timeframes: [htf("4h", "long")] });
  assert.equal(fallback.alignment.higherTimeframesPath, "confluence.higherTimeframes");
  assert.equal(classifyFourHour(fallback).bucket, "4h_agrees");
  assert.equal(classifyBadge(fallback), "badge_full");
}
assert.equal(classifyBadge(record({ badge: "Countertrend" })), "badge_countertrend");
assert.equal(classifyBadge(record({ badge: null })), "badge_unknown");

// ---------- Part C: no look-ahead ----------

function dailyCandles(fromIso, days, closeOf) {
  const start = Date.parse(fromIso) / 1000;
  return Array.from({ length: days }, (_, index) => ({ time: start + index * 86400, close: closeOf(index) }));
}
{
  // 2026-06-01 .. 2026-09-10 rising steadily, then the 2026-09-10 candle crashes to 1.
  const candles = dailyCandles("2026-06-01T00:00:00Z", 102, (index) => 100 + index);
  assert.equal(new Date(candles.at(-1).time * 1000).toISOString().slice(0, 10), "2026-09-10");
  candles.at(-1).close = 1;
  const lookup = buildDailyTrendLookup(candles);
  const during = lookup("2026-09-10T14:00:00Z");
  assert.equal(during.candleDate, "2026-09-09", "the 2026-09-10 candle has not closed at 14:00Z");
  assert.equal(during.trend, "long", "the crash on the still-open daily candle must not be visible");
  const after = lookup("2026-09-11T00:00:00Z");
  assert.equal(after.candleDate, "2026-09-10", "once the day closes it becomes usable");
  assert.equal(after.trend, "neutral");
  assert.equal(lookup("2026-06-20T00:00:00Z").reason, "fewer than 50 closed daily candles");
  assert.equal(lookup("2026-05-01T00:00:00Z").reason, "no closed daily candle before the signal");
  assert.equal(lookup("2026-09-20T00:00:00Z").reason, "latest closed daily candle is stale");
}
assert.equal(classifyDailyTrend(110, 105, 100), "long");
assert.equal(classifyDailyTrend(90, 95, 100), "short");
assert.equal(classifyDailyTrend(110, 95, 100), "neutral");

// ---------- Wilson interval ----------

assert.deepEqual(wilsonInterval(3, 10), { low: 10.8, high: 60.3 });

// ---------- Realized R matches the decomposition script ----------

const realizedFixtures = [
  row({ status: "Hit TP", riskReward: 2.5 }),
  row({ status: "Hit TP", riskReward: 1.8, direction: "short" }),
  row({ status: "Hit SL", riskReward: 2 }),
  row({ status: "Hit SL", riskReward: 3, direction: "short" }),
  row({ status: "Hit SL", riskReward: 2 }),
  row({ status: "Expired", riskReward: 2 })
];
{
  assert.deepEqual(realizedFixtures.map((item) => item.realized_r), [2.5, 1.8, -1, -1, -1, 0]);
  const population = selectPopulation(realizedFixtures.map(toAlignmentRecord), { range: "all", now: NOW });
  const bucket = summarizeBucket(population.resolved);
  assert.deepEqual([bucket.n, bucket.tp, bucket.sl, bucket.expired, bucket.netR], [6, 2, 3, 1, 1.3]);
  assert.equal(bucket.avgR, round(1.3 / 6));
  const decomposition = buildDecomposition(realizedFixtures.map(toAlignmentRecord), { range: "all", now: NOW }).windows.current.headline;
  assert.deepEqual([decomposition.signals, decomposition.tp, decomposition.sl, decomposition.expired, decomposition.netRealizedR], [bucket.n, bucket.tp, bucket.sl, bucket.expired, bucket.netR]);
  // Break-even win rate uses the bucket's average planned R: (2.5+1.8+2+3+2+2)/6.
  assert.equal(bucket.avgPlannedR, round(13.3 / 6));
  assert.equal(bucket.breakEvenWinRate, round(100 / (1 + 13.3 / 6), 1));
  assert.equal(bucket.smallSample, true);
}

// ---------- population: active and unversioned rows are counted, not analysed ----------

{
  const population = selectPopulation([
    ...realizedFixtures,
    row({ status: "Active", createdAt: "2026-09-25T00:00:00Z" }),
    row({ status: "Hit SL", realizedR: null, rVersion: null }),
    row({ status: "Hit TP", realizedR: 2, rVersion: "legacy" }),
    row({ status: "Hit TP", outcomeAt: "2026-06-01T00:00:00Z", createdAt: "2026-05-31T00:00:00Z" })
  ].map(toAlignmentRecord), { range: "30d", timezone: "America/Los_Angeles", now: NOW });
  assert.equal(population.resolved.length, 6, "the June outcome is outside 30d");
  assert.deepEqual(population.excluded, { terminalWithoutVersionedR: 2, withoutRealizedR: 1, otherRVersion: 1, stillActive: 1 });
  assert.equal(population.realizedRVersion, FORWARD_OUTCOME_R_VERSION);
  assert.equal(population.realizedRVersionStart, "2026-06-01T00:00:00.000Z");
  assert.throws(() => selectPopulation(realizedFixtures.map(toAlignmentRecord), { strategy: "nope", now: NOW }), /Known strategies: Momentum breakout/);
  assert.equal(selectPopulation(realizedFixtures.map(toAlignmentRecord), { range: "all", strategy: "momentum-breakout", direction: "short", now: NOW }).resolved.length, 2);
}

// ---------- daily candle loading: throttled, cached per pair, failures recorded ----------

{
  const calls = [];
  const sleeps = [];
  const btc = dailyCandles("2026-01-01T00:00:00Z", 260, (index) => 100 + index);
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.pathname.includes("DEAD-USD")) return { ok: false, status: 404, json: async () => ({}) };
    if (url.pathname.includes("SLOW-USD") && !calls.some((call, index) => index < calls.length - 1 && call.pathname.includes("SLOW-USD"))) return { ok: false, status: 429, json: async () => ({}) };
    assert.equal(url.searchParams.get("granularity"), "86400");
    const start = Date.parse(url.searchParams.get("start")) / 1000;
    const end = Date.parse(url.searchParams.get("end")) / 1000;
    assert.ok((end - start) / 86400 <= 299, "a page never asks for more than 300 candles");
    return { ok: true, status: 200, json: async () => btc.filter((c) => c.time >= start && c.time <= end).reverse().map((c) => [c.time, c.close - 1, c.close + 1, c.close, c.close, 10]) };
  };
  const resolved = [
    record({ pair: "BTC-USD", createdAt: "2026-09-10T14:00:00Z" }),
    record({ pair: "ETH-USD", createdAt: "2026-09-10T14:00:00Z" }),
    record({ pair: "ETH-USD", createdAt: "2026-09-12T14:00:00Z" }),
    record({ pair: "DEAD-USD", createdAt: "2026-09-10T14:00:00Z" }),
    record({ pair: "SLOW-USD", createdAt: "2026-09-10T14:00:00Z" }),
    record({ pair: "XAU/USD", createdAt: "2026-09-10T14:00:00Z" })
  ];
  const daily = await loadDailyTrends(resolved, { baseUrl: "https://api.exchange.coinbase.com", fetchImpl: fakeFetch, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual([...daily.lookups.keys()].sort(), ["BTC-USD", "ETH-USD", "SLOW-USD"]);
  assert.deepEqual(Object.fromEntries(daily.failures), { "DEAD-USD": "Coinbase returned HTTP 404", "XAU/USD": "not a Coinbase USD product symbol" });
  assert.equal(calls.filter((url) => url.pathname.includes("ETH-USD")).length, 2, "ETH fetched once per page, not once per signal");
  assert.ok(sleeps.includes(350) && sleeps.includes(2000), "pauses between requests and backs off on 429");
  assert.equal(classifyDaily(resolved[3], daily).bucket, "daily_unknown");
  assert.equal(classifyDaily(resolved[3], daily).reason, "Coinbase returned HTTP 404");
  assert.equal(classifyDaily(resolved[1], daily).bucket, "daily_agrees");
  assert.equal(classifyBtcDaily(resolved[0], daily), null, "BTC itself has no BTC-daily bucket");
  assert.equal(classifyBtcDaily(resolved[5], daily), null, "non-Coinbase symbols have no BTC-daily bucket");
  assert.equal(classifyBtcDaily(record({ pair: "ETH-USD", direction: "short" }), daily).bucket, "btc_daily_opposes");

  const candles = await fetchDailyCandles("BTC-USD", { fromMs: Date.parse("2026-01-01T00:00:00Z"), toMs: Date.parse("2026-09-17T00:00:00Z"), baseUrl: "https://api.exchange.coinbase.com", fetchImpl: fakeFetch, sleep: async () => {} });
  assert.equal(candles.length, 260);
  assert.ok(candles.every((candle, index) => index === 0 || candle.time > candles[index - 1].time));
}

// ---------- decision rule ----------

const stats = (tp, sl, plannedR, values) => summarizeBucket([
  ...Array.from({ length: tp }, () => ({ status: "Hit TP", realizedR: plannedR, plannedR })),
  ...Array.from({ length: sl }, () => ({ status: "Hit SL", realizedR: -1, plannedR })),
  ...(values || []).map((value) => ({ status: "Expired", realizedR: value, plannedR }))
]);
assert.equal(decide(stats(20, 9, 2), stats(5, 40, 2)).verdict, "INCONCLUSIVE", "agreeing TP+SL 29 < 30");
assert.equal(decide(stats(20, 20, 2), stats(5, 20, 2)).verdict, "INCONCLUSIVE", "opposing TP+SL 25 < 30");
assert.equal(decide(stats(25, 25, 2), stats(5, 40, 2)).verdict, "CONFIRMED");
assert.equal(decide(stats(8, 32, 2), stats(7, 33, 2)).verdict, "NO_EDGE");
assert.equal(decide(stats(20, 20, 2), stats(18, 22, 2)).verdict, "NO_ROW_APPLIES", "both profitable, no clear gap");

// ---------- full report: Part A/B rows, counterfactuals ----------

{
  const rows = [
    row({ status: "Hit SL", direction: "short", higherTimeframes: [htf("1h", "short"), htf("4h", "long")] }),
    row({ status: "Hit SL", direction: "short", badge: "Countertrend", higherTimeframes: [htf("1h", "long"), htf("4h", "long")] }),
    row({ status: "Hit TP", direction: "long", riskReward: 2, higherTimeframes: [htf("1h", "long"), htf("4h", "long")] }),
    row({ status: "Expired", direction: "long", higherTimeframes: null }),
    row({ status: "Hit SL", direction: "long", timeframe: "4h", higherTimeframes: [] })
  ];
  const report = buildAlignmentReport(selectPopulation(rows.map(toAlignmentRecord), { range: "all", now: NOW }));
  const find = (family, bucket, strategy = "All strategies", direction = "both") => report.families[family].find((item) => item.bucket === bucket && item.strategy === strategy && item.direction === direction);
  assert.equal(find("fourHour", "4h_opposes").n, 2);
  assert.equal(find("fourHour", "4h_opposes_but_passed").n, 1);
  assert.equal(find("fourHour", "4h_unknown").n, 1, "missing array is counted");
  assert.equal(report.families.fourHour.filter((item) => item.strategy === "All strategies" && item.direction === "both").reduce((total, item) => total + (item.bucket === "4h_opposes_but_passed" ? 0 : item.n), 0), 4, "the 4h signal is not in Part A");
  assert.deepEqual(report.excluded.partA, { "4h (no higher timeframe)": 1 });
  assert.equal(find("badge", "no_higher_timeframe").n, 1);
  assert.equal(find("daily", "daily_unknown").n, 5, "no candles loaded: every signal is daily_unknown, none dropped");
  const blocked = report.counterfactuals.find((item) => item.bucket === "4h_opposes").scopes.find((item) => item.strategy === "All strategies" && item.direction === "both");
  assert.deepEqual(blocked, { strategy: "All strategies", direction: "both", signals: 5, removed: 2, removedNetR: -2, totalNetR: -1, newTotalNetR: 1 });
  assert.ok(report.decisions.every((item) => item.verdict === "INCONCLUSIVE"));
  assert.equal(report.coverage.rows.find((item) => item.timeframe === "15m").has4hEntry, 3);
  const text = renderText(report);
  assert.match(text, /If signals in 4h_opposes had been blocked: 2 removed, net R removed -2\.00R, new total net R \+1\.00R/);
  assert.match(text, /All strategies \/ both\s+INCONCLUSIVE/);
}

// ---------- arguments ----------

assert.deepEqual(parseArguments(["--range", "90d", "--timezone", "America/Los_Angeles", "--strategy", "momentum-breakout", "--direction", "SHORT", "--json"]),
  { range: "90d", from: null, to: null, timezone: "America/Los_Angeles", now: null, strategy: "momentum-breakout", direction: "short", json: true });
assert.equal(parseArguments([]).range, "30d");
assert.equal(parseArguments(["--from", "2026-09-01", "--to", "2026-09-30"]).range, "custom");
assert.throws(() => parseArguments(["--range", "1y"]), /--range must be one of/);
assert.throws(() => parseArguments(["--direction", "both"]), /--direction must be one of/);
assert.throws(() => parseArguments(["--expect", "-1"]), /Unknown argument/);

function round(value, digits = 3) { return Number(Number(value).toFixed(digits)); }

console.log("HTF alignment outcome report tests passed.");
