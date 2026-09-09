import assert from "node:assert/strict";
import {
  calculateDisplayConfidence,
  generateMarketDataSetup
} from "../src/modules/signals/signalGenerator.js";
import { listActivePairs } from "../src/modules/market-data/marketDataService.js";

const requiredMajorCrypto = [
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "XRP-USD",
  "LTC-USD",
  "ADA-USD",
  "DOGE-USD",
  "LINK-USD",
  "AVAX-USD",
  "BCH-USD",
  "DOT-USD",
  "UNI-USD",
  "AAVE-USD",
  "XLM-USD",
  "HBAR-USD",
  "NEAR-USD",
  "SUI-USD"
];
const timeframes = ["5m", "15m", "1h", "4h"];

function confidenceFixture(overrides = {}) {
  return {
    candidate: {
      valid: true,
      confidenceScore: 84,
      passedCount: 5,
      confirmations: Array.from({ length: 6 }, () => ({ passed: true }))
    },
    setupType: "Pullback bounce",
    regime: { label: "Trend Up", choppy: false },
    confluence: { score: 58, badge: "Partial Alignment", confidenceAdjustment: 1 },
    smc: { score: 9, conflict: false, confidenceAdjustment: 1 },
    marketStructure: { available: false, confidenceAdjustment: 0 },
    correlation: { conflict: false, confidenceAdjustment: 0 },
    session: { liquidity: "Normal", confidenceAdjustment: 0 },
    newsRisk: { level: "Low", blockSignal: false, confidenceAdjustment: 0 },
    riskPlan: { riskRewardRatio: 1.9 },
    qualityScore: 76,
    opposingRoom: 2.4,
    emaAligned: true,
    ...overrides
  };
}

function makeFlatCandles(symbol = "BTC-USD") {
  const base = symbol === "XAU/USD" ? 2350 : 100;
  return Array.from({ length: 120 }, (_, index) => {
    const drift = Math.sin(index * 1.3) * base * 0.0004;
    const open = base + drift;
    const close = base - drift * 0.8;
    return {
      time: 1_780_000_000 + index * 900,
      open,
      high: Math.max(open, close) + base * 0.0012,
      low: Math.min(open, close) - base * 0.0012,
      close,
      volume: symbol === "XAU/USD" ? 0 : 900 + (index % 5) * 7
    };
  });
}

function runFixtureScan(symbol, timeframe, assetClass = "Crypto") {
  return generateMarketDataSetup({
    pair: { symbol, assetClass },
    source: "diagnostic-fixture",
    volumeAvailable: assetClass !== "Commodity",
    candles: makeFlatCandles(symbol)
  }, timeframe);
}

function buildDebugReport(results) {
  const report = {
    signalsFound: 0,
    rejectionsByReason: {},
    strategiesTriggered: {},
    confidenceDistribution: { good: 0, strong: 0, excellent: 0, rare: 0 }
  };

  for (const result of results) {
    if (result.valid) {
      report.signalsFound += 1;
      const strategy = result.signal.setupType || "Unknown";
      report.strategiesTriggered[strategy] = (report.strategiesTriggered[strategy] || 0) + 1;
      const confidence = Number(result.signal.confidenceScore || 0);
      if (confidence >= 98) report.confidenceDistribution.rare += 1;
      else if (confidence >= 90) report.confidenceDistribution.excellent += 1;
      else if (confidence >= 80) report.confidenceDistribution.strong += 1;
      else if (confidence >= 70) report.confidenceDistribution.good += 1;
      continue;
    }

    for (const reason of result.analysis.rejectionReasons || []) {
      report.rejectionsByReason[reason] = (report.rejectionsByReason[reason] || 0) + 1;
    }
  }

  return report;
}

const weakConfidence = calculateDisplayConfidence(confidenceFixture({
  candidate: {
    valid: true,
    confidenceScore: 78,
    passedCount: 3,
    confirmations: Array.from({ length: 6 }, (_, index) => ({ passed: index < 3 }))
  },
  qualityScore: 62,
  confluence: { score: 18, badge: "Countertrend", confidenceAdjustment: -12 },
  smc: { score: 2, conflict: true, confidenceAdjustment: -8 },
  newsRisk: { level: "High", blockSignal: false, confidenceAdjustment: -8 },
  session: { liquidity: "Low", confidenceAdjustment: -4 },
  emaAligned: false
}));
const goodConfidence = calculateDisplayConfidence(confidenceFixture());
const goodConfidenceAdjusted = calculateDisplayConfidence(confidenceFixture({
  candidate: {
    valid: true,
    confidenceScore: 73,
    passedCount: 4,
    confirmations: Array.from({ length: 6 }, (_, index) => ({ passed: index < 4 }))
  },
  qualityScore: 70,
  confluence: { score: 36, badge: "Partial Alignment", confidenceAdjustment: 0 },
  smc: { score: 4, conflict: false, confidenceAdjustment: 0 },
  riskPlan: { riskRewardRatio: 1.8 },
  opposingRoom: 2.1
}));
const strongConfidence = calculateDisplayConfidence(confidenceFixture({
  candidate: {
    valid: true,
    confidenceScore: 82,
    passedCount: 5,
    confirmations: Array.from({ length: 6 }, () => ({ passed: true }))
  },
  qualityScore: 84,
  confluence: { score: 56, badge: "Partial Alignment", confidenceAdjustment: 1 },
  smc: { score: 10, conflict: false, confidenceAdjustment: 1 },
  session: { liquidity: "High", confidenceAdjustment: 1 },
  riskPlan: { riskRewardRatio: 1.95 }
}));
const excellentConfidence = calculateDisplayConfidence(confidenceFixture({
  candidate: {
    valid: true,
    confidenceScore: 91,
    passedCount: 6,
    confirmations: Array.from({ length: 6 }, () => ({ passed: true }))
  },
  qualityScore: 91,
  confluence: { score: 78, badge: "Partial Alignment", confidenceAdjustment: 4 },
  smc: { score: 15, conflict: false, confidenceAdjustment: 2 },
  marketStructure: { available: true, vwapAligned: true, volumeProfileAligned: false, confidenceAdjustment: 2 },
  session: { liquidity: "High", confidenceAdjustment: 2 },
  riskPlan: { riskRewardRatio: 2.15 },
  opposingRoom: 3
}));
const rareConfidence = calculateDisplayConfidence(confidenceFixture({
  candidate: {
    valid: true,
    confidenceScore: 96,
    passedCount: 6,
    confirmations: Array.from({ length: 6 }, () => ({ passed: true }))
  },
  setupType: "Breakout retest",
  confluence: { score: 96, badge: "Full Alignment", confidenceAdjustment: 6 },
  smc: { score: 28, conflict: false, confidenceAdjustment: 5 },
  marketStructure: { available: true, vwapAligned: true, volumeProfileAligned: true, confidenceAdjustment: 4 },
  riskPlan: { riskRewardRatio: 2.5 },
  qualityScore: 98,
  opposingRoom: 3.6
}));

const weakRejected = runFixtureScan("BTC-USD", "15m");
const commodityNoVolume = runFixtureScan("XAU/USD", "1h", "Commodity");
const commodityConfirmations = commodityNoVolume.valid
  ? commodityNoVolume.signal.confirmations
  : commodityNoVolume.analysis.candidates[0].confirmations;
const activeSymbols = new Set(listActivePairs().map((pair) => pair.symbol));
const fixtureResults = requiredMajorCrypto.flatMap((symbol) => {
  return timeframes.map((timeframe) => runFixtureScan(symbol, timeframe));
});
const debugReport = buildDebugReport([...fixtureResults, commodityNoVolume]);

assert.ok(weakConfidence < 70, "Weak fixture should be rejected below signal threshold.");
assert.ok(
  goodConfidenceAdjusted >= 70 && goodConfidenceAdjusted <= 79,
  `Good fixture should score 70-79, got ${goodConfidenceAdjusted}.`
);
assert.ok(strongConfidence >= 80 && strongConfidence <= 89, "Strong fixture should score 80-89.");
assert.ok(excellentConfidence >= 90 && excellentConfidence <= 97, "Excellent fixture should score 90-97.");
assert.ok(rareConfidence >= 98 && rareConfidence <= 100, "Rare fixture may reach 98-100 only with near-perfect confluence.");
assert.equal(weakRejected.valid, false, "Weak fixture should produce no signal.");
assert.ok(weakRejected.analysis.rejectionReasons.length, "Rejected scans should include stable diagnostic reasons.");
assert.ok(weakRejected.analysis.rejectionSummary.includes("No setup found because:"), "Rejected scans should include a human summary.");
assert.ok(!commodityConfirmations.some((item) => item.name === "Volume"), "Commodity fixtures without volume should not require volume confirmation.");
for (const symbol of requiredMajorCrypto) {
  assert.ok(activeSymbols.has(symbol), `Missing required active crypto market ${symbol}.`);
}
assert.ok(Object.keys(debugReport.rejectionsByReason).length, "Debug report should aggregate rejection reasons.");
assert.equal(
  fixtureResults.length,
  requiredMajorCrypto.length * timeframes.length,
  "Debug fixture should scan every required major crypto and timeframe."
);

console.log(JSON.stringify({
  confidenceTiers: {
    weakConfidence,
    goodConfidence: goodConfidenceAdjusted,
    strongConfidence,
    excellentConfidence,
    rareConfidence
  },
  weakRejected: {
    valid: weakRejected.valid,
    rejectionReasons: weakRejected.analysis.rejectionReasons,
    rejectionSummary: weakRejected.analysis.rejectionSummary
  },
  commodityWithoutVolume: {
    valid: commodityNoVolume.valid,
    confirmationNames: commodityConfirmations.map((item) => item.name)
  },
  debugReport
}, null, 2));
