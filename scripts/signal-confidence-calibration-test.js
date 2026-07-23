import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyCalibrationContext,
  bestGroups,
  breakEvenWinRate,
  calculateClosedWinRate,
  calculateGroupStatus,
  calculateQualityAdjustedScore,
  underconfidentWinners
} from "../src/modules/signals/signalConfidenceCalibrationService.js";

const service = readFileSync("src/modules/signals/signalConfidenceCalibrationService.js", "utf8");
const signalService = readFileSync("src/modules/signals/signalService.js", "utf8");
const repository = readFileSync("src/modules/admin-signals/generatedSignalRepository.js", "utf8");
const controller = readFileSync("src/modules/admin-signals/generatedSignalController.js", "utf8");
const app = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");
const migration = readFileSync("migrations/050_signal_confidence_calibration.sql", "utf8");
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
assert.equal(veryPoor.confidenceCap, 72);

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
assert.ok(noHistory.indicators.confidenceCalibration.caps.some((item) => item.cap === 85));
assert.ok(noHistory.indicators.confidenceCalibration.caps.some((item) => item.cap === 80));
assert.ok(noHistory.indicators.confidenceCalibration.caps.some((item) => item.cap === 72));

const underperforming = applyCalibrationContext({ ...baseSignal, confidenceScore: 92, indicators: { readinessScore: 95 }, alignmentBadge: "Full Alignment", confirmations: [{ name: "Volume", passed: true }] }, {
  noHistory: false,
  groups: [
    { groupKey: "strategy:breakout-retest", groupType: "strategy", groupValue: "Breakout Retest", closedSignals: 20, winRate: 20, breakEvenWinRate: 33, estimatedExpectancy: -0.4, expiredRate: 20, status: "reduced_confidence", penalty: -10 },
    { groupKey: "pair_timeframe:btc-usd:15m", groupType: "pair_timeframe", groupValue: "BTC-USD:15m", closedSignals: 20, winRate: 20, breakEvenWinRate: 33, estimatedExpectancy: -0.4, expiredRate: 20, status: "reduced_confidence", penalty: -10 }
  ]
});
assert.equal(underperforming.confidenceScore, 68, "strategy plus pair/timeframe underperformance should cap confidence at 68");
assert.ok(underperforming.confidenceCalibration.penalties.length >= 2);

const blocked = applyCalibrationContext({ ...baseSignal, confidenceScore: 90, riskRewardRatio: 2.4, indicators: { readinessScore: 95 }, alignmentBadge: "Full Alignment", confirmations: [{ name: "Volume", passed: true }] }, {
  noHistory: false,
  groups: [{ groupKey: "strategy:bad", groupType: "strategy", groupValue: "Bad Strategy", closedSignals: 25, status: "quarantined", penalty: -15, confidenceCap: 72 }]
});
assert.equal(blocked.indicators.confidenceCalibration.blocked, true, "quarantined groups must block promotion/alerts");

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
assert.equal(recovered.confidenceScore, 90, "strong performers can recover the historical cap carefully");
assert.ok(recovered.indicators.confidenceCalibration.capRecovery.some((item) => item.cap === 92));

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

assert.match(service, /status = 'Hit TP' THEN risk_reward WHEN status = 'Hit SL' THEN -1 WHEN status = 'Expired' THEN -0\.35/);
assert.match(service, /Confidence reflects rule alignment and historical calibration/);
assert.match(signalService, /isSignalBlockedByCalibration/);
assert.match(signalService, /Performance calibration quarantined or disabled this group/);
assert.match(repository, /recordGeneratedSignalConfidenceAdjustment/);
assert.match(controller, /\/api\/admin\/signals\/quality\/status/);
assert.match(app, /admin-signal-quality-panel/);
assert.match(app, /Best strategies/);
assert.match(app, /Best pair\/timeframes/);
assert.match(app, /Underconfident winners/);
assert.match(app, /Trust more/);
assert.match(app, /Increase confidence carefully/);
assert.match(app, /data-signal-quality-status="quarantined"/);
assert.match(app, /Original confidence/);
assert.match(html, /admin-signal-quality-panel/);
assert.match(service, /function bestGroupSort/);
assert.match(service, /underconfidentWinners/);
assert.match(service, /capRecovery/);
assert.match(service, /Strong performer/);
assert.match(signalService, /confidenceCalibration: undefined/);
assert.match(quality, /not a guaranteed win rate or probability of profit/);

console.log("Signal confidence calibration, loss analysis, quarantine, admin diagnostics, and privacy tests passed.");
