import assert from "node:assert/strict";
import { analyzeMarketRegime } from "../src/modules/market-data/marketRegimeService.js";
import { diagnoseMarketRegimeClassification } from "../src/modules/market-data/marketRegimeDiagnostics.js";
import {
  buildMarketRegimeDiagnosticReport,
  classifyRangeBlocker,
  conditionNearMissAnalysis,
  parseMarketRegimeDiagnosticArguments,
  runMarketRegimeDiagnosticReport,
  slideDiagnosticWindows
} from "./market-regime-diagnostic-report.js";

// --- deterministic synthetic candle generation (mulberry32 PRNG, no external dependency) ---

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCandles({ count, drift, noise, seed, startPrice = 100 }) {
  const random = mulberry32(seed);
  const candles = [];
  let close = startPrice;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    close = Math.max(1, open + drift + (random() - 0.5) * noise);
    const wiggle = Math.abs(random()) * noise * 0.5;
    const high = Math.max(open, close) + wiggle;
    const low = Math.min(open, close) - wiggle;
    candles.push({ time: 1_700_000_000 + index * 3600, open, high, low, close });
  }
  return candles;
}

const strongUptrend = buildCandles({ count: 200, drift: 0.8, noise: 0.6, seed: 1 });
const strongDowntrend = buildCandles({ count: 200, drift: -0.8, noise: 0.6, seed: 2 });
const choppyFlat = buildCandles({ count: 200, drift: 0, noise: 1.2, seed: 3 });
const sharpBreakout = buildCandles({ count: 200, drift: 0.05, noise: 0.3, seed: 4 })
  .concat(buildCandles({ count: 10, drift: 4, noise: 2, seed: 5, startPrice: 130 }));

// --- diagnoseMarketRegimeClassification must always agree with analyzeMarketRegime ---
// This is the critical invariant: the diagnostic file duplicates analyzeMarketRegime's math on
// purpose (rather than importing internals) so it can never affect the live trading path, but
// that means a silent drift between the two implementations is a real risk. Check agreement
// across many sliding windows over several very different synthetic series.

let checkedWindows = 0;
for (const series of [strongUptrend, strongDowntrend, choppyFlat, sharpBreakout]) {
  const windows = slideDiagnosticWindows(series, 90, 40);
  assert.ok(windows.length > 10, "expected multiple sliding windows from a 200-candle series");
  for (const window of windows) {
    const production = analyzeMarketRegime(window);
    const diagnosis = diagnoseMarketRegimeClassification(window);
    assert.equal(diagnosis.finalLabel, production.label);
    assert.equal(diagnosis.agreesWithProduction, true,
      `diagnosis disagreed with production for a window ending at ${window.at(-1).time}: diagnostic=${diagnosis.diagnosticLabel} production=${production.label}`);
    checkedWindows += 1;
  }
}
assert.ok(checkedWindows > 100, "expected a meaningful number of windows to have been cross-checked");
console.log(`diagnoseMarketRegimeClassification agreed with analyzeMarketRegime across ${checkedWindows} windows`);

// A strong, low-noise uptrend should land on Trend Up (or Breakout, which also implies upward
// price action) far more often than Trend Down.
const uptrendLabels = slideDiagnosticWindows(strongUptrend, 90, 40)
  .map((window) => diagnoseMarketRegimeClassification(window).finalLabel);
const uptrendDownCount = uptrendLabels.filter((label) => label === "Trend Down").length;
assert.equal(uptrendDownCount, 0, "a monotonic uptrend should never classify as Trend Down");

// --- insufficient candles short-circuits exactly like analyzeMarketRegime ---

const tooFewCandles = strongUptrend.slice(0, 40);
const shortDiagnosis = diagnoseMarketRegimeClassification(tooFewCandles);
assert.equal(shortDiagnosis.insufficientCandles, true);
assert.equal(shortDiagnosis.finalLabel, "Range");
assert.equal(shortDiagnosis.diagnosticLabel, "Range");
assert.equal(shortDiagnosis.subConditions, null);
assert.equal(shortDiagnosis.agreesWithProduction, true);

// --- classifyRangeBlocker ---

function fixtureDiagnosis(subConditions) {
  const trendUpConditions = [subConditions.emaAlignedUp, subConditions.priceAboveEma20, subConditions.adxPass, subConditions.rsiPassUp, subConditions.structureUp];
  const trendDownConditions = [subConditions.emaAlignedDown, subConditions.priceBelowEma20, subConditions.adxPass, subConditions.rsiPassDown, subConditions.structureDown];
  return {
    finalLabel: "Range",
    diagnosticLabel: "Range",
    agreesWithProduction: true,
    insufficientCandles: false,
    subConditions,
    trendUpConditionsMetCount: trendUpConditions.filter(Boolean).length,
    trendDownConditionsMetCount: trendDownConditions.filter(Boolean).length
  };
}

const structureOnlyBlockedUp = fixtureDiagnosis({
  breakoutUp: false, breakoutDown: false, volatilityLevel: "Normal",
  emaAlignedUp: true, emaAlignedDown: false, priceAboveEma20: true, priceBelowEma20: false,
  adxPass: true, rsiPassUp: true, rsiPassDown: false, structureUp: false, structureDown: false
});
assert.deepEqual(classifyRangeBlocker(structureOnlyBlockedUp), { direction: "up", blocker: "structureOnlyBlocker" });

const adxOnlyBlockedDown = fixtureDiagnosis({
  breakoutUp: false, breakoutDown: false, volatilityLevel: "Normal",
  emaAlignedUp: false, emaAlignedDown: true, priceAboveEma20: false, priceBelowEma20: true,
  adxPass: false, rsiPassUp: false, rsiPassDown: true, structureUp: false, structureDown: true
});
assert.deepEqual(classifyRangeBlocker(adxOnlyBlockedDown), { direction: "down", blocker: "adxOnlyBlocker" });

const multipleFailed = fixtureDiagnosis({
  breakoutUp: false, breakoutDown: false, volatilityLevel: "Normal",
  emaAlignedUp: false, emaAlignedDown: false, priceAboveEma20: false, priceBelowEma20: false,
  adxPass: false, rsiPassUp: false, rsiPassDown: false, structureUp: false, structureDown: false
});
assert.deepEqual(classifyRangeBlocker(multipleFailed), { direction: "up", blocker: "multipleConditionsFailed" });

// --- conditionNearMissAnalysis: structure blocks every near-miss, others block none ---

const rangeRecordsAllStructureBlocked = Array.from({ length: 5 }, () => ({ diagnosis: structureOnlyBlockedUp }));
const nearMissUp = conditionNearMissAnalysis(rangeRecordsAllStructureBlocked, "up");
assert.equal(nearMissUp.structure.nearMissSample, 5);
assert.equal(nearMissUp.structure.blockedByThisCondition, 5);
assert.equal(nearMissUp.structure.blockedRatePercent, 100);
assert.equal(nearMissUp.ema.nearMissSample, 0, "ema was never the sole holdout, so it has no near-miss sample");

// --- buildMarketRegimeDiagnosticReport aggregation ---

const report = buildMarketRegimeDiagnosticReport([
  { symbol: "BTC-USD", timeframe: "1h", diagnosis: { ...structureOnlyBlockedUp } },
  { symbol: "BTC-USD", timeframe: "1h", diagnosis: { ...structureOnlyBlockedUp } },
  { symbol: "ETH-USD", timeframe: "4h", diagnosis: { ...adxOnlyBlockedDown } },
  { symbol: "ETH-USD", timeframe: "4h", diagnosis: shortDiagnosis }
], { skipped: [{ symbol: "SOL-USD", timeframe: "5m", reason: "provider timeout" }] });

assert.equal(report.reportType, "market_regime_diagnostic");
assert.equal(report.symbolsAnalyzed, 2);
assert.equal(report.totalScans, 4);
assert.equal(report.insufficientCandleScans, 1);
assert.equal(report.labelDistribution.Range, 4);
assert.equal(report.rangeScansAnalyzed, 3, "the insufficient-candle scan is excluded from rangeScansAnalyzed");
assert.equal(report.rangeBreakdown.structureOnlyBlocker, 2);
assert.equal(report.rangeBreakdown.adxOnlyBlocker, 1);
assert.equal(report.rangeBreakdownByDirection.up.structureOnlyBlocker, 2);
assert.equal(report.rangeBreakdownByDirection.down.adxOnlyBlocker, 1);
assert.equal(report.structureIgnoredWouldQualify.up, 2);
assert.equal(report.skippedSymbolTimeframePairs, 1);
assert.equal(report.observationalOnly, true);
assert.equal(report.productionDecisionInput, false);
assert.equal(report.safety.changesProductionCode, false);

// --- parseMarketRegimeDiagnosticArguments ---

const parsed = parseMarketRegimeDiagnosticArguments(["--symbols", "BTC-USD,ETH-USD", "--timeframes", "1h,4h", "--lookback-days", "45", "--no-reload"]);
assert.deepEqual(parsed.symbols, ["BTC-USD", "ETH-USD"]);
assert.deepEqual(parsed.timeframes, ["1h", "4h"]);
assert.equal(parsed.lookbackDays, 45);
assert.equal(parsed.noReload, true);
assert.throws(() => parseMarketRegimeDiagnosticArguments(["--bogus", "x"]), /Unknown argument/);

// --- runMarketRegimeDiagnosticReport wiring, with injected dependencies (no network/DB) ---

const orchestrated = await runMarketRegimeDiagnosticReport(
  { windowSize: 90, targetSamples: 20, noReload: true },
  {
    listSymbolUniverse: async () => [{ symbol: "BTC-USD", timeframes: ["1h"] }, { symbol: "BAD-USD", timeframes: ["1h"] }],
    loadHistoricalCandles: async (symbol) => {
      if (symbol === "BAD-USD") throw new Error("simulated provider failure");
      return strongUptrend;
    }
  }
);
assert.equal(orchestrated.symbolsAnalyzed, 1);
assert.ok(orchestrated.totalScans > 0);
assert.equal(orchestrated.skippedSymbolTimeframePairs, 1);
assert.equal(orchestrated.skipped[0].symbol, "BAD-USD");
assert.equal(orchestrated.methodology.symbolTimeframePairsCovered, 2);

console.log("Market regime diagnostic report tests passed.");
