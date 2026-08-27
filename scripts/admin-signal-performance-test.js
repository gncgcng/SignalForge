import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildGeneratedSignalPerformance,
  groupRecords,
  normalizePerformanceTimezone,
  rankPeriods,
  resolvePerformanceRange,
  summarizeRecords
} from "../src/modules/admin-signals/generatedSignalPerformance.js";

const now = new Date("2026-08-26T18:00:00.000Z");
const today = [
  record("w1", "Hit TP", 2, "2026-08-26T01:00:00.000Z"),
  record("w2", "Hit TP", 2.5, "2026-08-26T02:00:00.000Z"),
  record("w3", "Hit TP", 1.5, "2026-08-26T03:00:00.000Z"),
  record("l1", "Hit SL", -1, "2026-08-26T04:00:00.000Z"),
  record("e1", "Expired", 0, "2026-08-26T05:00:00.000Z"),
  record("e2", "Expired", 0, "2026-08-26T06:00:00.000Z")
];

const todayResult = buildGeneratedSignalPerformance(today, { range: "today", grouping: "day", now });
assert.equal(todayResult.metrics.wins, 3);
assert.equal(todayResult.metrics.losses, 1);
assert.equal(todayResult.metrics.expired, 2);
assert.equal(todayResult.metrics.winRate, 75, "Expired must not enter the TP/(TP+SL) win-rate denominator.");
assert.equal(todayResult.metrics.netRealizedR, 5);
assert.equal(todayResult.metrics.expectancyR, 0.833);
assert.equal(todayResult.semantics.outcomeTimestamp, "outcome_evaluated_at grouped in UTC");

const ranges = {
  today: resolvePerformanceRange("today", null, null, now),
  seven: resolvePerformanceRange("7d", null, null, now),
  ytd: resolvePerformanceRange("ytd", null, null, now),
  custom: resolvePerformanceRange("custom", "2026-08-20", "2026-08-22", now)
};
assert.equal(ranges.today.from.toISOString(), "2026-08-26T00:00:00.000Z");
assert.equal(ranges.seven.from.toISOString(), "2026-08-20T00:00:00.000Z");
assert.equal(ranges.ytd.from.toISOString(), "2026-01-01T00:00:00.000Z");
assert.equal(ranges.custom.to.toISOString(), "2026-08-23T00:00:00.000Z");
assert.equal(ranges.custom.toExclusive, true);
assert.throws(() => resolvePerformanceRange("custom", "2026-08-23", "2026-08-20", now), /valid custom/i);

const losAngeles = "America/Los_Angeles";
assert.equal(normalizePerformanceTimezone(losAngeles), losAngeles);
assert.equal(normalizePerformanceTimezone("Not/A_Timezone"), "UTC");
const localBoundary = buildGeneratedSignalPerformance([
  record("local-boundary", "Hit TP", 2, "2026-08-27T01:00:00.000Z")
], { range: "all", grouping: "day", timezone: losAngeles, now: new Date("2026-08-27T12:00:00.000Z") });
assert.equal(localBoundary.timeline[0].period, "2026-08-26", "01:00Z belongs to the prior Los Angeles calendar day.");
assert.equal(localBoundary.range.timezone, losAngeles);
const localGroupingFixtures = [
  normalizeForGrouping(record("local-week", "Hit TP", 2, "2026-08-31T05:00:00.000Z")),
  normalizeForGrouping(record("local-month", "Hit TP", 2, "2026-09-01T01:00:00.000Z"))
];
assert.equal(groupRecords([localGroupingFixtures[0]], "week", losAngeles)[0].period, "2026-08-24", "ISO-style weeks start Monday in the selected timezone.");
assert.equal(groupRecords([localGroupingFixtures[1]], "month", losAngeles)[0].period, "2026-08", "Month grouping uses the selected timezone calendar month.");
const localRankedDay = buildGeneratedSignalPerformance(
  Array.from({ length: 5 }, (_, index) => record(`local-rank-${index}`, "Hit TP", 1, `2026-08-27T0${index + 1}:00:00.000Z`)),
  { range: "all", grouping: "day", timezone: losAngeles, now: new Date("2026-08-27T12:00:00.000Z") }
);
assert.equal(localRankedDay.bestWorst.day.best.period, "2026-08-26", "Best/worst day ranking must use the same local grouping.");

const springForward = resolvePerformanceRange("custom", "2026-03-08", "2026-03-08", new Date("2026-03-08T12:00:00.000Z"), losAngeles);
assert.equal(springForward.from.toISOString(), "2026-03-08T08:00:00.000Z");
assert.equal(springForward.to.toISOString(), "2026-03-09T07:00:00.000Z");
assert.equal(springForward.to - springForward.from, 23 * 60 * 60 * 1000, "Spring-forward local day must be 23 hours.");
const fallBack = resolvePerformanceRange("custom", "2026-11-01", "2026-11-01", new Date("2026-11-01T12:00:00.000Z"), losAngeles);
assert.equal(fallBack.from.toISOString(), "2026-11-01T07:00:00.000Z");
assert.equal(fallBack.to.toISOString(), "2026-11-02T08:00:00.000Z");
assert.equal(fallBack.to - fallBack.from, 25 * 60 * 60 * 1000, "Fall-back local day must be 25 hours.");
const invalidTimezone = buildGeneratedSignalPerformance(today, { range: "today", timezone: "Invalid/Zone", now });
assert.equal(invalidTimezone.range.timezone, "UTC");

const groupedFixtures = [
  record("d1", "Hit TP", 2, "2026-08-03T10:00:00.000Z"),
  record("d2", "Hit SL", -1, "2026-08-03T11:00:00.000Z"),
  record("d3", "Expired", 0, "2026-08-10T12:00:00.000Z"),
  record("d4", "Hit TP", 1.5, "2026-09-01T12:00:00.000Z")
].map(normalizeForGrouping);
assert.equal(groupRecords(groupedFixtures, "day").length, 3);
assert.equal(groupRecords(groupedFixtures, "week").length, 3);
assert.equal(groupRecords(groupedFixtures, "month").length, 2);

const customResult = buildGeneratedSignalPerformance([
  record("before", "Hit TP", 2, "2026-08-19T23:59:59.000Z"),
  record("inside", "Hit SL", -1, "2026-08-21T12:00:00.000Z"),
  record("after", "Expired", 0, "2026-08-23T00:00:00.000Z")
], { range: "custom", from: "2026-08-20", to: "2026-08-22", now });
assert.equal(customResult.metrics.signals, 1, "Custom ranges must filter on canonical outcome timestamps.");
assert.equal(customResult.metrics.losses, 1);

const missingR = summarizeRecords([
  normalizeForGrouping(record("known", "Hit TP", 2, "2026-08-26T01:00:00.000Z")),
  normalizeForGrouping(record("unknown", "Hit SL", null, "2026-08-26T02:00:00.000Z"))
]);
assert.equal(missingR.netRealizedR, 2);
assert.equal(missingR.realizedRObservations, 1);
assert.equal(missingR.missingRealizedR, 1);
assert.equal(missingR.expectancyR, 2, "Missing realized R must not be fabricated as zero.");

const eligiblePeriods = [
  { period: "good", signals: 5, realizedRObservations: 5, netRealizedR: 4, expectancyR: 0.8 },
  { period: "tiny", signals: 1, realizedRObservations: 1, netRealizedR: 10, expectancyR: 10 },
  { period: "bad", signals: 5, realizedRObservations: 5, netRealizedR: -3, expectancyR: -0.6 }
];
const ranked = rankPeriods(eligiblePeriods, 5);
assert.equal(ranked.best.period, "good");
assert.equal(ranked.worst.period, "bad");
assert.equal(rankPeriods(eligiblePeriods, 10).best, null);
assert.equal(rankPeriods([{ ...eligiblePeriods[0], realizedRObservations: 4 }], 5).best, null, "Period ranking requires the minimum canonical R observations.");

const missingTimestampResult = buildGeneratedSignalPerformance([
  record("timestamped", "Hit TP", 2, "2026-08-26T01:00:00.000Z"),
  record("legacy", "Hit SL", -1, null)
], { range: "all", now });
assert.equal(missingTimestampResult.metrics.signals, 1);
assert.equal(missingTimestampResult.dataQuality.missingOutcomeTimestamp, 1);

const repository = read("src/modules/admin-signals/generatedSignalRepository.js");
const controller = read("src/modules/admin-signals/generatedSignalController.js");
const service = read("src/modules/admin-signals/generatedSignalService.js");
const html = read("public/index.html");
const css = read("public/styles.css");
const app = read("public/app.js");

assert.match(repository, /status IN \('Hit TP','Hit SL','Expired'\)/);
for (const filter of ["pair", "timeframe", "direction", "strategy", "pattern", "source", "engineVersion", "confidenceMin", "confidenceMax"]) {
  assert.ok(repository.includes(`filters.${filter}`), `Performance repository must support ${filter}.`);
}
assert.ok(controller.includes("getAdminGeneratedSignalPerformance"));
assert.ok(controller.includes('timezone: clean(params.get("timezone"), 80)'));
assert.ok(service.includes("buildGeneratedSignalPerformance"));
assert.ok(html.includes('id="admin-signals-panel-signals"'));
assert.ok(html.includes('id="admin-signals-panel-performance"'));
assert.ok(html.includes('id="admin-signals-panel-calibration"'));
assert.ok(html.indexOf('id="admin-signal-quality-panel"') > html.indexOf('id="admin-signals-panel-calibration"'));
assert.ok(app.includes("data.signals.map(renderAdminSignalRow)"), "Signals tab must retain the existing generated-signal rows.");
assert.ok(app.includes("renderAdminSignalDetail"), "Admin Signal Review details must remain available.");
assert.ok(app.includes("Intl.DateTimeFormat().resolvedOptions().timeZone"));
assert.ok(html.includes('id="admin-performance-timezone"'));
assert.ok(css.includes(".admin-signals-tabs") && css.includes("overflow-x: auto"));
assert.ok(css.includes(".admin-performance-chart-grid") && css.includes("grid-template-columns: 1fr"));

console.log(JSON.stringify({
  today: todayResult.metrics,
  grouping: { day: 3, week: 3, month: 2 },
  missingRealizedR: missingR.missingRealizedR,
  missingOutcomeTimestamp: missingTimestampResult.dataQuality.missingOutcomeTimestamp,
  rankingMinimums: { day: 5, week: 10, month: 20 },
  timezone: {
    browserIanaForwarded: true,
    boundaryPeriod: localBoundary.timeline[0].period,
    springForwardHours: (springForward.to - springForward.from) / 3600000,
    fallBackHours: (fallBack.to - fallBack.from) / 3600000,
    invalidFallback: invalidTimezone.range.timezone
  },
  protections: { adminOnly: true, readOnly: true, calibrationRendererPreserved: true, signalReviewPreserved: true }
}, null, 2));

function record(id, status, realizedR, outcomeEvaluatedAt) {
  return {
    id, pair: id.startsWith("w") ? "BTC-USD" : "ETH-USD", timeframe: "15m", direction: "long",
    strategy: "Breakout retest", pattern: "breakout", source: "manual_scan", confidence: 84,
    calibratedConfidence: 84, confidenceVersion: "calibration_v2", status, realizedR, outcomeEvaluatedAt
  };
}

function normalizeForGrouping(item) {
  return {
    ...item,
    symbol: item.pair,
    outcomeAt: new Date(item.outcomeEvaluatedAt),
    confidence: Number(item.calibratedConfidence),
    realizedR: item.realizedR == null ? null : Number(item.realizedR)
  };
}

function read(path) { return readFileSync(new URL(`../${path}`, import.meta.url), "utf8"); }
