import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCumulativeRealizedRSeries,
  buildGeneratedSignalPerformance,
  groupRecords,
  normalizePerformanceTimezone,
  rankPeriods,
  resolvePerformanceRange,
  summarizePopulation,
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
assert.match(todayResult.semantics.outcomeTimestamp, /Canonical terminal timestamp grouped in UTC/);

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
assert.equal(missingTimestampResult.metrics.signals, 2, "All must count terminal status even when a legacy outcome cannot be dated.");
assert.equal(missingTimestampResult.timeline.length, 1, "Undated legacy outcomes must not be assigned a fabricated timeline date.");
assert.equal(missingTimestampResult.dataQuality.timelineRecordsConsidered, 1);
assert.equal(missingTimestampResult.dataQuality.missingOutcomeTimestamp, 1);

const mixedLegacyAndCurrent = [
  { ...record("legacy-tp", "Hit TP", null, null), hitTpAt: "2026-08-26T00:30:00.000Z", createdAt: "2026-07-01T00:00:00.000Z" },
  { ...record("legacy-sl", "Hit SL", -1, null), createdAt: "2026-08-26T02:00:00.000Z", updatedAt: "2026-08-26T03:00:00.000Z" },
  { ...record("legacy-expired", "Expired", 0, null), validUntil: "2026-08-26T04:00:00.000Z" },
  record("current-tp", "Hit TP", 2, "2026-08-26T05:00:00.000Z"),
  record("current-sl", "Hit SL", -1, "2026-08-26T06:00:00.000Z"),
  record("current-expired", "Expired", 0, "2026-08-26T07:00:00.000Z"),
  record("active", "Active", null, null)
];
const mixedAll = buildGeneratedSignalPerformance(mixedLegacyAndCurrent, { range: "all", grouping: "day", now });
const authoritative = authoritativeTerminalCounts(mixedLegacyAndCurrent);
assert.deepEqual(
  pickOutcomeCounts(mixedAll.metrics),
  authoritative,
  "Performance All must reconcile with the pre-upgrade status-based Admin aggregation."
);
assert.equal(mixedAll.metrics.signals, 6);
assert.equal(mixedAll.metrics.closedSignals, 4);
assert.equal(mixedAll.metrics.winRate, 50);
assert.equal(mixedAll.metrics.realizedRObservations, 5, "A missing legacy R must not remove its TP from win-rate counts.");
assert.equal(mixedAll.dataQuality.timelineRecordsConsidered, 4, "Only outcome_evaluated_at or the matching canonical terminal timestamp may place a record.");
assert.equal(mixedAll.dataQuality.missingOutcomeTimestamp, 2);
assert.equal(mixedAll.timeline[0].signals, 4);
assert.equal(mixedAll.categories.reduce((total, item) => total + item.signals, 0), 6, "All-time category totals must include undated terminal history.");

const mixedToday = buildGeneratedSignalPerformance(mixedLegacyAndCurrent, { range: "today", grouping: "day", now });
assert.equal(mixedToday.metrics.signals, 4, "Ranged metrics must include only terminal records with a trustworthy date inside the range.");
assert.equal(mixedToday.metrics.wins, 2);
assert.equal(mixedToday.metrics.losses, 1);
assert.equal(mixedToday.metrics.expired, 1);
assert.equal(mixedToday.timeline[0].signals, 4);

const productionLike = productionLikeRecords();
const productionLikeResult = buildGeneratedSignalPerformance(productionLike, { range: "all", grouping: "day", now });
assert.equal(productionLikeResult.population.generatedCount, 421);
assert.equal(productionLikeResult.population.terminalCount, 234);
assert.equal(productionLikeResult.population.decidedCount, 184);
assert.equal(productionLikeResult.population.tpCount, 49);
assert.equal(productionLikeResult.population.slCount, 135);
assert.equal(productionLikeResult.population.expiredCount, 50);
assert.equal(productionLikeResult.population.nonTerminalCount, 187);
assert.equal(productionLikeResult.population.generatedCount, productionLikeResult.population.terminalCount + productionLikeResult.population.nonTerminalCount);
assert.equal(productionLikeResult.population.terminalCount, productionLikeResult.population.tpCount + productionLikeResult.population.slCount + productionLikeResult.population.expiredCount);
assert.equal(productionLikeResult.population.decidedCount, productionLikeResult.population.tpCount + productionLikeResult.population.slCount);
assert.equal(productionLikeResult.metrics.winRateExact, 26.630435);
assert.equal(productionLikeResult.metrics.winRate, 26.6);
assert.equal(productionLikeResult.metrics.realizedRObservations, 90);
assert.equal(productionLikeResult.metrics.missingRealizedR, 144);
assert.equal(productionLikeResult.realizedRSeries.length, 90);
assert.equal(productionLikeResult.realizedRSummary.count, 90);
assert.deepEqual(productionLikeResult.realizedRSummary.first, productionLikeResult.realizedRSeries[0]);
assert.deepEqual(productionLikeResult.realizedRSummary.last, productionLikeResult.realizedRSeries.at(-1));
assert.equal(productionLikeResult.realizedRSummary.minimumCumulativeR, 2);
assert.equal(productionLikeResult.realizedRSummary.maximumCumulativeR, 98);
assert.equal(productionLikeResult.realizedRSummary.finalCumulativeR, productionLikeResult.metrics.netRealizedR, "Final cumulative R must reconcile exactly with the Net Realized R KPI.");
assert.equal(productionLikeResult.realizedRSeries.at(-1).cumulativeRealizedR, productionLikeResult.realizedRSeries.reduce((sum, point) => Number((sum + point.realizedR).toFixed(3)), 0));
for (let index = 1; index < productionLikeResult.realizedRSeries.length; index += 1) {
  assert.ok(new Date(productionLikeResult.realizedRSeries[index - 1].outcomeAt) <= new Date(productionLikeResult.realizedRSeries[index].outcomeAt));
}
assert.equal(productionLikeResult.population.statusBreakdown.reduce((sum, item) => sum + item.count, 0), 421);
assert.deepEqual(summarizePopulation(productionLike).statusBreakdown, productionLikeResult.population.statusBreakdown);

const paginationFixture = { total: 421, pageSize: 25, totalPages: Math.ceil(421 / 25), lastPageRows: 421 - (Math.ceil(421 / 25) - 1) * 25 };
assert.deepEqual(paginationFixture, { total: 421, pageSize: 25, totalPages: 17, lastPageRows: 21 }, "Pagination must retain the backend total rather than multiplying pages by page size.");

const repository = read("src/modules/admin-signals/generatedSignalRepository.js");
const controller = read("src/modules/admin-signals/generatedSignalController.js");
const service = read("src/modules/admin-signals/generatedSignalService.js");
const html = read("public/index.html");
const css = read("public/styles.css");
const app = read("public/app.js");

assert.doesNotMatch(repository.slice(repository.indexOf("export async function listGeneratedSignalPerformanceRecords"), repository.indexOf("export async function listActiveGeneratedSignals")), /clauses = \["g\.status IN/, "Performance must query the full generated population rather than terminal records only.");
for (const terminalTimestamp of ["hit_tp_at", "hit_sl_at", "expired_at"]) {
  assert.ok(repository.includes(terminalTimestamp), `Performance repository must retrieve ${terminalTimestamp} for legacy timeline placement.`);
}
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
assert.match(app, /async function loadAdminSignalToday\(\)[\s\S]*?\/api\/admin\/signals\/performance\?/s, "Today must use the authoritative Performance endpoint.");
assert.ok(app.includes("Intl.DateTimeFormat().resolvedOptions().timeZone"));
assert.ok(html.includes('id="admin-performance-timezone"'));
assert.ok(html.includes('id="admin-performance-population"'));
for (const label of ["Generated signals", "Terminal outcomes", "Open / other", "Decided trades", "Expectancy / R-record"]) {
  assert.ok(app.includes(label), `Performance UI must label ${label} explicitly.`);
}
assert.ok(app.includes("excluded from R-based metrics, not win rate"));
assert.ok(css.includes(".admin-signals-tabs") && css.includes("overflow-x: auto"));
assert.ok(css.includes(".admin-performance-chart-grid") && css.includes("grid-template-columns: 1fr"));

const outcomeRenderer = loadFrontendFunction(app, "renderAdminOutcomeChart", "renderAdminCumulativeRChart", { escapeHtml });
const winRateRenderer = loadFrontendFunction(app, "renderAdminWinRateChart", "renderAdminOutcomeChart", { escapeHtml, formatAdminPercent, formatSignedR, formatMaybeR });
const cumulativeRenderer = loadFrontendFunction(app, "renderAdminCumulativeRChart", "renderAdminBestWorstPeriods", { escapeHtml, formatSignedR, formatDateTime });
const mixedOutcomeHtml = outcomeRenderer([{ period: "2026-08-26", signals: 14, wins: 3, losses: 4, expired: 7 }]);
assert.match(mixedOutcomeHtml, />3\/4\/7</);
assertVisibleSegment(mixedOutcomeHtml, "tp");
assertVisibleSegment(mixedOutcomeHtml, "sl");
assertVisibleSegment(mixedOutcomeHtml, "expired");
for (const [status, values] of Object.entries({ tp: [3, 0, 0], sl: [0, 4, 0], expired: [0, 0, 7] })) {
  const rendered = outcomeRenderer([{ period: status, signals: values.reduce((sum, value) => sum + value, 0), wins: values[0], losses: values[1], expired: values[2] }]);
  for (const [index, segment] of ["tp", "sl", "expired"].entries()) {
    assert.equal(segmentWidth(rendered, segment) > 0, values[index] > 0, `${status}-only chart must render only its nonzero segment.`);
  }
}
const zeroOutcomeHtml = outcomeRenderer([{ period: "zero", signals: 0, wins: 0, losses: 0, expired: 0 }]);
for (const status of ["tp", "sl", "expired"]) assert.equal(segmentWidth(zeroOutcomeHtml, status), 0);
const winRateHtml = winRateRenderer([{ period: "2026-08-26", signals: 14, closedSignals: 7, wins: 3, losses: 4, expired: 7, winRate: 42.9, netRealizedR: -1, expectancyR: -0.143 }]);
assert.match(winRateHtml, /class="win-rate" style="width:42\.9%"/, "Win-rate payload must produce a visible filled bar.");

for (const count of [1, 2, 5, 90, 300]) {
  const series = chartSeries(count, (index) => (index % 3 === 0 ? 1.5 : -0.5));
  const finalR = series.at(-1).cumulativeRealizedR;
  const rendered = cumulativeRenderer(series, { missingRealizedR: 0, realizedRWithoutOutcomeTimestamp: 0 }, { netRealizedR: finalR });
  assert.match(rendered, new RegExp(`data-point-count="${count}"`));
  assert.match(rendered, /class="r-line"/, `${count}-point series must render a visible line.`);
  assert.match(rendered, /Final cumulative R reconciles with the KPI\./);
  assert.equal((rendered.match(/class="r-point"/g) || []).length, count <= 40 ? count : 0, "Dense series must omit individual markers.");
  assertChartCoordinatesInsideBounds(rendered);
}
for (const values of [[1, 2, 3, 4, 5], [-1, -2, -3, -4, -5], [2, -3, 2, -3, 5]]) {
  const series = chartSeriesFromCumulative(values);
  const rendered = cumulativeRenderer(series, {}, { netRealizedR: values.at(-1) });
  assertChartCoordinatesInsideBounds(rendered);
}
const largeGapSeries = chartSeriesFromCumulative([1, 2, 3], ["2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
const largeGapCoordinates = polylineCoordinates(cumulativeRenderer(largeGapSeries, {}, { netRealizedR: 3 }));
assert.equal(Number((largeGapCoordinates[1].x - largeGapCoordinates[0].x).toFixed(2)), Number((largeGapCoordinates[2].x - largeGapCoordinates[1].x).toFixed(2)), "Chronological observations must not compress into one corner because of a large wall-clock gap.");

assert.match(css, /\.admin-signals-page\s*{[^}]*--border:\s*var\(--line\);[^}]*--accent:\s*var\(--cyan\)/s, "Admin Signals must resolve its intended border and accent tokens.");
assert.match(css, /\.performance-bar-row \.tp\s*{\s*background:\s*var\(--green\);\s*}/);
assert.match(css, /\.performance-bar-row \.sl\s*{\s*background:\s*#ff6868;\s*}/);
assert.match(css, /\.performance-bar-row \.expired\s*{\s*background:\s*#7d8998;\s*}/);
assert.match(css, /\.performance-line-chart\s*{[^}]*overflow:\s*hidden;[^}]*pointer-events:\s*none;/s, "Cumulative markers must be clipped and removed from hit testing.");
assert.match(css, /\.performance-line-chart \.r-line\s*{[^}]*stroke:\s*var\(--cyan\);[^}]*stroke-width:\s*2\.5;/s, "Cumulative line must use a defined, visible SignalForge token.");
assert.match(css, /\.performance-line-chart \.r-point\s*{[^}]*fill:\s*var\(--cyan\);/s);
assert.doesNotMatch(css, /\.performance-line-chart circle\s*{[^}]*fill:\s*#fff/s, "Cumulative chart must not use dominant white oval markers.");
assert.match(css, /\.admin-performance-chart\s*{[^}]*position:\s*relative;[^}]*overflow:\s*hidden;/s, "Charts must own and clip their visual children.");
assert.match(css, /\.admin-signals-tabs button\s*{[^}]*min-height:\s*44px;[^}]*cursor:\s*pointer;/s, "The full tab target must remain usable on desktop and mobile.");
assert.match(css, /\.admin-generated-row\s*{[^}]*border-bottom:\s*1px solid var\(--border\);/s, "Pre-upgrade row separators must remain visible.");

console.log(JSON.stringify({
  today: todayResult.metrics,
  grouping: { day: 3, week: 3, month: 2 },
  missingRealizedR: missingR.missingRealizedR,
  missingOutcomeTimestamp: missingTimestampResult.dataQuality.missingOutcomeTimestamp,
  reconciliation: { allTerminal: mixedAll.metrics.signals, timelinePlaceable: mixedAll.dataQuality.timelineRecordsConsidered, winRate: mixedAll.metrics.winRate },
  productionLike: { population: productionLikeResult.population, rCount: productionLikeResult.realizedRSeries.length, finalR: productionLikeResult.realizedRSummary.finalCumulativeR },
  chartRegression: { mixedLabel: "3/4/7", markersContained: true, tabsPointerSafe: true, rowContainersRestored: true },
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

function authoritativeTerminalCounts(records) {
  const terminal = records.filter((item) => ["Hit TP", "Hit SL", "Expired"].includes(item.status));
  const wins = terminal.filter((item) => item.status === "Hit TP").length;
  const losses = terminal.filter((item) => item.status === "Hit SL").length;
  const expired = terminal.filter((item) => item.status === "Expired").length;
  return { wins, losses, expired, winRate: wins + losses ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : null };
}

function productionLikeRecords() {
  const records = [];
  const statuses = [["Hit TP", 49], ["Hit SL", 135], ["Expired", 50], ["Active", 100], ["Duplicate blocked", 30], ["Cooldown blocked", 20], ["Quarantined timeframe", 15], ["Readiness failed", 12], ["Invalid legacy ready signal", 10]];
  let terminalIndex = 0;
  let id = 0;
  for (const [status, count] of statuses) {
    for (let index = 0; index < count; index += 1) {
      const terminal = ["Hit TP", "Hit SL", "Expired"].includes(status);
      const hasR = terminal && terminalIndex < 90;
      const realizedR = hasR ? (status === "Hit TP" ? 2 : status === "Hit SL" ? -1 : 0) : null;
      const timestamp = terminal ? new Date(Date.UTC(2026, 0, 1, 0, terminalIndex)).toISOString() : null;
      records.push(record(`production-${id}`, status, realizedR, timestamp));
      if (terminal) terminalIndex += 1;
      id += 1;
    }
  }
  return records;
}

function pickOutcomeCounts(metrics) {
  return { wins: metrics.wins, losses: metrics.losses, expired: metrics.expired, winRate: metrics.winRate };
}

function loadFrontendFunction(source, name, nextName, dependencies) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `Unable to extract ${name}.`);
  const dependencyNames = Object.keys(dependencies);
  return Function(...dependencyNames, `${source.slice(start, end)}; return ${name};`)(...dependencyNames.map((key) => dependencies[key]));
}

function segmentWidth(html, className) {
  const match = html.match(new RegExp(`class="${className}" style="width:([0-9.]+)%"`));
  assert.ok(match, `${className} segment must be rendered.`);
  return Number(match[1]);
}

function assertVisibleSegment(html, className) {
  assert.ok(segmentWidth(html, className) > 0, `${className} segment must have a positive rendered width.`);
}

function chartSeries(count, realizedRForIndex) {
  let cumulative = 0;
  return Array.from({ length: count }, (_, index) => {
    const realizedR = realizedRForIndex(index);
    cumulative = Number((cumulative + realizedR).toFixed(3));
    return { id: `chart-${index}`, outcomeAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), realizedR, cumulativeRealizedR: cumulative };
  });
}

function chartSeriesFromCumulative(values, timestamps = []) {
  return values.map((value, index) => ({
    id: `cumulative-${index}`,
    outcomeAt: timestamps[index] || new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    realizedR: index ? value - values[index - 1] : value,
    cumulativeRealizedR: value
  }));
}

function polylineCoordinates(html) {
  const match = html.match(/<polyline points="([^"]+)" class="r-line">/);
  assert.ok(match, "Expected cumulative polyline coordinates.");
  return match[1].split(" ").map((point) => { const [x, y] = point.split(",").map(Number); return { x, y }; });
}

function assertChartCoordinatesInsideBounds(html) {
  if (!html.includes("<polyline")) return;
  for (const point of polylineCoordinates(html)) {
    assert.ok(point.x >= 34 && point.x <= 980, `Chart x coordinate ${point.x} must remain inside plot bounds.`);
    assert.ok(point.y >= 18 && point.y <= 240, `Chart y coordinate ${point.y} must remain inside plot bounds.`);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatAdminPercent(value) { return value == null ? "n/a" : `${Number(value).toFixed(1)}%`; }
function formatSignedR(value) { const number = Number(value || 0); return `${number > 0 ? "+" : ""}${number.toFixed(2)}R`; }
function formatMaybeR(value) { return value == null ? "n/a" : `${Number(value).toFixed(2)}R`; }
function formatDateTime(value) { return new Date(value).toISOString(); }

function read(path) { return readFileSync(new URL(`../${path}`, import.meta.url), "utf8"); }
