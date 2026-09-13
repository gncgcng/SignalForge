import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  calculateAdaptiveQualityAdjustment,
  calculateAdaptiveQualityAdjustmentShadow
} from "../src/modules/analyst/signalAnalystService.js";
import {
  calculateCrossStrategyWatchDiagnostics,
  CROSS_STRATEGY_LIST,
  CROSS_STRATEGY_WATCH_STARTED_AT,
  CROSS_STRATEGY_WATCH_VERSION
} from "../src/modules/signals/crossStrategyWatchDiagnostics.js";
import {
  buildCrossStrategyWatchReport,
  sampleLabel
} from "./cross-strategy-watch-report.js";

const baseCandidate = {
  setupType: "Momentum breakout",
  qualityScore: 74,
  regime: "Trending",
  confirmations: [{ name: "Volume", passed: true }, { name: "RSI", passed: true }],
  confluence: { badge: "Partial Alignment" },
  session: { liquidity: "Low" },
  newsRisk: { level: "Elevated" },
  smc: { factors: [] },
  marketStructure: { vwapAligned: false, volumeProfileAligned: false },
  correlation: { aligned: false, conflict: false },
  riskPlan: { riskTier: "High quality" }
};

const adaptiveProfile = {
  adaptive: true,
  factors: [
    { key: "volume", label: "Volume confirmation", usefulnessScore: -30, sampleSufficient: true },
    { key: "highQualityRisk", label: "High-quality risk tier", usefulnessScore: -40, sampleSufficient: true },
    { key: "trend", label: "Trend alignment", usefulnessScore: 10, sampleSufficient: true }
  ]
};

// --- calculateAdaptiveQualityAdjustmentShadow: restored pre-49ba207 math, diagnostic-only ---

const inactiveProfileResult = calculateAdaptiveQualityAdjustmentShadow(baseCandidate, { adaptive: false, factors: [] });
assert.equal(inactiveProfileResult.adjustment, 0);
assert.equal(inactiveProfileResult.diagnosticOnly, true);

const candidateBefore = JSON.parse(JSON.stringify(baseCandidate));
const profileBefore = JSON.parse(JSON.stringify(adaptiveProfile));
const shadowResult = calculateAdaptiveQualityAdjustmentShadow(baseCandidate, adaptiveProfile);
assert.equal(shadowResult.adjustment, -2, "two sample-sufficient, strongly negative factors should sum to -2");
assert.deepEqual(shadowResult.factors.map((factor) => factor.key).sort(), ["highQualityRisk", "volume"]);
assert.equal(shadowResult.diagnosticOnly, true);
assert.deepEqual(baseCandidate, candidateBefore, "shadow calculation must not mutate the candidate");
assert.deepEqual(adaptiveProfile, profileBefore, "shadow calculation must not mutate the profile");

// clamp check: manufacture enough negative factors to exceed maximumAdaptiveAdjustment (5)
const heavyProfile = {
  adaptive: true,
  factors: [
    { key: "volume", usefulnessScore: -30, sampleSufficient: true },
    { key: "highQualityRisk", usefulnessScore: -30, sampleSufficient: true },
    { key: "trend", usefulnessScore: -30, sampleSufficient: true },
    { key: "rsi", usefulnessScore: -30, sampleSufficient: true },
    { key: "supportResistance", usefulnessScore: -30, sampleSufficient: true },
    { key: "fullConfluence", usefulnessScore: -30, sampleSufficient: true },
    { key: "activeSession", usefulnessScore: -30, sampleSufficient: true }
  ]
};
const heavyCandidate = {
  ...baseCandidate,
  confirmations: [{ name: "Volume", passed: true }, { name: "RSI", passed: true }, { name: "Support", passed: true }],
  confluence: { badge: "Full Alignment" },
  session: { liquidity: "Highest" }
};
const clampedShadow = calculateAdaptiveQualityAdjustmentShadow(heavyCandidate, heavyProfile);
assert.equal(clampedShadow.adjustment, -5, "adjustment must clamp to maximumAdaptiveAdjustment");

// production path stays disabled regardless of profile strength
const productionResult = calculateAdaptiveQualityAdjustment(heavyCandidate, heavyProfile);
assert.equal(productionResult.adjustment, 0, "production adjustment must remain 0 post-49ba207");
assert.deepEqual(productionResult.factors, []);

// --- calculateCrossStrategyWatchDiagnostics: boundary-crossing math ---

assert.equal(calculateCrossStrategyWatchDiagnostics({
  candidate: baseCandidate,
  minimumQuality: 74,
  profile: adaptiveProfile,
  generatedAt: "2026-09-13T18:51:22.999Z"
}), null, "signals generated before the study boundary must not receive the diagnostic");

assert.equal(calculateCrossStrategyWatchDiagnostics({
  candidate: { ...baseCandidate, setupType: "" },
  minimumQuality: 74,
  profile: adaptiveProfile,
  generatedAt: "2026-09-14T00:00:00.000Z"
}), null, "a candidate without a resolved setupType must not receive the diagnostic");

const crossing = calculateCrossStrategyWatchDiagnostics({
  candidate: baseCandidate,
  minimumQuality: 74,
  profile: adaptiveProfile,
  generatedAt: "2026-09-14T00:00:00.000Z"
});
assert.equal(crossing.version, CROSS_STRATEGY_WATCH_VERSION);
assert.equal(crossing.studyStartedAt, CROSS_STRATEGY_WATCH_STARTED_AT);
assert.equal(crossing.productionDecisionInput, false);
assert.equal(crossing.strategy, "Momentum breakout");
assert.equal(crossing.qualityScore, 74);
assert.equal(crossing.adaptiveShadow.shadowAdjustment, -2);
assert.deepEqual(crossing.adaptiveShadow.shadowFactorsApplied.sort(), ["highQualityRisk", "volume"]);
assert.equal(crossing.adaptiveShadow.wouldHaveAdjusted, true);
assert.equal(crossing.adaptiveShadow.wouldHaveChangedOutcome, true, "74 -> 72 crosses the 74 minimumQuality boundary");
assert.equal(crossing.adaptiveShadow.wouldHaveCrossedMinimumQuality, true);

const notCrossing = calculateCrossStrategyWatchDiagnostics({
  candidate: { ...baseCandidate, qualityScore: 90 },
  minimumQuality: 74,
  profile: adaptiveProfile,
  generatedAt: "2026-09-14T00:00:00.000Z"
});
assert.equal(notCrossing.adaptiveShadow.shadowAdjustment, -2);
assert.equal(notCrossing.adaptiveShadow.wouldHaveChangedOutcome, false, "90 -> 88 stays well above the 74 boundary");

const noShadow = calculateCrossStrategyWatchDiagnostics({
  candidate: { ...baseCandidate, qualityScore: 80 },
  minimumQuality: 74,
  profile: { adaptive: false, factors: [] },
  generatedAt: "2026-09-14T00:00:00.000Z"
});
assert.equal(noShadow.adaptiveShadow.wouldHaveAdjusted, false);
assert.equal(noShadow.adaptiveShadow.wouldHaveChangedOutcome, false);

// --- sampleLabel: identical maturity bar to momentum_1h_watch_v1 ---

assert.equal(sampleLabel(9), "INSUFFICIENT");
assert.equal(sampleLabel(10), "VERY EARLY");
assert.equal(sampleLabel(19), "VERY EARLY");
assert.equal(sampleLabel(20), "EARLY EVIDENCE");
assert.equal(sampleLabel(29), "EARLY EVIDENCE");
assert.equal(sampleLabel(30), "ELIGIBLE FOR FORMAL REVIEW");

// --- buildCrossStrategyWatchReport: every strategy present, zero-volume strategies included ---

const rows = [
  ...buildDecidedRows("Momentum breakout", 12, { tp: 8, sl: 4, changedOutcome: false }),
  ...buildDecidedRows("Breakout retest", 3, { tp: 1, sl: 2, changedOutcome: true }),
  row("pre-study", "Momentum breakout", {
    createdAt: "2026-09-13T10:00:00.000Z",
    generatedAt: "2026-09-13T10:00:00.000Z",
    status: "Hit SL",
    realizedR: -1
  })
];
const report = buildCrossStrategyWatchReport(rows, { asOf: "2026-09-20T00:00:00.000Z" });

assert.equal(report.version, CROSS_STRATEGY_WATCH_VERSION);
assert.equal(report.studyStartedAt, CROSS_STRATEGY_WATCH_STARTED_AT);
assert.equal(report.byStrategy.length, CROSS_STRATEGY_LIST.length);
for (const strategy of CROSS_STRATEGY_LIST) {
  assert.ok(report.byStrategy.some((entry) => entry.strategy === strategy), `${strategy} must appear in the report even with zero volume`);
}
const zeroVolume = report.byStrategy.find((entry) => entry.strategy === "Mean reversion");
assert.equal(zeroVolume.generated, 0);
assert.equal(zeroVolume.sampleMaturity.label, "INSUFFICIENT");
assert.equal(zeroVolume.sampleMaturity.formalReviewEligible, false);

const momentum = report.byStrategy.find((entry) => entry.strategy === "Momentum breakout");
assert.equal(momentum.generated, 12, "the pre-study row must be excluded from the study population");
assert.equal(momentum.decided, 12);
assert.equal(momentum.tp, 8);
assert.equal(momentum.sl, 4);
assert.equal(momentum.sampleMaturity.label, "VERY EARLY");

const breakoutRetest = report.byStrategy.find((entry) => entry.strategy === "Breakout retest");
assert.equal(breakoutRetest.generated, 3);
assert.equal(breakoutRetest.sampleMaturity.label, "INSUFFICIENT");

assert.equal(report.adaptiveShadow.shadowAffected.generated, 3, "only the 3 Breakout retest rows were marked shadow-affected");
assert.equal(report.adaptiveShadow.shadowUnaffected.generated, 12);

assert.deepEqual(report.safety, {
  canonicalOutcomeSource: "generated_signals status, realized_r, and outcome_evaluated_at",
  backfillsPreStudySignals: false,
  changesProductionSignal: false,
  changesTelegram: false,
  changesCredits: false,
  changesOutcome: false,
  reEnablesAdaptiveAdjustment: false
});

// --- source guards: safety posture is structural, not just asserted at runtime ---

const analystSource = await readFile(resolve("src/modules/analyst/signalAnalystService.js"), "utf8");
const generatorSource = await readFile(resolve("src/modules/signals/signalGenerator.js"), "utf8");
const reportSource = await readFile(resolve("scripts/cross-strategy-watch-report.js"), "utf8");

assert.match(analystSource, /export function calculateAdaptiveQualityAdjustmentShadow/);
assert.doesNotMatch(generatorSource, /calculateAdaptiveQualityAdjustmentShadow/, "signalGenerator.js must never call the shadow function directly");
assert.match(generatorSource, /calculateCrossStrategyWatchDiagnostics/, "the study's logging path must be wired in");

const validateCandidateBody = extractFunctionBody(generatorSource, "validateCandidate");
assert.ok(validateCandidateBody, "validateCandidate must exist");
assert.doesNotMatch(validateCandidateBody, /crossStrategyWatch/i, "validateCandidate must never call the study's logging path");
assert.doesNotMatch(validateCandidateBody, /AdjustmentShadow/, "validateCandidate must never touch the shadow adjustment");

assert.match(reportSource, /BEGIN READ ONLY/);
assert.match(reportSource, /default_transaction_read_only=on/);
assert.doesNotMatch(reportSource, /\b(?:INSERT|UPDATE|DELETE)\b/);

// --- error containment: a malformed candidate/profile must never break signal generation ---

assert.throws(
  () => calculateAdaptiveQualityAdjustmentShadow(baseCandidate, { adaptive: true, factors: null }),
  /filter/,
  "malformed profile.factors is expected to throw inside the shadow calculation -- this is the exact failure the call site must contain"
);
assert.throws(
  () => calculateAdaptiveQualityAdjustmentShadow({ ...baseCandidate, confluence: undefined }, adaptiveProfile),
  TypeError,
  "a candidate missing confluence/session/smc/etc. is expected to throw inside getCandidateFactorKeys"
);

const safeWrapperBody = extractFunctionBody(generatorSource, "safeCrossStrategyWatchDiagnostics");
assert.ok(safeWrapperBody, "signalGenerator.js must define a wrapper around the diagnostic call");
assert.match(safeWrapperBody, /try\s*\{[\s\S]*calculateCrossStrategyWatchDiagnostics[\s\S]*\}\s*catch/, "the diagnostic call must be inside a try/catch");
assert.match(safeWrapperBody, /catch[\s\S]*return null;/, "any error must resolve to null, not propagate");
assert.match(generatorSource, /const crossStrategyWatchDiagnostics = safeCrossStrategyWatchDiagnostics\(/, "generateMarketDataSetup must go through the safe wrapper, not call the diagnostic directly");

console.log(JSON.stringify({
  version: CROSS_STRATEGY_WATCH_VERSION,
  studyStartedAt: CROSS_STRATEGY_WATCH_STARTED_AT,
  shadowExample: crossing,
  report: {
    totals: report.totals,
    byStrategy: report.byStrategy,
    adaptiveShadow: report.adaptiveShadow
  },
  safety: report.safety
}, null, 2));

function buildDecidedRows(strategy, count, { tp, sl, changedOutcome }) {
  const built = [];
  for (let index = 0; index < tp; index += 1) {
    built.push(row(`${strategy}-tp-${index}`, strategy, {
      status: "Hit TP",
      realizedR: 2,
      changedOutcome
    }));
  }
  for (let index = 0; index < sl; index += 1) {
    built.push(row(`${strategy}-sl-${index}`, strategy, {
      status: "Hit SL",
      realizedR: -1,
      changedOutcome
    }));
  }
  return built.slice(0, count);
}

function row(id, strategy, overrides = {}) {
  const generatedAt = overrides.generatedAt || "2026-09-14T00:00:00.000Z";
  const createdAt = overrides.createdAt || generatedAt;
  const diagnostic = {
    version: CROSS_STRATEGY_WATCH_VERSION,
    studyStartedAt: CROSS_STRATEGY_WATCH_STARTED_AT,
    generatedAt,
    strategy,
    minimumQuality: 74,
    qualityScore: 74,
    adaptiveShadow: {
      wouldHaveAdjusted: Boolean(overrides.changedOutcome),
      shadowAdjustment: overrides.changedOutcome ? -2 : 0,
      shadowFactorsApplied: overrides.changedOutcome ? ["volume", "highQualityRisk"] : [],
      wouldHaveChangedOutcome: Boolean(overrides.changedOutcome),
      wouldHaveCrossedMinimumQuality: Boolean(overrides.changedOutcome)
    }
  };
  return {
    id: `ags_${id}`,
    signal_id: `sig-${id}`,
    setup_key: `BTC-USD:1h:long:${id}`,
    pair: "BTC-USD",
    timeframe: "1h",
    strategy,
    direction: "long",
    status: overrides.status || "Active",
    valid_until: "2026-09-15T00:00:00.000Z",
    realized_r: overrides.realizedR ?? null,
    outcome_evaluated_at: overrides.status && overrides.status !== "Active" ? generatedAt : null,
    created_at: createdAt,
    full_analysis: { indicators: { crossStrategyWatchDiagnostics: diagnostic } }
  };
}

function extractFunctionBody(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!match) return null;
  const start = source.indexOf("{", match.index);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}
