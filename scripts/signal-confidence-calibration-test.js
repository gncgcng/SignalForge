import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyCalibrationContext,
  analyzeConfidenceBucketCalibration,
  bestGroups,
  breakEvenWinRate,
  calculateClosedWinRate,
  calculateGroupStatus,
  calculateQualityAdjustedScore,
  calibrationStatusForGroup,
  isSignalBlockedByCalibration,
  normalizeCalibrationGroupScope,
  normalizeSignalGroupStatusInput,
  sampleSizeStatusForGroup,
  underconfidentWinners
} from "../src/modules/signals/signalConfidenceCalibrationService.js";

const service = readFileSync("src/modules/signals/signalConfidenceCalibrationService.js", "utf8");
const signalService = readFileSync("src/modules/signals/signalService.js", "utf8");
const autoScanService = readFileSync("src/modules/alerts/autoScanService.js", "utf8");
const repository = readFileSync("src/modules/admin-signals/generatedSignalRepository.js", "utf8");
const controller = readFileSync("src/modules/admin-signals/generatedSignalController.js", "utf8");
const app = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");
const migration = readFileSync("migrations/050_signal_confidence_calibration.sql", "utf8");
const calibratedMigration = readFileSync("migrations/053_generated_signal_calibrated_confidence.sql", "utf8");
const directionScopeMigration = readFileSync("migrations/058_broad_direction_quarantine_scope.sql", "utf8");
const quality = readFileSync("src/modules/signals/signalQualityService.js", "utf8");

assert.equal(breakEvenWinRate(2.42), 29.2, "break-even win rate should use 1 / (1 + average RR)");
assert.equal(calculateClosedWinRate(18, 59), 23.4, "expired signals must be excluded from normal win rate");
assert.ok(calculateQualityAdjustedScore({ hitTp: 18, hitSl: 59, expired: 17 }) < calculateQualityAdjustedScore({ hitTp: 18, hitSl: 59, expired: 0 }), "expired signals should reduce quality score");

const poorStrategy = calculateGroupStatus({
  closedSignals: 20,
  hitTp: 4,
  hitSl: 16,
  totalSignals: 26,
  expiredRate: 23,
  winRate: 20,
  breakEvenWinRate: 33.3,
  estimatedExpectancy: -0.35,
  confidenceGap: 68
});
assert.equal(poorStrategy.status, "reduced_confidence");
assert.equal(poorStrategy.penalty, -10);

const veryPoor = calculateGroupStatus({
  closedSignals: 28,
  hitTp: 4,
  hitSl: 22,
  totalSignals: 31,
  expiredRate: 16,
  winRate: 15.4,
  breakEvenWinRate: 31,
  estimatedExpectancy: -0.55,
  confidenceGap: 70
});
assert.equal(veryPoor.status, "quarantined");
assert.equal(veryPoor.confidenceCap, 68);

const baseSignal = {
  symbol: "BTC-USD",
  timeframe: "15m",
  direction: "long",
  setupType: "Breakout Retest",
  confidenceScore: 91,
  riskRewardRatio: 1.8,
  alignmentBadge: "Partial Alignment",
  indicators: { regime: "Range", readinessScore: 84 },
  confirmations: [{ name: "Volume", passed: false }]
};

const noHistory = applyCalibrationContext(baseSignal, { noHistory: true, groups: [] });
assert.equal(noHistory.confidenceScore, 72, "choppy/range cap should dominate weaker no-history cap");
assert.equal(noHistory.confidenceCalibration.rawSetupScore, 91);
assert.equal(noHistory.confidenceCalibration.calibratedConfidence, 72);
assert.equal(noHistory.confidenceCalibration.version, "calibration_v2");
assert.ok(noHistory.indicators.confidenceCalibration.caps.some((item) => item.cap === 82));
assert.ok(noHistory.indicators.confidenceCalibration.caps.some((item) => item.cap === 80));
assert.ok(noHistory.indicators.confidenceCalibration.caps.some((item) => item.cap === 72));
assert.equal(noHistory.indicators.confidenceCalibration.status, "insufficient_data");
assert.equal(noHistory.indicators.confidenceCalibration.primaryDecisionReason, "insufficient_historical_data");
assert.notEqual(noHistory.confidenceScore, 0);
assert.notEqual(noHistory.confidenceScore, 50);

const highQualityNoHistory = applyCalibrationContext({
  symbol: "BTC-USD",
  timeframe: "15m",
  direction: "long",
  setupType: "Trend Continuation",
  rawConfidence: 90,
  qualityScore: 100,
  readinessScore: 100,
  entryQuality: "excellent",
  riskRewardRatio: 2.2,
  alignmentBadge: "Full Alignment",
  confluenceScore: 90,
  confirmations: [{ name: "Volume", passed: true }],
  indicators: { regime: "Trend Up", readinessScore: 100 }
}, { noHistory: true, groups: [] });
assert.equal(highQualityNoHistory.rawSetupScore, 90);
assert.equal(highQualityNoHistory.confidenceScore, 82);
assert.equal(highQualityNoHistory.calibratedConfidence, 82);
assert.equal(highQualityNoHistory.confidenceCalibration.status, "insufficient_data");
assert.notEqual(highQualityNoHistory.confidenceScore, 50);

const underperforming = applyCalibrationContext({ ...baseSignal, confidenceScore: 92, indicators: { readinessScore: 95 }, alignmentBadge: "Full Alignment", confirmations: [{ name: "Volume", passed: true }] }, {
  noHistory: false,
  groups: [
    { groupKey: "strategy:breakout-retest", groupType: "strategy", groupValue: "Breakout Retest", closedSignals: 20, winRate: 20, breakEvenWinRate: 33, estimatedExpectancy: -0.4, expiredRate: 20, status: "reduced_confidence", penalty: -10 },
    { groupKey: "pair_timeframe:btc-usd:15m", groupType: "pair_timeframe", groupValue: "BTC-USD:15m", closedSignals: 20, winRate: 20, breakEvenWinRate: 33, estimatedExpectancy: -0.4, expiredRate: 20, status: "reduced_confidence", penalty: -10 }
  ]
});
assert.equal(underperforming.confidenceScore, 68, "strategy plus pair/timeframe underperformance should cap confidence at 68");
assert.ok(underperforming.confidenceCalibration.penalties.length >= 2);

const broadWeaknessDoesNotCollapse = applyCalibrationContext({
  ...baseSignal,
  confidenceScore: 70,
  riskRewardRatio: 2.4,
  alignmentBadge: "Full Alignment",
  indicators: { regime: "Trend Up", readinessScore: 90, entryQuality: "good" },
  confirmations: [{ name: "Volume", passed: true }]
}, {
  noHistory: false,
  groups: [
    { groupKey: "strategy:broad", groupType: "strategy", groupValue: "Broad", closedSignals: 12, winRate: 25, breakEvenWinRate: 33, estimatedExpectancy: -0.2, expiredRate: 10, status: "watchlist", penalty: -10 },
    { groupKey: "pair:broad", groupType: "pair", groupValue: "BTC-USD", closedSignals: 12, winRate: 25, breakEvenWinRate: 33, estimatedExpectancy: -0.2, expiredRate: 10, status: "watchlist", penalty: -10 },
    { groupKey: "direction:broad", groupType: "direction", groupValue: "long", closedSignals: 12, winRate: 25, breakEvenWinRate: 33, estimatedExpectancy: -0.2, expiredRate: 10, status: "watchlist", penalty: -10 }
  ]
});
assert.equal(broadWeaknessDoesNotCollapse.confidenceScore, 58, "multiple broad weak groups may reduce confidence without a hardcoded 50 floor");
assert.equal(broadWeaknessDoesNotCollapse.confidenceCalibration.totalPenalty, -12);
assert.equal(broadWeaknessDoesNotCollapse.confidenceCalibration.unboundedPenalty, -23, "direction contributes at most a three-point diagnostic penalty");

const blocked = applyCalibrationContext({ ...baseSignal, confidenceScore: 90, riskRewardRatio: 2.4, indicators: { readinessScore: 95 }, alignmentBadge: "Full Alignment", confirmations: [{ name: "Volume", passed: true }] }, {
  noHistory: false,
  groups: [{ groupKey: "strategy:bad", groupType: "strategy", groupValue: "Bad Strategy", closedSignals: 25, status: "quarantined", penalty: -15, confidenceCap: 72 }]
});
assert.equal(blocked.indicators.confidenceCalibration.blocked, false, "broad quarantined groups should cap confidence but not hard-block every ready signal");

const exactBlocked = applyCalibrationContext({ ...baseSignal, confidenceScore: 90, riskRewardRatio: 2.4, indicators: { readinessScore: 95 }, alignmentBadge: "Full Alignment", confirmations: [{ name: "Volume", passed: true }] }, {
  noHistory: false,
  groups: [{
    groupKey: "exact_signal_context:manual-scan:breakout-retest:btc-usd:15m:long:range",
    groupType: "exact_signal_context",
    groupValue: "manual_scan:Breakout Retest:BTC-USD:15m:long:Range",
    closedSignals: 32,
    estimatedExpectancy: -0.62,
    status: "quarantined",
    penalty: -15,
    confidenceCap: 68
  }]
});
assert.equal(exactBlocked.indicators.confidenceCalibration.blocked, true, "exact underperforming contexts with enough closed signals can block promotion/alerts");
assert.equal(isSignalBlockedByCalibration(exactBlocked), true, "specific exact-context quarantine remains a hard block");

const exactMediumSample = applyCalibrationContext({
  ...baseSignal,
  confidenceScore: 86,
  riskRewardRatio: 2.4,
  indicators: { readinessScore: 95, regime: "Trend Up" },
  alignmentBadge: "Full Alignment",
  confirmations: [{ name: "Volume", passed: true }]
}, {
  noHistory: false,
  groups: [{
    groupKey: "exact_signal_context:auto-crypto-watcher:trend-continuation:btc-usd:15m:long:trend-up",
    groupType: "exact_signal_context",
    groupValue: "auto_crypto_watcher:Trend Continuation:BTC-USD:15m:long:Trend Up",
    closedSignals: 24,
    winRate: 20,
    breakEvenWinRate: 33,
    estimatedExpectancy: -0.35,
    status: "reduced_confidence",
    penalty: -6,
    confidenceCap: 75
  }]
});
assert.equal(exactMediumSample.confidenceCalibration.blocked, false, "20-29 exact samples may penalize but cannot hard-block");
assert.equal(exactMediumSample.confidenceCalibration.status, "reduced_confidence");
assert.equal(isSignalBlockedByCalibration(exactMediumSample), false);

for (const direction of ["long", "short"]) {
  const directionOnly = applyCalibrationContext({
    ...baseSignal,
    direction,
    confidenceScore: 80,
    riskRewardRatio: 2.4,
    alignmentBadge: "Full Alignment",
    indicators: { regime: "Trend Up", readinessScore: 95, entryQuality: "excellent" },
    confirmations: [{ name: "Volume", passed: true }]
  }, {
    noHistory: false,
    groups: [{
      groupKey: `direction:${direction}`,
      groupType: "direction",
      groupValue: direction,
      closedSignals: 37,
      winRate: 20,
      breakEvenWinRate: 29,
      estimatedExpectancy: -0.38,
      status: "quarantined",
      penalty: -15,
      confidenceCap: 68
    }]
  });
  assert.equal(directionOnly.confidenceScore, 77, `${direction} weakness should apply no more than a three-point penalty`);
  assert.equal(directionOnly.confidenceCalibration.status, "watchlist", `${direction} weakness may warn but must not quarantine the signal`);
  assert.equal(directionOnly.confidenceCalibration.blocked, false, `${direction} direction must not hard-block promotion`);
  assert.equal(isSignalBlockedByCalibration(directionOnly), false, `${direction} direction must not hard-block alerts`);
  assert.equal(directionOnly.confidenceCalibration.groups[0].diagnosticOnly, true);
  assert.equal(directionOnly.confidenceCalibration.groups[0].hardBlockEligible, false);
}

const staleDirectionOverride = normalizeCalibrationGroupScope({
  groupKey: "direction:short",
  groupType: "direction",
  groupValue: "short",
  status: "disabled_by_admin",
  penalty: -15,
  confidenceCap: 68
});
assert.equal(staleDirectionOverride.status, "diagnostic_only");
assert.equal(staleDirectionOverride.penalty, -3);
assert.equal(staleDirectionOverride.confidenceCap, null);
const directionAdminWrite = normalizeSignalGroupStatusInput({
  groupKey: "direction:long",
  status: "quarantined",
  penaltyOverride: -15,
  confidenceCapOverride: 68
});
assert.equal(directionAdminWrite.status, "diagnostic_only", "admin API cannot hard-quarantine a broad direction");
assert.equal(directionAdminWrite.penaltyOverride, -3, "admin direction penalty is capped at three points");
assert.equal(directionAdminWrite.confidenceCapOverride, null, "broad direction cannot impose a confidence cap");
assert.match(directionAdminWrite.adminNote, /too broad to hard quarantine/i);
assert.equal(isSignalBlockedByCalibration({
  confidenceCalibration: {
    status: "quarantined",
    blockingEvidence: { groupType: "direction", groupValue: "long", hardBlockEligible: true }
  }
}), false, "stale direction quarantine evidence must not block");
assert.equal(isSignalBlockedByCalibration({
  confidenceCalibration: {
    status: "disabled_by_admin",
    groups: [{ groupKey: "direction:short", groupType: "direction", status: "disabled_by_admin" }]
  }
}), false, "legacy calibration JSON without blocking evidence must not block when direction is the only broad group");

const calibrationError = applyCalibrationContext({
  symbol: "BTC-USD",
  timeframe: "15m",
  direction: "long",
  setupType: "Trend Continuation",
  qualityScore: 0
}, { noHistory: true, groups: [] });
assert.equal(calibrationError.confidenceCalibration.status, "calibration_error");
assert.equal(calibrationError.calibratedConfidence, null);
assert.equal(calibrationError.confidenceCalibration.primaryDecisionReason, "calibration_error");
assert.notEqual(calibrationError.confidenceScore, 50);
assert.equal(isSignalBlockedByCalibration(calibrationError), true);

const sampleGroups = [
  { groupKey: "strategy:tiny", groupType: "strategy", groupValue: "Tiny Winner", closedSignals: 3, winRate: 100, breakEvenWinRate: 30, estimatedExpectancy: 2.1, expiredRate: 0, confidenceGap: -10 },
  { groupKey: "strategy:steady", groupType: "strategy", groupValue: "Steady Retest", closedSignals: 30, winRate: 48, breakEvenWinRate: 28, estimatedExpectancy: 0.52, expiredRate: 5, confidenceGap: 2 },
  { groupKey: "strategy:hot", groupType: "strategy", groupValue: "Hot But Smaller", closedSignals: 7, winRate: 70, breakEvenWinRate: 35, estimatedExpectancy: 0.32, expiredRate: 0, confidenceGap: -8 }
];
assert.equal(bestGroups(sampleGroups, "strategy")[0].groupValue, "Steady Retest", "best sorting must prioritize expectancy and sample size, not tiny 100% records");
assert.ok(!bestGroups(sampleGroups, "strategy").some((group) => group.groupValue === "Tiny Winner"), "best groups require at least 5 closed samples");
assert.equal(underconfidentWinners([
  { groupKey: "strategy:under", groupType: "strategy", groupValue: "Undertrusted", closedSignals: 12, winRate: 50, breakEvenWinRate: 30, estimatedExpectancy: 0.4, averageConfidence: 72, expiredRate: 4, confidenceGap: 22 },
  { groupKey: "strategy:trusted", groupType: "strategy", groupValue: "Already Trusted", closedSignals: 12, winRate: 50, breakEvenWinRate: 30, estimatedExpectancy: 0.4, averageConfidence: 88, expiredRate: 4, confidenceGap: -38 }
])[0].groupValue, "Undertrusted");

const recovered = applyCalibrationContext({
  ...baseSignal,
  confidenceScore: 90,
  riskRewardRatio: 2.4,
  alignmentBadge: "Full Alignment",
  confluenceScore: 82,
  indicators: { regime: "Trend Up", readinessScore: 95, entryQuality: "excellent" },
  entryQuality: "excellent",
  confirmations: [{ name: "Volume", passed: true }]
}, {
  noHistory: true,
  groups: [{ groupKey: "strategy:steady", groupType: "strategy", groupValue: "Steady Retest", closedSignals: 30, winRate: 48, breakEvenWinRate: 28, estimatedExpectancy: 0.52, expiredRate: 5, confidenceCapLift: 5, status: "active" }]
});
assert.equal(recovered.confidenceScore, 87, "insufficient exact history keeps a small uncertainty penalty even with broad positive history");
assert.ok(recovered.indicators.confidenceCalibration.caps.some((item) => item.cap === 88));

const exactRecovered = applyCalibrationContext({
  ...baseSignal,
  generationSource: "manual_scan",
  confidenceScore: 94,
  riskRewardRatio: 2.4,
  alignmentBadge: "Full Alignment",
  confluenceScore: 82,
  indicators: { regime: "Trend Up", readinessScore: 95, entryQuality: "excellent", generationSource: "manual_scan" },
  entryQuality: "excellent",
  confirmations: [{ name: "Volume", passed: true }]
}, {
  noHistory: false,
  groups: [{
    groupKey: "source_strategy_timeframe:manual-scan:breakout-retest:15m",
    groupType: "source_strategy_timeframe",
    groupValue: "manual_scan:Breakout Retest:15m",
    closedSignals: 24,
    winRate: 54,
    breakEvenWinRate: 32,
    estimatedExpectancy: 0.42,
    expiredRate: 4,
    confidenceCapLift: 5,
    status: "active"
  }]
});
assert.equal(exactRecovered.confidenceScore, 88, "even exact source/strategy/timeframe proof cannot bypass the high-confidence bucket and timeframe caps yet");
assert.ok(exactRecovered.indicators.confidenceCalibration.caps.some((item) => item.cap === 88));

const invertedBuckets = analyzeConfidenceBucketCalibration([
  { groupKey: "confidence_bucket:70-79", groupType: "confidence_bucket", groupValue: "70-79", closedSignals: 12, winRate: 45, breakEvenWinRate: 30, estimatedExpectancy: 0.25, expiredRate: 5, confidenceGap: 30 },
  { groupKey: "confidence_bucket:80-89", groupType: "confidence_bucket", groupValue: "80-89", closedSignals: 12, winRate: 35, breakEvenWinRate: 30, estimatedExpectancy: 0.05, expiredRate: 5, confidenceGap: 50 },
  { groupKey: "confidence_bucket:90-100", groupType: "confidence_bucket", groupValue: "90-100", closedSignals: 12, winRate: 20, breakEvenWinRate: 30, estimatedExpectancy: -0.4, expiredRate: 12, confidenceGap: 72 }
]);
assert.equal(invertedBuckets.active, true);
assert.match(invertedBuckets.message, /higher confidence buckets are not outperforming lower buckets/i);
assert.equal(invertedBuckets.worstBucket.groupValue, "90-100");
assert.equal(sampleSizeStatusForGroup({ closedSignals: 9 }), "Small sample size. Do not trust this result yet.");
assert.equal(sampleSizeStatusForGroup({ closedSignals: 12 }), "Early data. Calibration may change.");
assert.equal(calibrationStatusForGroup({ closedSignals: 12, winRate: 20, breakEvenWinRate: 30, estimatedExpectancy: -0.2 }), "Overconfident");

const stillCappedByRules = applyCalibrationContext({
  ...baseSignal,
  confidenceScore: 90,
  riskRewardRatio: 2.4,
  alignmentBadge: "Full Alignment",
  confluenceScore: 82,
  indicators: { regime: "Trend Up", readinessScore: 95, entryQuality: "excellent" },
  entryQuality: "excellent",
  confirmations: [{ name: "Volume", passed: false }]
}, {
  noHistory: true,
  groups: [{ groupKey: "strategy:steady", groupType: "strategy", groupValue: "Steady Retest", closedSignals: 30, winRate: 48, breakEvenWinRate: 28, estimatedExpectancy: 0.52, expiredRate: 5, confidenceCapLift: 5, status: "active" }]
});
assert.equal(stillCappedByRules.confidenceScore, 80, "good performance cannot bypass weak-volume rule caps");

assert.match(migration, /CREATE TABLE IF NOT EXISTS signal_performance_groups/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS signal_confidence_adjustments/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS signal_strategy_statuses/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS original_confidence/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS confidence_calibration/);
assert.match(calibratedMigration, /ADD COLUMN IF NOT EXISTS calibrated_confidence/);
assert.match(calibratedMigration, /ADD COLUMN IF NOT EXISTS confidence_version/);
assert.match(calibratedMigration, /ADD COLUMN IF NOT EXISTS calibration_reason/);
assert.match(directionScopeMigration, /UPDATE signal_strategy_statuses/);
assert.match(directionScopeMigration, /status = 'diagnostic_only'/);
assert.match(directionScopeMigration, /group_type = 'direction'/);
assert.match(directionScopeMigration, /penalty_override = -3/);
assert.match(directionScopeMigration, /confidence_cap_override = NULL/);

assert.match(service, /status = 'Hit TP' THEN risk_reward WHEN status = 'Hit SL' THEN -1 WHEN status = 'Expired' THEN -0\.35/);
assert.match(service, /Confidence reflects setup alignment after historical calibration/);
assert.match(service, /HIGH_CONFIDENCE_EXPECTANCY_CAP = 88/);
assert.match(service, /EXACT_SOURCE_STRATEGY_TIMEFRAME_MIN_CLOSED = 20/);
assert.match(service, /source_strategy_timeframe/);
assert.match(service, /analyzeConfidenceBucketCalibration/);
assert.match(service, /CONFIDENCE_WARNING_COPY/);
assert.match(signalService, /isSignalBlockedByCalibration/);
assert.match(signalService, /Performance calibration quarantined or disabled this group/);
assert.match(signalService, /generationSource/);
assert.match(signalService, /source: "candidate_promotion"/);
assert.doesNotMatch(autoScanService, /calibrateTelegramAlertSetup/);
assert.doesNotMatch(autoScanService, /generationSource: "telegram_alert"/);
assert.match(repository, /recordGeneratedSignalConfidenceAdjustment/);
assert.match(repository, /calibrated_confidence/);
assert.match(repository, /confidence_version/);
assert.match(repository, /calibration_reason/);
assert.match(controller, /\/api\/admin\/signals\/quality\/status/);
assert.match(app, /admin-signal-quality-panel/);
assert.match(app, /Best strategies/);
assert.match(app, /Best pair\/timeframes/);
assert.match(app, /Underconfident winners/);
assert.match(app, /Trust more/);
assert.match(app, /Increase confidence carefully/);
assert.match(app, /data-signal-quality-status="quarantined"/);
assert.match(app, /group\.groupType === "direction"/);
assert.match(app, /Diagnostic only &mdash; direction-level performance is too broad to hard quarantine/);
assert.match(app, /data-signal-quality-status="diagnostic_only" data-penalty-override="-3"/);
assert.match(app, /Original confidence/);
assert.match(app, /Raw setup score/);
assert.match(app, /Calibrated confidence/);
assert.match(app, /Quality Calibration Summary/);
assert.match(html, /admin-signal-quality-panel/);
assert.match(service, /function bestGroupSort/);
assert.match(service, /underconfidentWinners/);
assert.match(service, /capRecovery/);
assert.match(service, /Strong performer/);
assert.match(signalService, /confidenceCalibration: undefined/);
assert.match(quality, /Confidence reflects setup alignment after historical calibration/);

console.log("Signal confidence calibration, loss analysis, quarantine, admin diagnostics, and privacy tests passed.");
