import { generateMarketDataSetup } from "../src/modules/signals/signalGenerator.js";
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
  stats.winRate !== 67
) {
  process.exitCode = 1;
}
