import {
  classifySetupType,
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

function makeStrategyCandles({ previousClose = 103, latestOpen = 103, latestHigh = 104, latestLow = 102, latestClose = 103.4 } = {}) {
  const base = [];
  const start = 1770000000;
  for (let index = 0; index < 27; index += 1) {
    base.push({
      time: start + index * 900,
      open: 100,
      high: index === 10 ? 105 : 103,
      low: index === 12 ? 95 : 97,
      close: 101,
      volume: 100
    });
  }
  base.push({ time: start + 27 * 900, open: 103, high: Math.max(previousClose, 104), low: 101, close: previousClose, volume: 110 });
  base.push({ time: start + 28 * 900, open: latestOpen, high: latestHigh, low: latestLow, close: latestClose, volume: 140 });
  return base;
}

function classifyFixture(overrides = {}) {
  const candles = overrides.candles || makeStrategyCandles(overrides.candleShape);
  return classifySetupType(
    overrides.direction || "long",
    candles,
    {
      ema20: overrides.ema20 ?? 102,
      ema50: overrides.ema50 ?? 100,
      rsi14: overrides.rsi14 ?? 55,
      atr14: overrides.atr14 ?? 2,
      volumeMa20: overrides.volumeMa20 ?? 100
    },
    {
      nearestSupport: overrides.nearestSupport ?? { price: 101 },
      nearestResistance: overrides.nearestResistance ?? { price: 110 },
      supportStrength: overrides.supportStrength ?? 3,
      resistanceStrength: overrides.resistanceStrength ?? 3
    },
    {
      label: overrides.regimeLabel || "Trend Up",
      trendStrength: overrides.trendStrength ?? 0.72
    },
    overrides.smcState || null,
    overrides.advancedStructure || null,
    overrides.confluenceContext || null
  );
}

const strategyTypes = {
  trendContinuation: classifyFixture({
    candleShape: { previousClose: 103, latestOpen: 103, latestLow: 102.4, latestClose: 104.1 },
    nearestSupport: { price: 98 },
    trendStrength: 0.78
  }),
  pullbackBounce: classifyFixture({
    candleShape: { previousClose: 102, latestOpen: 101.6, latestLow: 101, latestClose: 102.2 },
    ema20: 102,
    nearestSupport: { price: 97 },
    trendStrength: 0.5
  }),
  breakoutRetest: classifyFixture({
    candleShape: { previousClose: 106, latestOpen: 105.2, latestLow: 105.1, latestHigh: 107, latestClose: 106.2 }
  }),
  rangeBounce: classifyFixture({
    regimeLabel: "Range",
    candleShape: { previousClose: 100, latestOpen: 100.6, latestLow: 100, latestClose: 101.3 },
    nearestSupport: { price: 100.5 },
    rsi14: 50,
    trendStrength: 0.25
  }),
  meanReversion: classifyFixture({
    regimeLabel: "Range",
    candleShape: { previousClose: 100, latestOpen: 101.2, latestLow: 100.2, latestClose: 101.1 },
    nearestSupport: { price: 100.5 },
    rsi14: 42,
    trendStrength: 0.25
  }),
  momentumBreakout: classifyFixture({
    candleShape: { previousClose: 104.5, latestOpen: 104.8, latestLow: 104.6, latestHigh: 107, latestClose: 106.4 }
  }),
  liquiditySweepReversal: classifyFixture({
    candleShape: { previousClose: 101, latestOpen: 100.8, latestLow: 94.5, latestClose: 101.8 },
    smcState: { liquiditySweep: { confirmed: true, direction: "long" } }
  }),
  vwapReclaim: classifyFixture({
    candleShape: { previousClose: 103, latestOpen: 103, latestLow: 102, latestClose: 103.6 },
    advancedStructure: { vwap: { event: "Reclaim" } },
    trendStrength: 0.4,
    nearestSupport: { price: 98 }
  }),
  supportResistanceRetest: classifyFixture({
    candleShape: { previousClose: 103, latestOpen: 103.2, latestLow: 102.7, latestClose: 103.8 },
    ema20: 101,
    nearestSupport: { price: 102.8 },
    trendStrength: 0.45
  }),
  multiTimeframeContinuation: classifyFixture({
    candleShape: { previousClose: 103, latestOpen: 103, latestLow: 102.5, latestClose: 104 },
    nearestSupport: { price: 98 },
    trendStrength: 0.45,
    confluenceContext: {
      higherTimeframes: [
        { available: true, regime: { preferredDirection: "long" } }
      ]
    }
  }),
  weakPattern: classifyFixture({
    candleShape: { previousClose: 100, latestOpen: 100.2, latestLow: 99.8, latestClose: 100.1 },
    ema20: 101,
    ema50: 102,
    nearestSupport: { price: 95 },
    supportStrength: 1,
    trendStrength: 0.2,
    regimeLabel: "Low Volatility"
  })
};

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
  },
  strategyTypes
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
  !result.analysis.message.includes("No high-quality setup") ||
  stats.totalSignals !== 5 ||
  stats.hitTpCount !== 2 ||
  stats.hitSlCount !== 1 ||
  stats.expiredCount !== 1 ||
  stats.winRate !== 50 ||
  weakConfidence >= 70 ||
  mediumConfidence < 70 ||
  mediumConfidence > 89 ||
  strongConfidence < 90 ||
  strongConfidence > 97 ||
  nearPerfectConfidence < 98 ||
  nearPerfectConfidence > 100 ||
  strategyTypes.trendContinuation !== "Trend continuation" ||
  strategyTypes.pullbackBounce !== "Pullback bounce" ||
  strategyTypes.breakoutRetest !== "Breakout retest" ||
  strategyTypes.rangeBounce !== "Range bounce" ||
  strategyTypes.meanReversion !== "Mean reversion" ||
  strategyTypes.momentumBreakout !== "Momentum breakout" ||
  strategyTypes.liquiditySweepReversal !== "Liquidity sweep reversal" ||
  strategyTypes.vwapReclaim !== "VWAP reclaim/rejection" ||
  strategyTypes.supportResistanceRetest !== "Support/resistance retest" ||
  strategyTypes.multiTimeframeContinuation !== "Multi-timeframe continuation" ||
  strategyTypes.weakPattern !== null
) {
  process.exitCode = 1;
}
