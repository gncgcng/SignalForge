import {
  calculateDisplayConfidence,
  generateMarketDataSetup
} from "../src/modules/signals/signalGenerator.js";
import { calculateSignalStats } from "../src/modules/signals/signalOutcomeService.js";
import { rankSetups } from "../src/modules/signals/signalService.js";

function makeFlatCandles() {
  const candles = [];
  const start = Math.floor(Date.now() / 1000) - 120 * 900;

  for (let index = 0; index < 120; index += 1) {
    candles.push({
      time: start + index * 900,
      open: 100,
      high: 100.4,
      low: 99.6,
      close: index % 2 === 0 ? 100.05 : 99.95,
      volume: 10
    });
  }

  return candles;
}

const result = generateMarketDataSetup({
  pair: {
    symbol: "BTC-USD"
  },
  source: "test-fixture",
  candles: makeFlatCandles()
}, "15m");
const commodityResult = generateMarketDataSetup({
  pair: {
    symbol: "XAU/USD",
    assetClass: "Commodity"
  },
  source: "commodity-test-fixture",
  volumeAvailable: false,
  candles: makeFlatCandles()
}, "15m");
const commodityConfirmations = commodityResult.valid
  ? commodityResult.signal.confirmations
  : commodityResult.analysis.candidates[0].confirmations;
const commodityConfirmationNames = commodityConfirmations.map((item) => item.name);
const commodityExplanation = commodityResult.valid
  ? commodityResult.signal.reasoning
  : commodityResult.analysis.message;
const ranked = rankSetups([
  { symbol: "BTC-USD", confidenceScore: 82, riskRewardRatio: 2.5 },
  { symbol: "XAG/USD", confidenceScore: 88, riskRewardRatio: 1.8 },
  { symbol: "WTI", confidenceScore: 88, riskRewardRatio: 2.2 }
]);
const stats = calculateSignalStats([
  { status: "Hit TP" },
  { status: "Hit TP" },
  { status: "Hit SL" },
  { status: "Expired" },
  { status: "Active" }
]);

function confidenceFixture(overrides = {}) {
  return {
    candidate: {
      valid: true,
      confidenceScore: 92,
      passedCount: 6,
      confirmations: Array.from({ length: 6 }, () => ({ passed: true }))
    },
    setupType: "Pullback bounce",
    regime: {
      label: "Trend Up",
      choppy: false
    },
    confluence: {
      score: 78,
      badge: "Partial Alignment",
      confidenceAdjustment: 4
    },
    smc: {
      score: 14,
      conflict: false,
      confidenceAdjustment: 3
    },
    marketStructure: {
      available: true,
      vwapAligned: true,
      volumeProfileAligned: false,
      confidenceAdjustment: 2
    },
    correlation: {
      conflict: false,
      confidenceAdjustment: 0
    },
    session: {
      liquidity: "High",
      confidenceAdjustment: 2
    },
    newsRisk: {
      level: "Low",
      blockSignal: false,
      confidenceAdjustment: 0
    },
    riskPlan: {
      riskRewardRatio: 2.1
    },
    qualityScore: 91,
    opposingRoom: 3,
    emaAligned: true,
    ...overrides
  };
}

const weakConfidence = calculateDisplayConfidence(confidenceFixture({
  candidate: {
    valid: true,
    confidenceScore: 88,
    passedCount: 4,
    confirmations: Array.from({ length: 6 }, () => ({ passed: true }))
  },
  qualityScore: 76,
  confluence: { score: 25, badge: "Countertrend", confidenceAdjustment: -12 },
  smc: { score: 4, conflict: true, confidenceAdjustment: -8 },
  marketStructure: { available: true, vwapAligned: false, volumeProfileAligned: false, confidenceAdjustment: -4 },
  newsRisk: { level: "High", blockSignal: false, confidenceAdjustment: -8 },
  session: { liquidity: "Low", confidenceAdjustment: -4 },
  emaAligned: false
}));
const mediumConfidence = calculateDisplayConfidence(confidenceFixture({
  candidate: {
    valid: true,
    confidenceScore: 84,
    passedCount: 5,
    confirmations: Array.from({ length: 6 }, () => ({ passed: true }))
  },
  qualityScore: 83,
  confluence: { score: 60, badge: "Partial Alignment", confidenceAdjustment: 1 },
  smc: { score: 10, conflict: false, confidenceAdjustment: 1 },
  marketStructure: { available: false, confidenceAdjustment: 0 },
  riskPlan: { riskRewardRatio: 1.9 }
}));
const strongConfidence = calculateDisplayConfidence(confidenceFixture());
const nearPerfectConfidence = calculateDisplayConfidence(confidenceFixture({
  candidate: {
    valid: true,
    confidenceScore: 96,
    passedCount: 6,
    confirmations: Array.from({ length: 6 }, () => ({ passed: true }))
  },
  setupType: "Breakout retest",
  confluence: { score: 96, badge: "Full Alignment", confidenceAdjustment: 6 },
  smc: { score: 26, conflict: false, confidenceAdjustment: 5 },
  marketStructure: {
    available: true,
    vwapAligned: true,
    volumeProfileAligned: true,
    confidenceAdjustment: 4
  },
  riskPlan: { riskRewardRatio: 2.5 },
  qualityScore: 98,
  opposingRoom: 3.5
}));

console.log(JSON.stringify({
  valid: result.valid,
  commodityEngineEvaluated: (commodityResult.analysis?.symbol || commodityResult.signal?.symbol) === "XAU/USD",
  commodityDoesNotRequireVolume: !commodityConfirmationNames.includes("Volume"),
  commodityUsesPriceConfirmations: ["Trend", "EMA structure", "RSI", "ATR", "Support", "Resistance"]
    .every((name) => commodityConfirmationNames.includes(name)),
  commodityExplanation,
  mixedAssetRanking: ranked.map((setup) => setup.symbol),
  message: result.analysis.message,
  longPassed: result.analysis.candidates.find((candidate) => candidate.direction === "long")?.passedCount,
  shortPassed: result.analysis.candidates.find((candidate) => candidate.direction === "short")?.passedCount,
  stats
  ,
  confidenceScoring: {
    weakConfidence,
    mediumConfidence,
    strongConfidence,
    nearPerfectConfidence
  }
}, null, 2));

if (
  result.valid ||
  result.signal ||
  (!commodityResult.analysis && !commodityResult.signal) ||
  (commodityResult.analysis?.symbol || commodityResult.signal?.symbol) !== "XAU/USD" ||
  commodityConfirmationNames.includes("Volume") ||
  !["Trend", "EMA structure", "RSI", "ATR", "Support", "Resistance"]
    .every((name) => commodityConfirmationNames.includes(name)) ||
  !commodityExplanation.toLowerCase().includes("commodity") ||
  ranked.map((setup) => setup.symbol).join(",") !== "WTI,XAG/USD,BTC-USD" ||
  !result.analysis.message.includes("No valid setup") ||
  stats.totalSignals !== 5 ||
  stats.hitTpCount !== 2 ||
  stats.hitSlCount !== 1 ||
  stats.expiredCount !== 1 ||
  stats.winRate !== 67 ||
  weakConfidence >= 70 ||
  mediumConfidence < 70 ||
  mediumConfidence > 89 ||
  strongConfidence < 90 ||
  strongConfidence > 97 ||
  nearPerfectConfidence < 98 ||
  nearPerfectConfidence > 100
) {
  process.exitCode = 1;
}
