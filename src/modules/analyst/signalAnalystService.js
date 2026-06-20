export const currentStrategyVersion = "v4-analyst";
const minimumFactorSample = 5;
const maximumAdaptiveAdjustment = 5;

export function buildAnalystProfile(signals) {
  const resolved = signals.filter((signal) => ["Hit TP", "Hit SL", "Expired"].includes(signal.status));
  const factors = factorDefinitions.map((definition) => {
    const present = resolved.filter((signal) => definition.read(signal));
    const absent = resolved.filter((signal) => !definition.read(signal));
    const presentStats = calculateOutcomeStats(present);
    const absentStats = calculateOutcomeStats(absent);
    const sampleSufficient = present.length >= minimumFactorSample && absent.length >= minimumFactorSample;
    const expectancyDelta = round(presentStats.expectancy - absentStats.expectancy);
    const winRateDelta = round(presentStats.winRate - absentStats.winRate);
    const usefulnessScore = sampleSufficient
      ? clamp(Math.round(expectancyDelta * 35 + winRateDelta * 0.5), -100, 100)
      : 0;

    return {
      key: definition.key,
      label: definition.label,
      category: definition.category,
      present: presentStats,
      absent: absentStats,
      expectancyDelta,
      winRateDelta,
      usefulnessScore,
      sampleSufficient,
      suggestedAction: !sampleSufficient
        ? "Collect more resolved signals"
        : expectancyDelta <= -0.15 && presentStats.expectancy < 0
          ? "Consider removing or down-weighting this rule"
          : expectancyDelta < 0
            ? "Review this rule"
            : "Keep this rule"
    };
  }).sort((a, b) => b.usefulnessScore - a.usefulnessScore || a.label.localeCompare(b.label));

  return {
    strategyVersion: currentStrategyVersion,
    resolvedSignals: resolved.length,
    minimumFactorSample,
    adaptive: factors.some((factor) => factor.sampleSufficient),
    factors,
    generatedAt: new Date().toISOString()
  };
}

export function calculateAdaptiveQualityAdjustment(candidate, profile) {
  if (!profile?.adaptive) {
    return {
      adjustment: 0,
      factors: [],
      explanation: "Historical adaptation is inactive until factor samples are large enough."
    };
  }

  const activeKeys = new Set(getCandidateFactorKeys(candidate));
  const applied = profile.factors
    .filter((factor) => factor.sampleSufficient && activeKeys.has(factor.key))
    .map((factor) => ({
      key: factor.key,
      label: factor.label,
      usefulnessScore: factor.usefulnessScore,
      adjustment: factor.usefulnessScore >= 25 ? 1 : factor.usefulnessScore <= -25 ? -1 : 0
    }))
    .filter((factor) => factor.adjustment !== 0);
  const adjustment = clamp(
    applied.reduce((sum, factor) => sum + factor.adjustment, 0),
    -maximumAdaptiveAdjustment,
    maximumAdaptiveAdjustment
  );

  return {
    adjustment,
    factors: applied,
    explanation: applied.length
      ? `Historical factor evidence adjusted quality by ${adjustment >= 0 ? "+" : ""}${adjustment} points.`
      : "No statistically mature historical factor changed this setup's quality."
  };
}

export function buildSignalAnalystReport(candidate, profile = null) {
  const strengths = [];
  const weaknesses = [];
  const add = (passed, positive, negative) => {
    (passed ? strengths : weaknesses).push(passed ? positive : negative);
  };

  const trend = candidate.confirmations.find((item) => item.name === "Trend" || item.name === "EMA structure");
  add(Boolean(trend?.passed), "Trend alignment", "Trend alignment is incomplete");
  add(
    candidate.confluence.badge === "Full Alignment",
    "High multi-timeframe confluence",
    candidate.confluence.badge === "Countertrend"
      ? "Higher timeframes oppose the setup"
      : "Only partial timeframe alignment"
  );
  add(
    ["High", "Highest"].includes(candidate.session.liquidity),
    `${candidate.session.name} liquidity is active`,
    `${candidate.session.name} session offers limited liquidity`
  );
  add(
    !["Danger", "Elevated"].includes(candidate.newsRisk.level),
    "No immediate high-impact news block",
    candidate.newsRisk.explanation
  );

  for (const factor of candidate.smc.factors.filter((item) => item.passed)) {
    strengths.push(factor.name);
  }
  if (!candidate.smc.factors.some((item) => item.passed)) {
    weaknesses.push("No active Smart Money Concepts confirmation");
  }

  add(
    candidate.marketStructure.vwapAligned,
    "VWAP alignment",
    candidate.marketStructure.available ? "VWAP does not confirm the setup" : "VWAP unavailable"
  );
  add(
    candidate.marketStructure.volumeProfileAligned,
    "Volume Profile support",
    candidate.marketStructure.available
      ? "Volume Profile is neutral"
      : "Volume Profile unavailable"
  );
  add(
    !candidate.correlation.conflict,
    candidate.correlation.aligned ? "Correlated markets align" : "No correlation conflict",
    candidate.correlation.explanation
  );
  add(
    candidate.opposingRoom >= candidate.riskRewardRatio,
    `${candidate.riskRewardRatio.toFixed(2)}R target has structural room`,
    "Nearby opposing structure limits the target"
  );
  add(
    candidate.regime !== "Low Volatility",
    `${candidate.regime} volatility context is tradable`,
    "Low volatility does not justify a trade"
  );

  const overallQuality = qualityLabel(candidate.qualityScore, candidate.valid);
  const adaptive = candidate.adaptiveQuality || {
    adjustment: 0,
    factors: [],
    explanation: "Historical adaptation unavailable."
  };
  const summary = [
    `${candidate.direction.toUpperCase()} ${candidate.setupType || "setup"} in a ${candidate.regime} regime.`,
    `Multi-timeframe context is ${candidate.confluence.badge.toLowerCase()} at ${candidate.confluence.score}/100.`,
    `${candidate.session.explanation}`,
    `${candidate.newsRisk.explanation}`,
    `${candidate.smc.explanation}`,
    `${candidate.marketStructure.explanation}`,
    `${candidate.correlation.explanation}`,
    `${candidate.riskPlan.explanation}`,
    adaptive.explanation,
    `Overall setup quality: ${overallQuality}.`
  ].join(" ");

  return {
    strategyVersion: currentStrategyVersion,
    overallQuality,
    strengths: unique(strengths).slice(0, 8),
    weaknesses: unique(weaknesses).slice(0, 8),
    summary,
    sections: {
      marketRegime: candidate.regime,
      multiTimeframe: candidate.confluence.explanation,
      session: candidate.session.explanation,
      newsRisk: candidate.newsRisk.explanation,
      smartMoneyConcepts: candidate.smc.explanation,
      vwap: factorDetail(candidate.marketStructure.factors, "VWAP"),
      volumeProfile: factorDetail(candidate.marketStructure.factors, "Volume Profile"),
      riskEngine: candidate.riskPlan.explanation
    },
    adaptive
  };
}

export function getSignalFactorKeys(signal) {
  return factorDefinitions.filter((definition) => definition.read(signal)).map((definition) => definition.key);
}

function getCandidateFactorKeys(candidate) {
  const signalLike = {
    confirmations: candidate.confirmations,
    indicators: {
      regime: candidate.regime,
      alignmentBadge: candidate.confluence.badge,
      sessionLiquidity: candidate.session.liquidity,
      newsRiskLevel: candidate.newsRisk.level,
      smcFactors: candidate.smc.factors,
      vwapAligned: candidate.marketStructure.vwapAligned,
      volumeProfileAligned: candidate.marketStructure.volumeProfileAligned,
      correlationAligned: candidate.correlation.aligned,
      correlationConflict: candidate.correlation.conflict,
      riskTier: candidate.riskPlan?.riskTier
    }
  };
  return getSignalFactorKeys(signalLike);
}

const factorDefinitions = [
  definition("trend", "Trend alignment", "Core", (signal) => confirmationPassed(signal, "Trend")),
  definition("rsi", "RSI confirmation", "Core", (signal) => confirmationPassed(signal, "RSI")),
  definition("volume", "Volume confirmation", "Core", (signal) => confirmationPassed(signal, "Volume")),
  definition("supportResistance", "Support/resistance", "Core", (signal) => (
    confirmationPassed(signal, "Support") ||
    confirmationPassed(signal, "Resistance") ||
    confirmationPassed(signal, "Support/resistance")
  )),
  definition("fullConfluence", "Full timeframe alignment", "Context", (signal) => (
    signal.alignmentBadge === "Full Alignment" ||
    signal.indicators?.alignmentBadge === "Full Alignment"
  )),
  definition("activeSession", "Active session liquidity", "Context", (signal) => (
    ["High", "Highest"].includes(signal.indicators?.sessionLiquidity)
  )),
  definition("clearNews", "Clear news risk", "Context", (signal) => (
    !["Danger", "Elevated"].includes(signal.newsRisk?.level || signal.indicators?.newsRiskLevel)
  )),
  definition("liquiditySweep", "Liquidity sweep", "SMC", (signal) => (
    smcPassed(signal, "Liquidity sweep")
  )),
  definition("fairValueGap", "Fair value gap", "SMC", (signal) => smcPassed(signal, "Fair value gap")),
  definition("orderBlock", "Order block", "SMC", (signal) => smcPassed(signal, "Order block")),
  definition("structureBreak", "BOS / CHoCH", "SMC", (signal) => smcPassed(signal, "BOS / CHoCH")),
  definition("vwap", "VWAP alignment", "Market structure", (signal) => (
    Boolean(signal.marketStructure?.vwapAligned ?? signal.indicators?.vwapAligned)
  )),
  definition("volumeProfile", "Volume Profile", "Market structure", (signal) => (
    Boolean(signal.marketStructure?.volumeProfileAligned ?? signal.indicators?.volumeProfileAligned)
  )),
  definition("correlation", "Correlation alignment", "Cross-market", (signal) => (
    Boolean(signal.correlation?.aligned ?? signal.indicators?.correlationAligned) &&
    !Boolean(signal.correlation?.conflict ?? signal.indicators?.correlationConflict)
  )),
  definition("highQualityRisk", "High-quality risk tier", "Risk", (signal) => (
    (signal.riskPlan?.riskTier || signal.indicators?.riskTier) === "High quality"
  ))
];

function calculateOutcomeStats(signals) {
  const wins = signals.filter((signal) => signal.status === "Hit TP").length;
  const losses = signals.filter((signal) => signal.status === "Hit SL").length;
  const expired = signals.filter((signal) => signal.status === "Expired").length;
  const resolved = wins + losses;
  const netR = signals.reduce((sum, signal) => {
    if (signal.status === "Hit TP") return sum + Number(signal.riskRewardRatio || 0);
    if (signal.status === "Hit SL") return sum - 1;
    return sum;
  }, 0);
  return {
    total: signals.length,
    wins,
    losses,
    expired,
    winRate: resolved ? round((wins / resolved) * 100) : 0,
    expectancy: signals.length ? round(netR / signals.length) : 0,
    netR: round(netR)
  };
}

function confirmationPassed(signal, name) {
  return (signal.confirmations || []).some((item) => item.name === name && item.passed);
}

function smcPassed(signal, name) {
  const factors = signal.smc?.factors || signal.indicators?.smcFactors || [];
  return factors.some((item) => item.name === name && item.passed);
}

function factorDetail(factors, name) {
  return factors?.find((factor) => factor.name === name)?.detail || `${name} unavailable.`;
}

function qualityLabel(score, valid = true) {
  if (!valid || score < 78) return "Avoid";
  if (score >= 90) return "Excellent";
  if (score >= 84) return "Good";
  return "Average";
}

function definition(key, label, category, read) {
  return { key, label, category, read };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Number(Number(value).toFixed(2));
}
