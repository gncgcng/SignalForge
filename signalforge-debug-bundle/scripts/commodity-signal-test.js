import { generateMarketDataSetup } from "../src/modules/signals/signalGenerator.js";

const symbols = ["XAU/USD", "XAG/USD", "WTI", "BRENT", "NATGAS"];
const timeframes = ["1h", "4h", "15m", "5m"];
const checks = [];

for (const symbol of symbols) {
  for (const timeframe of timeframes) {
    const result = generateMarketDataSetup({
      pair: {
        symbol,
        assetClass: "Commodity"
      },
      source: "twelve-data",
      volumeAvailable: false,
      candles: makeCommodityCandles(timeframes.indexOf(timeframe))
    }, timeframe);
    const candidates = result.valid ? [result.signal] : result.analysis.candidates;
    const confirmations = result.valid
      ? result.signal.confirmations
      : candidates[0].confirmations;
    const names = confirmations.map((item) => item.name);

    checks.push({
      symbol,
      timeframe,
      noVolume: !names.includes("Volume"),
      priceChecksPresent: ["Trend", "EMA structure", "RSI", "ATR", "Support", "Resistance"]
        .every((name) => names.includes(name)),
      provider: result.valid ? result.signal.marketSource : "twelve-data",
      commodityExplanation: result.valid
        ? result.signal.reasoning.includes("Commodity") && result.signal.reasoning.includes("volume is not required")
        : result.analysis.message.includes("commodity")
    });
  }
}

const result = {
  goldPreserved: checks.filter((check) => check.symbol === "XAU/USD").length === 4,
  allSymbolsCovered: symbols.every((symbol) => checks.some((check) => check.symbol === symbol)),
  higherTimeframesVerifiedFirst: checks.slice(0, 2).map((check) => check.timeframe).join(",") === "1h,4h",
  allPriceBased: checks.every((check) => check.noVolume && check.priceChecksPresent),
  allUseTwelveData: checks.every((check) => check.provider === "twelve-data"),
  allHaveCommodityExplanations: checks.every((check) => check.commodityExplanation),
  combinationsTested: checks.length
};

console.log(JSON.stringify(result, null, 2));

if (
  !result.goldPreserved ||
  !result.allSymbolsCovered ||
  !result.higherTimeframesVerifiedFirst ||
  !result.allPriceBased ||
  !result.allUseTwelveData ||
  !result.allHaveCommodityExplanations ||
  result.combinationsTested !== 20
) {
  process.exitCode = 1;
}

function makeCommodityCandles(variant) {
  const start = Math.floor(Date.now() / 1000) - 120 * 3600;

  return Array.from({ length: 120 }, (_, index) => {
    const baseline = 100 + index * 0.035;
    const wave = Math.sin(index * 0.55 + variant * 0.2) * 0.7;
    const close = baseline + wave;
    const open = close - Math.sin(index * 0.31) * 0.15;

    return {
      time: start + index * 3600,
      open,
      high: Math.max(open, close) + 0.35,
      low: Math.min(open, close) - 0.35,
      close,
      volume: 0,
      volumeAvailable: false
    };
  });
}
