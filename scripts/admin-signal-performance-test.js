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

const repository = read("src/modules/admin-signals/generatedSignalRepository.js");
const controller = read("src/modules/admin-signals/generatedSignalController.js");
const service = read("src/modules/admin-signals/generatedSignalService.js");
const html = read("public/index.html");
const css = read("public/styles.css");
const app = read("public/app.js");

assert.match(repository, /status IN \('Hit TP','Hit SL','Expired'\)/);
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
assert.ok(css.includes(".admin-signals-tabs") && css.includes("overflow-x: auto"));
assert.ok(css.includes(".admin-performance-chart-grid") && css.includes("grid-template-columns: 1fr"));

const outcomeRenderer = loadFrontendFunction(app, "renderAdminOutcomeChart", "renderAdminCumulativeRChart", { escapeHtml });
const winRateRenderer = loadFrontendFunction(app, "renderAdminWinRateChart", "renderAdminOutcomeChart", { escapeHtml, formatAdminPercent, formatSignedR, formatMaybeR });
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

assert.match(css, /\.admin-signals-page\s*{[^}]*--border:\s*var\(--line\);[^}]*--accent:\s*var\(--cyan\)/s, "Admin Signals must resolve its intended border and accent tokens.");
assert.match(css, /\.performance-bar-row \.tp\s*{\s*background:\s*var\(--green\);\s*}/);
assert.match(css, /\.performance-bar-row \.sl\s*{\s*background:\s*#ff6868;\s*}/);
assert.match(css, /\.performance-bar-row \.expired\s*{\s*background:\s*#7d8998;\s*}/);
assert.match(css, /\.performance-line-chart\s*{[^}]*overflow:\s*hidden;[^}]*pointer-events:\s*none;/s, "Cumulative markers must be clipped and removed from hit testing.");
assert.match(css, /\.admin-performance-chart\s*{[^}]*position:\s*relative;[^}]*overflow:\s*hidden;/s, "Charts must own and clip their visual children.");
assert.match(css, /\.admin-signals-tabs button\s*{[^}]*min-height:\s*44px;[^}]*cursor:\s*pointer;/s, "The full tab target must remain usable on desktop and mobile.");
assert.match(css, /\.admin-generated-row\s*{[^}]*border-bottom:\s*1px solid var\(--border\);/s, "Pre-upgrade row separators must remain visible.");

console.log(JSON.stringify({
  today: todayResult.metrics,
  grouping: { day: 3, week: 3, month: 2 },
  missingRealizedR: missingR.missingRealizedR,
  missingOutcomeTimestamp: missingTimestampResult.dataQuality.missingOutcomeTimestamp,
  reconciliation: { allTerminal: mixedAll.metrics.signals, timelinePlaceable: mixedAll.dataQuality.timelineRecordsConsidered, winRate: mixedAll.metrics.winRate },
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatAdminPercent(value) { return value == null ? "n/a" : `${Number(value).toFixed(1)}%`; }
function formatSignedR(value) { const number = Number(value || 0); return `${number > 0 ? "+" : ""}${number.toFixed(2)}R`; }
function formatMaybeR(value) { return value == null ? "n/a" : `${Number(value).toFixed(2)}R`; }

function read(path) { return readFileSync(new URL(`../${path}`, import.meta.url), "utf8"); }
