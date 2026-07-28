import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_WATCHING_ALERTS_ENABLED = "true";

const {
  buildLearnedPatternCandidates,
  buildPatternLibraryFromExamples,
  candidateEligibleForReady,
  validateLearnedPatternCandidate
} = await import("../src/modules/signals/historicalPatternLibraryService.js");
const { classifyHistoricalEvidence } = await import("../src/modules/signals/historicalStrategyTestingService.js");
const { evaluateGeneratedSignalTelegramDecision } = await import("../src/modules/notifications/telegramAlertDiagnosticsService.js");
const { appConfig } = await import("../src/config/appConfig.js");

function makeCandles(count = 72) {
  const candles = [];
  let price = 100;
  for (let index = 0; index < count; index += 1) {
    price += index % 8 === 0 ? -0.25 : 0.18;
    candles.push({
      time: 1700000000 + index * 900,
      open: price - 0.12,
      high: price + 0.55,
      low: price - 0.45,
      close: price,
      volume: 1000 + index * 3
    });
  }
  const latest = candles.at(-1);
  latest.open = latest.close - 0.35;
  latest.high = latest.close + 0.5;
  latest.low = latest.close - 0.8;
  latest.volume = 1250;
  return candles;
}

function learnedContext(timeframe = "15m") {
  const candles = makeCandles();
  const latest = candles.at(-1);
  return {
    timeframe,
    marketData: {
      pair: { symbol: "BTCUSD", category: "Crypto" },
      volumeAvailable: true
    },
    candles,
    indicators: {
      ema20: latest.close - 0.2,
      ema50: latest.close - 1.8,
      rsi14: 52,
      atr14: 1,
      volumeMa20: 1000
    },
    levels: {
      nearestSupport: { price: latest.close - 0.65 },
      nearestResistance: { price: latest.close + 4.8 },
      supportStrength: 3,
      resistanceStrength: 2
    },
    regime: {
      label: "Trend Up",
      choppy: false
    },
    detectedPatterns: [
      { pattern: "bull_flag", label: "Bull Flag", bias: "bullish", category: "continuation", confidence: 0.72 }
    ]
  };
}

const patternLibrary = buildPatternLibraryFromExamples([
  ...Array.from({ length: 40 }, (_, index) => ({
    strategy: "Pullback bounce",
    pair: "BTCUSD",
    timeframe: "15m",
    direction: "long",
    marketRegime: "Trend Up",
    result: "Hit TP",
    riskRewardRatio: 2,
    realizedR: 2,
    entryCandleTime: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`
  })),
  ...Array.from({ length: 35 }, (_, index) => ({
    strategy: "Pullback bounce",
    pair: "BTCUSD",
    timeframe: "15m",
    direction: "long",
    marketRegime: "Trend Up",
    result: "Hit SL",
    riskRewardRatio: 2,
    realizedR: -1,
    entryCandleTime: `2026-02-${String((index % 28) + 1).padStart(2, "0")}`
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    strategy: "Pullback bounce",
    pair: "BTCUSD",
    timeframe: "15m",
    direction: "long",
    marketRegime: "Trend Up",
    result: "Expired",
    riskRewardRatio: 2,
    realizedR: 0,
    entryCandleTime: `2026-03-${String((index % 28) + 1).padStart(2, "0")}`
  }))
], { maxExamplesPerBucket: 12 });

assert.equal(patternLibrary.successful.length, 12, "winning examples should be capped and saved separately");
assert.equal(patternLibrary.failed.length, 12, "failed examples should be capped and saved separately");
assert.equal(patternLibrary.expired.length, 6, "expired examples should use the smaller detail cap");
assert.ok(patternLibrary.templates.length >= 1, "strategy templates should be produced from grouped examples");
assert.ok(patternLibrary.capped, "large pattern libraries should report capped storage");

const candidates = buildLearnedPatternCandidates(learnedContext("15m"));
assert.ok(candidates.length >= 1, "learned pattern templates should generate candidates");
assert.ok(candidates.every((candidate) => candidate.strategySource === "historical_pattern_template"), "learned candidates should be tagged");
assert.ok(candidates.every((candidate) => candidate.learnedPattern?.patternMatchScore >= 58), "weak learned matches should be filtered");
assert.ok(validateLearnedPatternCandidate(candidates[0]).valid, "learned candidate should have valid entry, stop, target, and RR");

const invalidCandidate = {
  ...candidates[0],
  direction: "long",
  stopLoss: candidates[0].entry + 1
};
assert.equal(validateLearnedPatternCandidate(invalidCandidate).valid, false, "learned candidate still requires valid directional levels");

assert.equal(candidateEligibleForReady({ ...candidates[0], timeframe: "15m", confidenceScore: 66 }, { qualityGatePassed: true }), true, "15m learned strategy can become ready after quality gate");
assert.equal(candidateEligibleForReady({ ...candidates[0], timeframe: "5m", confidenceScore: 80 }, { qualityGatePassed: true }), false, "5m remains research-only for ready learned signals");
assert.equal(candidateEligibleForReady({ ...candidates[0], timeframe: "15m", confidenceScore: 80 }, { qualityGatePassed: false }), false, "ready threshold 65 still requires quality gate pass");

const broadBadEvidence = classifyHistoricalEvidence({
  validSetupCount: 80,
  expectancy: -0.32,
  winRate: 24,
  breakEvenWinRate: 34,
  evidenceLayer: "strategy_timeframe",
  evidenceLayerLabel: "Strategy and timeframe"
});
assert.equal(broadBadEvidence.action, "cap", "broad historical underperformance should cap, not hard-block");

const exactBadEvidence = classifyHistoricalEvidence({
  validSetupCount: 42,
  expectancy: -0.75,
  winRate: 10,
  breakEvenWinRate: 35,
  hitTp: 3,
  hitSl: 20,
  evidenceLayer: "exact_strategy_pair_timeframe_regime",
  evidenceLayerLabel: "Exact group"
});
assert.equal(exactBadEvidence.action, "block", "exact bad groups with enough evidence can still hard-block");

const readyTelegram = evaluateGeneratedSignalTelegramDecision({
  status: "Active",
  source: "manual_scan",
  timeframe: "15m",
  direction: "long",
  confidenceScore: Math.max(76, appConfig.telegram.readyAlertMinConfidence),
  readinessScore: 90,
  qualityGatePassed: true,
  indicators: { qualityGatePassed: true, qualityGateV2: { status: "passed" } }
});
assert.equal(readyTelegram.allowed, true, "Telegram should allow ready trade signals that pass every alert gate");

const watchingTelegram = evaluateGeneratedSignalTelegramDecision({
  status: "Watching",
  timeframe: "15m",
  direction: "long",
  confidenceScore: 99,
  readinessScore: 80,
  qualityGatePassed: true,
  indicators: { qualityGatePassed: true, qualityGateV2: { status: "passed" } }
});
assert.equal(watchingTelegram.allowed, false, "Telegram must not send watching alerts even if the env flag is set");

const digestDefaultOff = appConfig.telegram.dailyBriefEnabled;
assert.equal(digestDefaultOff, false, "Telegram digest/brief behavior should be opt-in, not default noisy");

console.log("Historical pattern learning tests passed.");
