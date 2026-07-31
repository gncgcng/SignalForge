import assert from "node:assert/strict";
import {
  applyHistoricalStrategyContext,
  calculateBreakEvenWinRate,
  calculateHistoricalStrategyMetrics,
  calculateStrategyExpectancy,
  calculateWalkForwardValidation,
  classifyHistoricalEvidence,
  compareSetupToHistoricalExamples,
  evaluateHistoricalOutcome,
  getSampleSizeLabel
} from "../src/modules/signals/historicalStrategyTestingService.js";
import {
  validateStrategyStrictness
} from "../src/modules/signals/strategyStrictnessService.js";

const longSetup = {
  direction: "long",
  entryPrice: 100,
  stopLoss: 95,
  takeProfit: 110,
  riskRewardRatio: 2
};

assert.equal(evaluateHistoricalOutcome(longSetup, [{ high: 106, low: 98 }, { high: 111, low: 101 }]).status, "Hit TP");
assert.equal(evaluateHistoricalOutcome(longSetup, [{ high: 101, low: 94 }]).status, "Hit SL");
assert.equal(evaluateHistoricalOutcome({ ...longSetup, direction: "short", stopLoss: 105, takeProfit: 90 }, [{ high: 101, low: 89 }]).status, "Hit TP");

assert.equal(calculateBreakEvenWinRate(2), 33.3);
assert.equal(calculateStrategyExpectancy({ winRate: 50, averageRiskReward: 2, expiredRate: 0 }), 0.5);
assert.equal(getSampleSizeLabel(10), "not_enough_data");
assert.equal(getSampleSizeLabel(25), "experimental");
assert.equal(getSampleSizeLabel(60), "promising");
assert.equal(getSampleSizeLabel(120), "stronger_evidence");

const examples = Array.from({ length: 60 }, (_, index) => ({
  strategy: "Breakout retest",
  pair: "BTC-USD",
  timeframe: "15m",
  marketRegime: "Trend Up",
  entryCandleTime: new Date(Date.UTC(2026, 0, 1, 0, index * 15)).toISOString(),
  result: index % 3 === 0 ? "Hit SL" : "Hit TP",
  riskReward: 2,
  barsToOutcome: 4
}));
const metrics = calculateHistoricalStrategyMetrics(examples);
assert.equal(metrics.totalTested, 60);
assert.equal(metrics.validSetupCount, 60);
assert.equal(metrics.hitTp, 40);
assert.equal(metrics.hitSl, 20);
assert(metrics.winRate > metrics.breakEvenWinRate);
assert(metrics.expectancy > 0);

const walkForward = calculateWalkForwardValidation(examples);
assert.equal(walkForward.status, "validated");
assert(walkForward.training.totalTested > 0);
assert(walkForward.validation.totalTested > 0);

const failedExamples = examples.map((example, index) => ({ ...example, result: index % 4 === 0 ? "Hit TP" : "Hit SL" }));
const failedWalkForward = calculateWalkForwardValidation(failedExamples);
assert.equal(failedWalkForward.status, "failed_validation");

const similarity = compareSetupToHistoricalExamples({
  setupType: "Breakout retest",
  symbol: "BTC-USD",
  timeframe: "15m",
  direction: "long",
  riskRewardRatio: 2,
  confidenceScore: 82,
  readinessScore: 85
}, failedExamples);
assert(similarity.adjustment <= 0);

const calibrated = applyHistoricalStrategyContext({
  confidenceScore: 88,
  setupType: "Breakout retest",
  symbol: "BTC-USD",
  timeframe: "15m",
  direction: "long",
  riskRewardRatio: 2,
  indicators: {}
}, {
  stat: { sampleSizeLabel: "promising", validSetupCount: 60, walkForwardStatus: "failed_validation", expectancy: -0.2, expiredRate: 10 },
  similarity
});
assert(calibrated.confidenceScore <= 75);
assert.match(calibrated.historicalStrategyReason, /negative|Walk-forward|failed/i);
assert.equal(calibrated.indicators.historicalStrategyCalibration.action, "watching");
assert.equal(calibrated.indicators.historicalStrategyCalibration.hardBlockEligible, false);

const smallSampleEvidence = classifyHistoricalEvidence({
  evidenceLayer: "exact_strategy_pair_timeframe_regime",
  validSetupCount: 9,
  expectancy: -1.2,
  winRate: 0,
  breakEvenWinRate: 35
});
assert.equal(smallSampleEvidence.action, "needs_more_data");

const broadUnderperformer = classifyHistoricalEvidence({
  evidenceLayer: "strategy_overall",
  evidenceLayerLabel: "Strategy overall",
  validSetupCount: 45,
  expectancy: -0.55,
  winRate: 18,
  breakEvenWinRate: 35
});
assert.equal(broadUnderperformer.action, "cap");

const exactHardBlock = classifyHistoricalEvidence({
  evidenceLayer: "exact_strategy_pair_timeframe_direction_regime",
  evidenceLayerLabel: "Exact strategy, pair, timeframe, direction, and regime",
  direction: "long",
  validSetupCount: 35,
  hitTp: 4,
  hitSl: 24,
  expectancy: -0.72,
  winRate: 14,
  breakEvenWinRate: 34
});
assert.equal(exactHardBlock.action, "block");

const exactWithoutDirection = classifyHistoricalEvidence({
  evidenceLayer: "exact_strategy_pair_timeframe_regime",
  evidenceLayerLabel: "Strategy, pair, timeframe, and regime",
  validSetupCount: 35,
  hitTp: 4,
  hitSl: 24,
  expectancy: -0.72,
  winRate: 14,
  breakEvenWinRate: 34
});
assert.notEqual(exactWithoutDirection.action, "block", "historical evidence without direction is not specific enough to hard-block");

const noHistoryCalibration = applyHistoricalStrategyContext({
  confidenceScore: 90,
  rawSetupScore: 90,
  qualityScore: 100,
  readinessScore: 100,
  setupType: "Trend continuation",
  symbol: "BTC-USD",
  timeframe: "15m",
  direction: "long",
  indicators: {}
}, { stat: null, similarity: null });
assert.equal(noHistoryCalibration.confidenceScore, 82);
assert.equal(noHistoryCalibration.calibratedConfidence, 82);
assert.equal(noHistoryCalibration.indicators.historicalStrategyCalibration.status, "insufficient_data");
assert.equal(noHistoryCalibration.indicators.historicalStrategyCalibration.historicalCalibrationAdjustment, -3);
assert.notEqual(noHistoryCalibration.confidenceScore, 50);

const broadWeakCalibration = applyHistoricalStrategyContext({
  confidenceScore: 86,
  rawSetupScore: 86,
  setupType: "Trend continuation",
  symbol: "ETH-USD",
  timeframe: "15m",
  direction: "long",
  indicators: {}
}, {
  stat: {
    evidenceLayer: "strategy_overall",
    evidenceLayerLabel: "Strategy overall",
    validSetupCount: 45,
    walkForwardStatus: "failed_validation",
    expectancy: -0.55,
    winRate: 18,
    breakEvenWinRate: 35,
    expiredRate: 10
  }
});
assert.equal(broadWeakCalibration.indicators.historicalStrategyCalibration.hardBlockEligible, false);
assert.notEqual(broadWeakCalibration.historicalStrategyStatus, "historical_underperformer");
assert.ok(broadWeakCalibration.confidenceScore >= 65, "broad strategy weakness should cap/penalize rather than collapse strong current confidence");

const failedCalibration = applyHistoricalStrategyContext({
  confidenceScore: 88,
  rawSetupScore: 90,
  setupType: "Trend continuation",
  symbol: "SOL-USD",
  timeframe: "15m",
  direction: "long",
  indicators: {}
}, { calibrationError: "backtest query failed" });
assert.equal(failedCalibration.historicalStrategyStatus, "calibration_error");
assert.equal(failedCalibration.calibratedConfidence, null);
assert.match(failedCalibration.indicators.historicalStrategyCalibration.technicalError, /query failed/);
assert.notEqual(failedCalibration.confidenceScore, 50);

const misreadRetest = validateStrategyStrictness({
  setupType: "Breakout retest",
  direction: "long",
  entryPrice: 100,
  stopLoss: 96,
  takeProfit: 108,
  riskRewardRatio: 2,
  readinessScore: 82,
  confirmations: [
    { name: "Trend", passed: true },
    { name: "Volume", passed: true },
    { name: "Support", passed: true }
  ],
  indicators: { atr14: 2 }
}, { volumeAvailable: true });
assert.equal(misreadRetest.passed, false);
assert.equal(misreadRetest.code, "missing_retest");
assert.match(misreadRetest.reason, /did not actually retest/i);

const validRetest = validateStrategyStrictness({
  setupType: "Breakout retest",
  direction: "long",
  entryPrice: 100.2,
  stopLoss: 96,
  takeProfit: 108.6,
  riskRewardRatio: 2,
  readinessScore: 84,
  marketStructure: { breakoutLevel: 100, score: 70, retestConfirmed: true },
  confirmations: [
    { name: "Retest held", passed: true },
    { name: "Volume expansion", passed: true },
    { name: "Structure", passed: true }
  ],
  indicators: { atr14: 2, volumeConfirmed: true }
}, { volumeAvailable: true });
assert.equal(validRetest.passed, true);

console.log("historical strategy testing tests passed");
