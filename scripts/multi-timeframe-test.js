import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scoreMultiTimeframeConfluence } from "../src/modules/market-data/multiTimeframeService.js";

const full = scoreMultiTimeframeConfluence(context([
  higher("1h", "Trend Up", 58, 31, "Higher highs / higher lows"),
  higher("4h", "Trend Up", 55, 27, "Higher highs / higher lows")
]), "long");
const partial = scoreMultiTimeframeConfluence(context([
  higher("1h", "Trend Up", 54, 24, "Higher highs / higher lows"),
  higher("4h", "Range", 50, 15, "Mixed")
]), "long");
const countertrend = scoreMultiTimeframeConfluence(context([
  higher("1h", "Trend Down", 42, 30, "Lower highs / lower lows"),
  higher("4h", "Trend Down", 40, 28, "Lower highs / lower lows")
]), "long");

assert.equal(full.badge, "Full Alignment");
assert.ok(full.score >= 75);
assert.ok(full.confidenceAdjustment > 0);
assert.equal(partial.badge, "Partial Alignment");
assert.equal(countertrend.badge, "Countertrend");
assert.ok(countertrend.confidenceAdjustment < 0);

const service = readFileSync(
  new URL("../src/modules/market-data/multiTimeframeService.js", import.meta.url),
  "utf8"
);
const generator = readFileSync(
  new URL("../src/modules/signals/signalGenerator.js", import.meta.url),
  "utf8"
);
const performance = readFileSync(
  new URL("../src/modules/performance/performanceService.js", import.meta.url),
  "utf8"
);
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const result = {
  allTimeframesDefined: service.includes('["5m", "15m", "1h", "4h"]'),
  higherTimeframesFetched: service.includes("Promise.allSettled") &&
    service.includes("getOhlcv(symbol, higherTimeframe)"),
  indicatorsUsed: ["ema20", "ema50", "rsi14", "adx14", "support", "resistance", "structure"]
    .every((metric) => service.includes(metric)),
  badgesCorrect: full.badge === "Full Alignment" &&
    partial.badge === "Partial Alignment" &&
    countertrend.badge === "Countertrend",
  confidenceAdjusted: generator.includes("confluence.confidenceAdjustment") &&
    generator.includes("confluence.qualityAdjustment") &&
    generator.includes("strongly opposes this lower-timeframe setup"),
  explanationPersisted: generator.includes("confluenceExplanation") &&
    generator.includes("higherTimeframes"),
  uiCardsPresent: ["HTF Trend", "LTF Setup", "confluence-score", "confluence-badge"]
    .every((value) => html.includes(value)) &&
    app.includes("renderMultiTimeframeConfluence"),
  performanceRangesPresent: performance.includes('"0-39"') &&
    performance.includes('"40-59"') &&
    performance.includes('"60-79"') &&
    performance.includes('"80-100"') &&
    html.includes("signals-by-confluence")
};

console.log(JSON.stringify({
  ...result,
  scores: {
    full: full.score,
    partial: partial.score,
    countertrend: countertrend.score
  }
}, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}

function context(higherTimeframes) {
  return {
    symbol: "BTC-USD",
    lowerTimeframe: "15m",
    higherTimeframes
  };
}

function higher(timeframe, label, rsi14, adx14, structure) {
  const long = label === "Trend Up";
  return {
    timeframe,
    available: true,
    regime: {
      label,
      preferredDirection: long ? "long" : label === "Trend Down" ? "short" : "both",
      metrics: {
        ema20: long ? 105 : 95,
        ema50: 100,
        rsi14,
        adx14,
        structure,
        latestPrice: 102,
        support: 94,
        resistance: 112
      }
    }
  };
}
