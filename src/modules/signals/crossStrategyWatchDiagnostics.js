import { calculateAdaptiveQualityAdjustmentShadow } from "../analyst/signalAnalystService.js";

export const CROSS_STRATEGY_WATCH_VERSION = "cross_strategy_watch_v1";
// Deploy timestamp of commit 49ba207 ("disable adaptive quality feedback loop"), in UTC.
// Deliberately not rounded to midnight: the commit landed mid-day, and rounding down
// would pull pre-fix signals into the post-fix cohort and defeat the before/after split.
export const CROSS_STRATEGY_WATCH_STARTED_AT = "2026-09-13T18:51:23.000Z";

export const CROSS_STRATEGY_LIST = Object.freeze([
  "Momentum breakout",
  "Breakout retest",
  "Liquidity sweep reversal",
  "VWAP reclaim/rejection",
  "Multi-timeframe continuation",
  "Pullback bounce",
  "Support/resistance retest",
  "Trend continuation",
  "Range bounce",
  "Mean reversion"
]);

export function calculateCrossStrategyWatchDiagnostics({ candidate, minimumQuality, profile, generatedAt } = {}) {
  const strategy = String(candidate?.setupType || "");
  const timestamp = validTimestamp(generatedAt);
  const threshold = finiteOrNull(minimumQuality);
  if (!strategy || !timestamp || threshold == null || timestamp < CROSS_STRATEGY_WATCH_STARTED_AT) {
    return null;
  }

  const qualityScore = finiteOrNull(candidate.qualityScore) ?? 0;
  const shadow = calculateAdaptiveQualityAdjustmentShadow(candidate, profile);
  const shadowScore = Math.max(0, Math.min(100, qualityScore + shadow.adjustment));
  const actualPassed = qualityScore >= threshold;
  const shadowPassed = shadowScore >= threshold;
  const crossedBoundary = shadow.adjustment !== 0 && actualPassed !== shadowPassed;

  return {
    version: CROSS_STRATEGY_WATCH_VERSION,
    studyStartedAt: CROSS_STRATEGY_WATCH_STARTED_AT,
    generatedAt: timestamp,
    observationalOnly: true,
    productionDecisionInput: false,
    strategy,
    minimumQuality: threshold,
    qualityScore,
    adaptiveShadow: {
      wouldHaveAdjusted: shadow.adjustment !== 0,
      shadowAdjustment: shadow.adjustment,
      shadowFactorsApplied: shadow.factors.map((factor) => factor.key),
      wouldHaveChangedOutcome: crossedBoundary,
      wouldHaveCrossedMinimumQuality: crossedBoundary
    }
  };
}

function validTimestamp(value) {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
