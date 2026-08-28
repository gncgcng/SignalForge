import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifySetupType,
  generateMarketDataSetup
} from "../src/modules/signals/signalGenerator.js";
import { analyzeSmartMoneyConcepts } from "../src/modules/market-data/smartMoneyConceptsService.js";
import { scoreMultiTimeframeConfluence } from "../src/modules/market-data/multiTimeframeService.js";
import { buildDynamicRiskPlan } from "../src/modules/risk/riskEngineService.js";

const generatorSource = readFileSync(
  new URL("../src/modules/signals/signalGenerator.js", import.meta.url),
  "utf8"
);
const serviceSource = readFileSync(
  new URL("../src/modules/signals/signalService.js", import.meta.url),
  "utf8"
);
const watcherSource = readFileSync(
  new URL("../src/modules/alerts/autoScanService.js", import.meta.url),
  "utf8"
);
const validationSource = readFileSync(
  new URL("../src/modules/signals/signalValidationService.js", import.meta.url),
  "utf8"
);
const backtestSource = readFileSync(
  new URL("../src/modules/backtesting/backtestService.js", import.meta.url),
  "utf8"
);

const classifyBody = generatorSource.slice(
  generatorSource.indexOf("export function classifySetupType"),
  generatorSource.indexOf("function calculateQualityScore")
);
const discoveredStrategies = [...classifyBody.matchAll(/return\s+"([^"]+)"/g)]
  .map((match) => match[1]);
const expectedStrategies = [
  "Liquidity sweep reversal",
  "Breakout retest",
  "Momentum breakout",
  "VWAP reclaim/rejection",
  "Multi-timeframe continuation",
  "Pullback bounce",
  "Support/resistance retest",
  "Trend continuation",
  "Range bounce",
  "Mean reversion"
];
assert.deepEqual(discoveredStrategies, expectedStrategies, "production strategy inventory changed");

const findings = [];
const cases = [];

for (const strategy of expectedStrategies) {
  const longFixture = fixtureFor(strategy, "long");
  const shortFixture = fixtureFor(strategy, "short");
  const longResult = classify(longFixture);
  const shortResult = classify(shortFixture);
  assert.equal(longResult, strategy, `${strategy} valid LONG fixture did not classify`);
  assert.equal(shortResult, strategy, `${strategy} valid SHORT fixture did not classify`);
  cases.push({ strategy, validLong: longResult, validShort: shortResult, mirrored: true });
}

const nearMisses = [
  ["Liquidity sweep reversal", { ...fixtureFor("Liquidity sweep reversal", "long"), smcState: null }],
  ["Breakout retest", fixtureFor("Breakout retest", "long", { previousClose: 104.8 })],
  ["Momentum breakout", fixtureFor("Momentum breakout", "long", { latestClose: 104.9, latestHigh: 106.5 })],
  ["VWAP reclaim/rejection", (() => {
    const fixture = fixtureFor("VWAP reclaim/rejection", "long");
    return {
      ...fixture,
      advancedStructure: { vwap: { ...fixture.advancedStructure.vwap, event: "None" } }
    };
  })()],
  ["Multi-timeframe continuation", { ...fixtureFor("Multi-timeframe continuation", "long"), confluenceContext: { higherTimeframes: [] } }],
  ["Pullback bounce", { ...fixtureFor("Pullback bounce", "long"), ema20: 98 }],
  ["Support/resistance retest", { ...fixtureFor("Support/resistance retest", "long"), nearestSupport: { price: 96 } }],
  ["Trend continuation", { ...fixtureFor("Trend continuation", "long"), trendStrength: 0.4 }],
  ["Range bounce", { ...fixtureFor("Range bounce", "long"), supportStrength: 1 }],
  ["Mean reversion", { ...fixtureFor("Mean reversion", "long"), rsi14: 55 }]
];
for (const [strategy, fixture] of nearMisses) {
  const actual = classify(fixture);
  assert.notEqual(actual, strategy, `${strategy} near-miss still classified as the same strategy`);
  const mirrored = mirrorNearMiss(fixture, strategy);
  assert.notEqual(classify(mirrored), strategy, `${strategy} mirrored SHORT near-miss still classified as the same strategy`);
}

auditMomentumReferenceGap();
auditBreakoutRetestSemantics();
auditLiquiditySweepFreshness();
auditRemainingStrategySemantics();
auditRegimeAndTimeframeSemantics();
auditRiskCompatibility();
auditPipelineParity();
auditBacktestParity();
auditDeadAliases();
auditClassicalPatternSeparation();
auditMarketQualityVulnerability();

const fullGeneratorCharacterization = characterizeFullGenerator();

console.log(JSON.stringify({
  auditType: "strategy_correctness_characterization",
  productionBehaviorChanged: true,
  productionBehaviorScope: "Momentum breakout reference-window freshness only in this change",
  reachableStrategyCount: discoveredStrategies.length,
  discoveredStrategies,
  mirroredClassificationCases: cases,
  confirmedFindings: findings,
  fullGeneratorCharacterization,
  parity: {
    manualCore: "scanMarketSetupDetailed -> getMultiTimeframeMarketData -> generateMarketDataSetup",
    watcherCore: "runAutoCryptoAlertScan -> scanMarketSetupDetailed -> getMultiTimeframeMarketData -> generateMarketDataSetup"
  }
}, null, 2));

function auditMomentumReferenceGap() {
  const fixture = fixtureFor("Momentum breakout", "long");
  const candles = fixture.candles.map((candle) => ({ ...candle }));
  const priorHigh = 105;
  candles[candles.length - 3] = candle(candles.length - 3, 104.8, priorHigh + 1.2, priorHigh + 1.4, 104.5, 130);
  candles[candles.length - 2] = candle(candles.length - 2, priorHigh + 0.2, priorHigh - 0.2, priorHigh + 0.4, priorHigh - 0.5, 110);
  candles[candles.length - 1] = candle(candles.length - 1, priorHigh - 0.1, priorHigh + 1, priorHigh + 1.2, priorHigh - 0.3, 150);
  const actual = classify({ ...fixture, candles });
  assert.notEqual(actual, "Momentum breakout");
  findings.push({
    severity: "LOW",
    classification: "NO MATERIAL ISSUE",
    strategy: "Momentum breakout",
    code: "signalGenerator.js:evaluateMomentumBreakoutSetup",
    finding: "Freshness now checks strict closes at both intervening completed candles (-3 and -2) while preserving the -24..-4 reference window and -1 trigger.",
    observed: actual
  });
}

function auditBreakoutRetestSemantics() {
  const clean = fixtureFor("Breakout retest", "long");
  assert.equal(classify(clean), "Breakout retest");

  const wickOnlyBreakout = fixtureFor("Breakout retest", "long", {
    previousClose: 104.8,
    previousHigh: 106.2
  });
  assert.notEqual(classify(wickOnlyBreakout), "Breakout retest");

  const deepFailure = fixtureFor("Breakout retest", "long", {
    latestOpen: 106.5,
    latestLow: 98,
    latestClose: 105.2,
    latestHigh: 106.8
  });
  assert.notEqual(classify(deepFailure), "Breakout retest");

  const bearishRetest = fixtureFor("Breakout retest", "long", {
    latestOpen: 106.8,
    latestLow: 105.1,
    latestClose: 105.4,
    latestHigh: 107
  });
  assert.notEqual(classify(bearishRetest), "Breakout retest");

  const noRetest = fixtureFor("Momentum breakout", "long", {
    previousClose: 104.7,
    latestOpen: 105.2,
    latestLow: 105.1,
    latestClose: 106.2
  });
  assert.notEqual(classify(noRetest), "Breakout retest");
}

function auditLiquiditySweepFreshness() {
  const base = buildSweepCandles("long");
  const latestSweep = analyzeSmartMoneyConcepts(base);
  assert.equal(latestSweep.liquiditySweep?.direction, "long");
  assert.equal(latestSweep.liquiditySweepReversal?.direction, "long");

  const staleButRetained = [
    ...base,
    candle(base.length, 100, 100, 100.4, 99.8, 100),
    candle(base.length + 1, 100, 100.4, 100.6, 99.8, 100)
  ];
  const smc = analyzeSmartMoneyConcepts(staleButRetained);
  assert.equal(smc.liquiditySweep?.direction, "long");
  assert.equal(smc.liquiditySweepReversal, null);

  const fixture = fixtureFor("Liquidity sweep reversal", "long");
  assert.notEqual(
    classify({ ...fixture, candles: staleButRetained, smcState: smc }),
    "Liquidity sweep reversal"
  );

  const doubleSweep = analyzeSmartMoneyConcepts(buildDoubleSweepCandles());
  assert.equal(doubleSweep.liquiditySweep?.direction, "long");
  assert.equal(doubleSweep.liquiditySweepReversal?.ambiguous, true);
  assert.notEqual(
    classify({ ...fixture, candles: buildDoubleSweepCandles(), smcState: doubleSweep }),
    "Liquidity sweep reversal"
  );
}

function auditRemainingStrategySemantics() {
  const mixedHtf = fixtureFor("Multi-timeframe continuation", "long");
  mixedHtf.confluenceContext = {
    lowerTimeframe: "5m",
    higherTimeframes: [
      { timeframe: "15m", available: true, regime: strongRegime("long") },
      { timeframe: "1h", available: true, regime: strongRegime("short") },
      { timeframe: "4h", available: true, regime: strongRegime("short") }
    ]
  };
  assert.notEqual(classify(mixedHtf), "Multi-timeframe continuation");
  const mixedScore = scoreMultiTimeframeConfluence(mixedHtf.confluenceContext, "long");
  assert.equal(mixedScore.badge, "Countertrend");
  assert.ok(mixedScore.score >= 25);

  const pullbackWithoutPullback = fixtureFor("Pullback bounce", "long", {
    previousClose: 102.1,
    latestOpen: 102.05,
    latestLow: 102,
    latestHigh: 102.5,
    latestClose: 102.3
  });
  pullbackWithoutPullback.candles[25] = candle(25, 101.5, 101.8, 102, 101.4, 110);
  pullbackWithoutPullback.candles[26] = candle(26, 101.7, 102, 102.2, 101.6, 110);
  pullbackWithoutPullback.candles[27] = candle(27, 102, 102.1, 102.3, 101.9, 110);
  assert.notEqual(classify(pullbackWithoutPullback), "Pullback bounce");
  findings.push({
    severity: "LOW",
    classification: "NO MATERIAL ISSUE",
    strategy: "Pullback bounce",
    code: "signalGenerator.js:evaluatePullbackBounceSetup",
    finding: "The classifier now requires a directional Trend regime, prior trend-side extension, a two-candle countertrend pullback, bounded EMA20 interaction, trend hold, and fresh continuation away from EMA20.",
    observed: "persistent EMA proximity no longer receives the Pullback bounce label"
  });

  const srWithoutTouch = fixtureFor("Support/resistance retest", "long", {
    latestOpen: 96,
    latestLow: 96,
    latestHigh: 97.5,
    latestClose: 97.2
  });
  assert.notEqual(classify(srWithoutTouch), "Support/resistance retest");
  findings.push({
    severity: "LOW",
    classification: "NO MATERIAL ISSUE",
    strategy: "Support/resistance retest",
    code: "signalGenerator.js:evaluateSupportResistanceRetestSetup",
    finding: "The classifier now requires an established level, prior separation, bounded interaction, a valid-side close, directional confirmation, and freshness.",
    observed: "no-touch proximity no longer receives the retest label"
  });

  const trendSingleCandle = fixtureFor("Trend continuation", "long");
  const ordinaryTrendCandle = withShape(trendSingleCandle, {
    previousClose: 103,
    previousHigh: 104,
    previousLow: 101,
    latestOpen: 103,
    latestHigh: 104.2,
    latestLow: 102.4,
    latestClose: 104.1
  });
  ordinaryTrendCandle.candles[ordinaryTrendCandle.candles.length - 3] = candle(26, 101.5, 102.8, 103, 101.2, 100);
  assert.notEqual(classify(ordinaryTrendCandle), "Trend continuation");
  findings.push({
    severity: "LOW",
    classification: "NO MATERIAL ISSUE",
    strategy: "Trend continuation",
    code: "signalGenerator.js:evaluateTrendContinuationSetup",
    finding: "The classifier now requires the matching trend regime, intact EMA hierarchy, a compact immediate pause, and a fresh quality expansion close beyond that pause.",
    observed: "ordinary directional trend candle without a pause rejected"
  });

  const rangeWithoutTouch = fixtureFor("Range bounce", "long", {
    latestOpen: 97.2,
    latestLow: 97,
    latestHigh: 98.5,
    latestClose: 97.5
  });
  assert.notEqual(classify(rangeWithoutTouch), "Range bounce");
  findings.push({
    severity: "LOW",
    classification: "NO MATERIAL ISSUE",
    strategy: "Range bounce",
    code: "signalGenerator.js:evaluateRangeBounceSetup",
    finding: "The classifier now requires a confirmed two-sided range, prior in-range approach, bounded boundary interaction, an inside close, and fresh movement toward the midpoint.",
    observed: "no-touch proximity no longer receives the Range bounce label"
  });

  const meanWithoutReversal = fixtureFor("Mean reversion", "long", {
    latestOpen: 98.2,
    latestHigh: 98.4,
    latestLow: 96.4,
    latestClose: 97.4
  });
  assert.ok(meanWithoutReversal.candles.at(-1).close < meanWithoutReversal.candles.at(-1).open);
  assert.notEqual(classify(meanWithoutReversal), "Mean reversion");
  findings.push({
    severity: "LOW",
    classification: "NO MATERIAL ISSUE",
    strategy: "Mean reversion",
    code: "signalGenerator.js:evaluateMeanReversionSetup",
    finding: "The classifier now requires EMA20-normalized extension, structural context, directional reversal, and fresh movement back toward the mean.",
    observed: "bearish LONG trigger no longer receives the Mean reversion label"
  });

  const vwap = fixtureFor("VWAP reclaim/rejection", "long");
  vwap.ema20 = 106;
  vwap.ema50 = 107;
  assert.equal(classify(vwap), "VWAP reclaim/rejection");
  findings.push({
    severity: "LOW",
    classification: "NO MATERIAL ISSUE",
    strategy: "VWAP reclaim/rejection",
    code: "advancedMarketStructureService.js:calculateVwapContext; signalGenerator.js:evaluateVwapReclaimRejectionSetup",
    finding: "The classifier now requires same-session VWAP context, ATR-normalized prior displacement, actual VWAP interaction, accepted close distance, directional body quality, and a fresh latest-candle event.",
    observed: "EMA alignment is not required by this reversal/event strategy"
  });
}

function auditRegimeAndTimeframeSemantics() {
  const validationRules = {
    trendDirectionBlocked: generatorSource.includes('regime.label === "Trend Up" && candidate.direction !== "long"') &&
      generatorSource.includes('regime.label === "Trend Down" && candidate.direction !== "short"'),
    rangeWhitelist: generatorSource.includes('["Range bounce", "Mean reversion", "Liquidity sweep reversal"].includes(setupType)'),
    breakoutWhitelist: generatorSource.includes('["Breakout retest", "Momentum breakout", "VWAP reclaim/rejection"].includes(setupType)'),
    lowVolatilityConditional: generatorSource.includes('regime.label === "Low Volatility" && levelStrength < 3'),
    countertrendThreshold: generatorSource.includes('confluence.badge === "Countertrend" && confluence.score < 25')
  };
  assert.ok(Object.values(validationRules).every(Boolean));
  findings.push({
    severity: "MEDIUM",
    classification: "PERMISSIVE RULE",
    strategy: "engine-wide",
    code: "signalGenerator.js:408-410",
    finding: "Higher-timeframe countertrend is a hard block only below score 25. Countertrend scores from 25 upward remain eligible with a confidence/quality penalty.",
    observed: validationRules
  });

  const timeframeDurations = {
    "5m": { breakoutReference: "105 minutes", sweepMaximumAge: "1 candle" },
    "15m": { breakoutReference: "315 minutes", sweepMaximumAge: "1 candle" },
    "1h": { breakoutReference: "21 hours", sweepMaximumAge: "1 candle" },
    "4h": { breakoutReference: "84 hours", sweepMaximumAge: "1 candle" }
  };
  findings.push({
    severity: "MEDIUM",
    classification: "PERMISSIVE RULE",
    strategy: "engine-wide timeframe semantics",
    code: "signalGenerator.js:725; smartMoneyConceptsService.js:85",
    finding: "Fixed candle windows change semantic freshness substantially across 5m, 15m, 1h, and 4h.",
    observed: timeframeDurations
  });
}

function auditRiskCompatibility() {
  const shared = {
    direction: "long",
    entry: 100,
    atr: 2,
    regime: { label: "Trend Up", trendStrength: 0.7 },
    qualityScore: 90,
    protectiveLevel: { price: 96 },
    opposingLevel: { price: 112 }
  };
  const plans = Object.fromEntries(expectedStrategies.map((strategy) => [
    strategy,
    buildDynamicRiskPlan({ ...shared, setupType: strategy })
  ]));
  assert.ok(Object.values(plans).every((plan) => plan.stopLoss === plans["Trend continuation"].stopLoss));
  findings.push({
    severity: "HIGH",
    classification: "RISK-ENGINE MISMATCH",
    strategy: "Breakout retest / Liquidity sweep reversal / VWAP / Pullback / Range / Mean reversion",
    code: "riskEngineService.js:20-32,151-159",
    finding: "All strategies share the same nearest support/resistance plus ATR stop model. Retest lows/highs, sweep wicks, VWAP invalidation, EMA invalidation, and range boundaries are not passed as strategy-specific protective levels.",
    observed: Object.fromEntries(Object.entries(plans).map(([strategy, plan]) => [strategy, {
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      riskRewardRatio: plan.riskRewardRatio,
      stopStyle: plan.stopStyle
    }]))
  });
}

function auditPipelineParity() {
  assert.ok(serviceSource.includes("const result = generateMarketDataSetup(marketData, timeframe"));
  assert.ok(serviceSource.includes("export async function scanMarketSetupDetailed"));
  assert.ok(watcherSource.includes("scanMarketSetupDetailed(user"));
  assert.ok(watcherSource.includes('source: "auto_crypto_watcher"'));
  assert.equal(watcherSource.includes("generateMarketDataSetup("), false);
  findings.push({
    severity: "LOW",
    classification: "NO MATERIAL ISSUE",
    strategy: "Manual Scan / Auto Watcher parity",
    code: "signalService.js:418-465; autoScanService.js:209-215,284-289",
    finding: "Both paths share market-data loading, live classification, risk planning, readiness, publication validation, learning calibration, and Quality Gate through scanMarketSetupDetailed. Watcher-only work starts after fullSetup.",
    observed: "same canonical generator and trade levels"
  });

  findings.push({
    severity: "LOW",
    classification: "NO MATERIAL ISSUE",
    strategy: "source-specific confidence",
    code: "signalService.js:419,447-455; signalConfidenceCalibrationService.js:710",
    finding: "The generation source is intentionally passed into historical calibration. Identical candles can therefore retain identical strategy/levels but receive different final confidence when manual_scan and auto_crypto_watcher have different source history.",
    observed: "documented downstream source distinction"
  });
}

function auditBacktestParity() {
  assert.ok(backtestSource.includes("function classifyHistoricalSetup"));
  assert.equal(backtestSource.includes("generateMarketDataSetup("), false);
  assert.equal(backtestSource.includes("buildDynamicRiskPlan("), false);
  findings.push({
    severity: "HIGH",
    classification: "CODE BUG",
    strategy: "Strategy Lab backtest architecture",
    code: "backtestService.js:337-480,513-552",
    finding: "The built-in backtester has a separate strategy classifier, confluence threshold, stop formula, target formula, and quality model. It is not production-parity and even names Multi-timeframe continuation from trend strength without requiring an aligned higher timeframe.",
    observed: "historical classifier/risk implementation diverges from live generator"
  });
}

function auditDeadAliases() {
  const acceptedAliases = ["Liquidity sweep", "VWAP Reclaim", "Support Retest"];
  for (const alias of acceptedAliases) assert.ok(validationSource.includes(`"${alias}"`));
  for (const alias of acceptedAliases) assert.equal(discoveredStrategies.includes(alias), false);
  findings.push({
    severity: "LOW",
    classification: "NAMING ISSUE",
    strategy: "dead validation aliases",
    code: "signalValidationService.js:3-17",
    finding: "Liquidity sweep, VWAP Reclaim, and Support Retest are accepted by publication validation but are never emitted by the current live classifier. Reversal and Qualified setup are also display/fallback labels, not reachable primary strategies.",
    observed: acceptedAliases
  });
}

function auditClassicalPatternSeparation() {
  const patternAttachIndex = generatorSource.indexOf("attachRelevantPatternContext(validateCandidate(");
  const validationIndex = generatorSource.indexOf("function validateCandidate");
  assert.ok(patternAttachIndex > 0 && validationIndex > 0);
  assert.ok(generatorSource.includes("patternContext: bestCase.patternContext"));
  findings.push({
    severity: "LOW",
    classification: "NO MATERIAL ISSUE",
    strategy: "classical pattern separation",
    code: "signalGenerator.js:68-93,1280-1313",
    finding: "Confirmed classical patterns are attached after candidate validation and do not qualify a primary strategy, entry, stop, target, or eligibility.",
    observed: "decorative/reasoning context only"
  });
}

function auditMarketQualityVulnerability() {
  const lowVolume = fixtureFor("Momentum breakout", "long");
  lowVolume.volumeMa20 = 0.000001;
  lowVolume.candles = lowVolume.candles.map((item, index) => ({
    ...item,
    volume: index === lowVolume.candles.length - 1 ? 0.0000011 : 0.000001
  }));
  assert.equal(classify(lowVolume), "Momentum breakout");
  const zeroVolume = fixtureFor("Momentum breakout", "long");
  zeroVolume.volumeMa20 = 0;
  zeroVolume.candles = zeroVolume.candles.map((item) => ({ ...item, volume: 0 }));
  assert.equal(classify(zeroVolume), "Momentum breakout");
  findings.push({
    severity: "HIGH",
    classification: "DATA-QUALITY VULNERABILITY",
    strategy: "Momentum breakout and volume-preferred strategies",
    code: "signalGenerator.js:751,1093-1106",
    finding: "Volume checks are relative only. A tiny absolute baseline can pass a 1.02x classifier threshold and 1.05x generic confirmation threshold without meaningful liquidity.",
    observed: "near-zero and zero/zero volume can satisfy classifier-level volume comparison"
  });
}

function characterizeFullGenerator() {
  const flat = Array.from({ length: 120 }, (_, index) => candle(
    index,
    100 + Math.sin(index * 0.6) * 0.05,
    100 + Math.sin((index + 1) * 0.6) * 0.05,
    100.2,
    99.8,
    0
  ));
  const result = generateMarketDataSetup({
    pair: { symbol: "TEST-USD", assetClass: "Crypto" },
    source: "audit-fixture",
    volumeAvailable: true,
    candles: flat,
    confluence: { higherTimeframes: [] }
  }, "15m");
  assert.equal(result.valid, false);
  return {
    zeroVolumeFlatMarketCreatesSignal: result.valid,
    resultType: result.analysis?.message || null,
    note: "Classifier-level low-volume vulnerability does not mean every low-volume fixture survives the complete generator."
  };
}

function fixtureFor(strategy, direction, shape = {}) {
  const long = buildLongFixture(strategy, shape);
  return direction === "long" ? long : mirrorFixture(long, strategy);
}

function buildLongFixture(strategy, shape = {}) {
  const defaults = {
    previousClose: 103,
    previousHigh: 104,
    previousLow: 101,
    latestOpen: 103,
    latestHigh: 104,
    latestLow: 102,
    latestClose: 103.4,
    latestVolume: 140
  };
  const s = { ...defaults, ...shape };
  const candles = baseCandles();
  candles.push(candle(27, 103, s.previousClose, s.previousHigh, s.previousLow, 110));
  candles.push(candle(28, s.latestOpen, s.latestClose, s.latestHigh, s.latestLow, s.latestVolume));
  const base = {
    direction: "long",
    candles,
    ema20: 102,
    ema50: 100,
    rsi14: 55,
    atr14: 2,
    volumeMa20: 100,
    nearestSupport: { price: 98 },
    nearestResistance: { price: 110 },
    supportStrength: 3,
    resistanceStrength: 3,
    regimeLabel: "Trend Up",
    trendStrength: 0.45,
    smcState: null,
    advancedStructure: null,
    confluenceContext: null
  };

  if (strategy === "Liquidity sweep reversal") {
    const sweepFixture = withShape(base, {
      previousClose: 101,
      previousHigh: 104,
      latestOpen: 100.8,
      latestHigh: 102,
      latestLow: 94.5,
      latestClose: 101.8,
      ...shape
    });
    return {
      ...sweepFixture,
      smcState: analyzeSmartMoneyConcepts(sweepFixture.candles)
    };
  }
  if (strategy === "Breakout retest") {
    return withShape(base, { previousClose: 106, previousHigh: 106.4, latestOpen: 105.4, latestHigh: 106.8, latestLow: 105.2, latestClose: 106.2, ...shape });
  }
  if (strategy === "Momentum breakout") {
    return withShape(base, { previousClose: 104.5, previousHigh: 104.8, latestOpen: 104.8, latestHigh: 106.8, latestLow: 104.6, latestClose: 106.2, ...shape });
  }
  if (strategy === "VWAP reclaim/rejection") {
    const reclaim = withShape(base, {
      previousClose: 102.7,
      previousHigh: 103,
      previousLow: 102.4,
      latestOpen: 102.6,
      latestHigh: 103.8,
      latestLow: 102.5,
      latestClose: 103.6,
      ...shape
    });
    return {
      ...reclaim,
      advancedStructure: {
        vwap: {
          event: "Reclaim",
          session: { id: "fixture-session", value: 103.1, anchorTime: reclaim.candles[0].time },
          previousSessionId: "fixture-session",
          previousVwap: 103.1,
          sameSession: true
        }
      }
    };
  }
  if (strategy === "Multi-timeframe continuation") {
    return {
      ...base,
      confluenceContext: {
        lowerTimeframe: "15m",
        higherTimeframes: [
          { timeframe: "1h", available: true, regime: strongRegime("long") },
          { timeframe: "4h", available: true, regime: strongRegime("long") }
        ]
      }
    };
  }
  if (strategy === "Pullback bounce") {
    const pullback = withShape(base, {
      previousClose: 102.8,
      previousHigh: 104,
      previousLow: 102.6,
      latestOpen: 102.4,
      latestHigh: 104,
      latestLow: 101.8,
      latestClose: 103.6,
      ...shape
    });
    pullback.candles[25] = candle(25, 104.8, 105, 106, 104.5, 120);
    pullback.candles[26] = candle(26, 105, 104, 105.2, 103.8, 115);
    return {
      ...pullback,
      ema20: 102,
      ema50: 100,
      regimeLabel: "Trend Up",
      trendStrength: 0.45
    };
  }
  if (strategy === "Support/resistance retest") {
    const retest = withShape(base, {
      previousClose: 101,
      previousHigh: 103,
      previousLow: 99,
      latestOpen: 95.8,
      latestHigh: 97.6,
      latestLow: 95.2,
      latestClose: 97,
      ...shape
    });
    return {
      ...retest,
      ema20: 95.2,
      ema50: 93,
      nearestSupport: { price: 95, time: retest.candles[12].time }
    };
  }
  if (strategy === "Trend continuation") {
    const continuation = withShape(base, {
      previousClose: 103.5,
      previousHigh: 103.8,
      previousLow: 103.2,
      latestOpen: 103.45,
      latestHigh: 105.45,
      latestLow: 103.35,
      latestClose: 105.2,
      ...shape
    });
    continuation.candles[25] = candle(25, 102.6, 103.4, 106, 102.5, 110);
    continuation.candles[26] = candle(26, 103.25, 103.4, 103.7, 103.1, 80);
    return { ...continuation, ema20: 101, trendStrength: 0.78 };
  }
  if (strategy === "Range bounce") {
    const range = withShape(base, {
      previousClose: 97,
      previousHigh: 101,
      previousLow: 96.5,
      latestOpen: 96.8,
      latestHigh: 98.5,
      latestLow: 95.2,
      latestClose: 97.5,
      ...shape
    });
    return {
      ...range,
      ema20: 100,
      ema50: 99,
      regimeLabel: "Range",
      trendStrength: 0.25,
      nearestSupport: { price: 95, time: range.candles[12].time },
      nearestResistance: { price: 105, time: range.candles[10].time },
      rsi14: 50
    };
  }
  if (strategy === "Mean reversion") {
    return {
      ...withShape(base, {
        latestOpen: 97,
        latestHigh: 98.6,
        latestLow: 96.4,
        latestClose: 98.2,
        ...shape
      }),
      ema20: 100,
      ema50: 99,
      regimeLabel: "High Volatility",
      trendStrength: 0.35,
      nearestSupport: { price: 96 },
      rsi14: 46
    };
  }
  throw new Error(`Missing fixture for ${strategy}`);
}

function withShape(fixture, shape) {
  const candles = fixture.candles.map((item) => ({ ...item }));
  candles[candles.length - 2] = candle(
    candles.length - 2,
    103,
    shape.previousClose,
    shape.previousHigh,
    shape.previousLow ?? 101,
    110
  );
  candles[candles.length - 1] = candle(
    candles.length - 1,
    shape.latestOpen,
    shape.latestClose,
    shape.latestHigh,
    shape.latestLow,
    shape.latestVolume ?? 140
  );
  return { ...fixture, candles };
}

function mirrorFixture(fixture, strategy) {
  const mirrorPrice = (value) => 200 - Number(value);
  const candles = fixture.candles.map((item) => ({
    ...item,
    open: mirrorPrice(item.open),
    close: mirrorPrice(item.close),
    high: mirrorPrice(item.low),
    low: mirrorPrice(item.high)
  }));
  const mirroredSmcState = fixture.smcState
    ? strategy === "Liquidity sweep reversal"
      ? analyzeSmartMoneyConcepts(candles)
      : { liquiditySweep: { ...fixture.smcState.liquiditySweep, direction: "short" } }
    : null;
  return {
    ...fixture,
    direction: "short",
    candles,
    ema20: mirrorPrice(fixture.ema20),
    ema50: mirrorPrice(fixture.ema50),
    rsi14: 100 - fixture.rsi14,
    nearestSupport: fixture.nearestResistance ? {
      ...fixture.nearestResistance,
      price: mirrorPrice(fixture.nearestResistance.price)
    } : null,
    nearestResistance: fixture.nearestSupport ? {
      ...fixture.nearestSupport,
      price: mirrorPrice(fixture.nearestSupport.price)
    } : null,
    supportStrength: fixture.resistanceStrength,
    resistanceStrength: fixture.supportStrength,
    regimeLabel: fixture.regimeLabel === "Trend Up" ? "Trend Down" : fixture.regimeLabel,
    smcState: mirroredSmcState,
    advancedStructure: fixture.advancedStructure && strategy === "VWAP reclaim/rejection" ? {
      vwap: {
        ...fixture.advancedStructure.vwap,
        event: "Rejection",
        session: {
          ...fixture.advancedStructure.vwap.session,
          value: mirrorPrice(fixture.advancedStructure.vwap.session.value)
        },
        previousVwap: mirrorPrice(fixture.advancedStructure.vwap.previousVwap)
      }
    } : fixture.advancedStructure,
    confluenceContext: fixture.confluenceContext ? {
      lowerTimeframe: fixture.confluenceContext.lowerTimeframe,
      higherTimeframes: fixture.confluenceContext.higherTimeframes.map((item) => ({
        ...item,
        regime: strongRegime("short")
      }))
    } : null,
    expectedStrategy: strategy
  };
}

function mirrorNearMiss(fixture, strategy) {
  const mirrored = mirrorFixture(fixture, strategy);
  if (strategy === "VWAP reclaim/rejection") {
    mirrored.advancedStructure = {
      vwap: { ...mirrored.advancedStructure.vwap, event: "None" }
    };
  }
  if (strategy === "Multi-timeframe continuation") {
    mirrored.confluenceContext = { higherTimeframes: [] };
  }
  return mirrored;
}

function classify(fixture) {
  return classifySetupType(
    fixture.direction,
    fixture.candles,
    {
      ema20: fixture.ema20,
      ema50: fixture.ema50,
      rsi14: fixture.rsi14,
      atr14: fixture.atr14,
      volumeMa20: fixture.volumeMa20
    },
    {
      nearestSupport: fixture.nearestSupport,
      nearestResistance: fixture.nearestResistance,
      supportStrength: fixture.supportStrength,
      resistanceStrength: fixture.resistanceStrength
    },
    {
      label: fixture.regimeLabel,
      trendStrength: fixture.trendStrength
    },
    fixture.smcState,
    fixture.advancedStructure,
    fixture.confluenceContext
  );
}

function baseCandles() {
  return Array.from({ length: 27 }, (_, index) => candle(
    index,
    100,
    101,
    index === 10 ? 105 : 103,
    index === 12 ? 95 : 97,
    100
  ));
}

function buildSweepCandles(direction) {
  const candles = Array.from({ length: 26 }, (_, index) => {
    const high = index === 12 ? 104 : 102;
    const low = index === 14 ? 96 : 98;
    return candle(index, 100, 100.2, high, low, 100);
  });
  if (direction === "long") {
    candles.push(candle(26, 97, 97.5, 98, 95, 130));
    candles.push(candle(27, 97.5, 100, 100.4, 94.5, 150));
  } else {
    candles.push(candle(26, 103, 102.5, 104, 102, 130));
    candles.push(candle(27, 102.5, 100, 105.5, 99.6, 150));
  }
  return candles;
}

function buildDoubleSweepCandles() {
  const candles = Array.from({ length: 29 }, (_, index) => candle(
    index,
    100,
    100,
    index === 10 ? 105 : 102,
    index === 14 ? 95 : 98,
    100
  ));
  candles.push(candle(29, 100, 100, 106, 94, 150));
  return candles;
}

function strongRegime(direction) {
  const long = direction === "long";
  return {
    label: long ? "Trend Up" : "Trend Down",
    preferredDirection: direction,
    trendStrength: 0.75,
    metrics: {
      ema20: long ? 105 : 95,
      ema50: 100,
      rsi14: long ? 60 : 40,
      adx14: 30,
      structure: long ? "Higher highs / higher lows" : "Lower highs / lower lows",
      latestPrice: 100,
      support: 90,
      resistance: 110
    }
  };
}

function candle(index, open, close, high, low, volume) {
  return {
    time: 1_700_000_000 + index * 900,
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
    volume
  };
}
