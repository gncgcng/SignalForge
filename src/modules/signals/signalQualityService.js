const categoryDefinitions = Object.freeze([
  ["trendAlignment", "Trend alignment"],
  ["momentum", "Momentum"],
  ["volumeConfirmation", "Volume confirmation"],
  ["entryTiming", "Entry timing"],
  ["riskReward", "Risk/reward"],
  ["marketStructure", "Market structure"],
  ["supportResistance", "Support/resistance context"],
  ["volatilityAtr", "Volatility / ATR"],
  ["higherTimeframe", "Higher timeframe alignment"],
  ["learningHistory", "Learning history"]
]);

export function withSignalQuality(signal = {}) {
  const signalQuality = buildSignalQuality(signal);
  return {
    ...signal,
    signalQuality,
    indicators: {
      ...(signal.indicators || {}),
      signalQuality
    }
  };
}

export function buildSignalQuality(signal = {}) {
  const confirmations = Array.isArray(signal.confirmations) ? signal.confirmations : [];
  const indicators = signal.indicators || {};
  const categoryMap = {
    trendAlignment: confirmationCategory(
      findConfirmation(confirmations, ["trend", "ema structure"]),
      "Trend confirmation was not recorded.",
      "trend_confirmation"
    ),
    momentum: confirmationCategory(
      findConfirmation(confirmations, ["rsi", "momentum"]),
      "Momentum confirmation was not recorded.",
      "momentum_confirmation"
    ),
    volumeConfirmation: volumeCategory(signal, confirmations),
    entryTiming: entryTimingCategory(signal),
    riskReward: riskRewardCategory(signal),
    marketStructure: marketStructureCategory(signal, confirmations),
    supportResistance: confirmationCategory(
      findConfirmation(confirmations, ["support", "resistance", "support room", "resistance room"]),
      "Support and resistance context was not recorded.",
      "support_resistance"
    ),
    volatilityAtr: confirmationCategory(
      findConfirmation(confirmations, ["atr", "volatility"]),
      "ATR confirmation was not recorded.",
      "atr_filter"
    ),
    higherTimeframe: higherTimeframeCategory(signal),
    learningHistory: learningCategory(signal)
  };
  const categories = Object.fromEntries(categoryDefinitions.map(([key, label]) => [
    key,
    { key, label, ...categoryMap[key] }
  ]));
  const list = Object.values(categories);
  const strengths = list
    .filter((item) => ["strong", "good"].includes(item.status))
    .map((item) => item.reason)
    .slice(0, 4);
  const risks = list
    .filter((item) => ["fair", "weak", "missing", "failed", "limited"].includes(item.status))
    .map((item) => item.reason || `${item.label} does not have enough data.`)
    .slice(0, 4);
  const overall = statusFromScore(Number(signal.qualityScore || signal.confidenceScore || 0));
  const positiveLabels = list.filter((item) => ["strong", "good"].includes(item.status)).map((item) => item.label);
  const mainReason = positiveLabels.length
    ? `${joinLabels(positiveLabels.slice(0, 2))} passed validation.`
    : "The setup passed the final validation rules, but detailed category data is limited.";

  return {
    version: 1,
    overall,
    score: finiteScore(signal.qualityScore),
    mainReason,
    categories,
    strengths,
    risks,
    confidenceExplanation: "Confidence reflects rule alignment and setup quality. It is not a guarantee or probability of profit.",
    debug: buildDebug(signal, list, indicators)
  };
}

export function toLockedSignalQuality(signalQuality = {}) {
  return {
    overall: normalizeStatus(signalQuality.overall),
    mainReason: String(signalQuality.mainReason || "The setup passed trend and risk validation.")
  };
}

function confirmationCategory(item, missingReason, source) {
  if (!item) return missingCategory(missingReason, source);
  return {
    status: item.passed ? "good" : "failed",
    score: item.passed ? 78 : 25,
    reason: humanReason(item.detail, item.passed ? "This confirmation aligned with the setup." : "This confirmation did not align."),
    ruleSource: source,
    confidenceImpact: Number.isFinite(Number(item.confidenceImpact)) ? Number(item.confidenceImpact) : null
  };
}

function volumeCategory(signal, confirmations) {
  const volume = findConfirmation(confirmations, ["volume"]);
  if (volume) return confirmationCategory(volume, "Volume confirmation was not recorded.", "volume_filter");
  const volumeAvailable = signal.indicators?.volumeAvailable;
  if (volumeAvailable === false || isCommodity(signal)) {
    return limitedCategory("Reliable volume data is not available for this market, so volume was not required.", "provider_volume");
  }
  return missingCategory("Volume confirmation was not recorded.", "volume_filter");
}

function entryTimingCategory(signal) {
  const quality = String(signal.entryQuality || signal.indicators?.entryQuality || "").toLowerCase();
  const mapping = {
    excellent: ["strong", 92],
    good: ["good", 82],
    fair: ["fair", 62],
    poor: ["failed", 25]
  };
  if (!mapping[quality]) return missingCategory("Entry readiness data is not available.", "entry_readiness");
  return {
    status: mapping[quality][0],
    score: mapping[quality][1],
    reason: quality === "excellent"
      ? "Price is well positioned near the validated entry zone."
      : quality === "good"
        ? "Price is close enough to the validated entry zone without chasing."
        : quality === "fair"
          ? "Entry timing is usable but price positioning is not ideal."
          : "Price positioning did not meet entry-readiness requirements.",
    ruleSource: "entry_readiness",
    confidenceImpact: null
  };
}

function riskRewardCategory(signal) {
  const rr = Number(signal.riskRewardRatio);
  if (!Number.isFinite(rr) || rr <= 0) return missingCategory("Risk/reward data is not available.", "risk_engine");
  const status = rr >= 2.5 ? "strong" : rr >= 2 ? "good" : rr >= 1.5 ? "fair" : "failed";
  return {
    status,
    score: rr >= 2.5 ? 92 : rr >= 2 ? 82 : rr >= 1.5 ? 62 : 20,
    reason: rr >= 1.5
      ? `The ${rr.toFixed(2)}R target passed the minimum risk/reward rule.`
      : `The ${rr.toFixed(2)}R target is below the minimum risk/reward rule.`,
    ruleSource: "dynamic_risk_engine",
    confidenceImpact: null
  };
}

function marketStructureCategory(signal, confirmations) {
  const structure = signal.marketStructure || {};
  const structureConfirmation = findConfirmation(confirmations, ["structure", "breakout", "retest"]);
  if (structureConfirmation) return confirmationCategory(structureConfirmation, "Market structure was not recorded.", "market_structure");
  if (!structure.available && !(structure.factors || []).length) {
    return missingCategory("Market structure context is not available.", "market_structure");
  }
  const aligned = structure.conflict ? false : Boolean(structure.vwapAligned || structure.volumeProfileAligned || structure.factors?.length);
  return {
    status: aligned ? "good" : "weak",
    score: aligned ? 76 : 42,
    reason: humanReason(structure.explanation, aligned ? "Market structure supports the setup direction." : "Market structure alignment is weak."),
    ruleSource: "market_structure",
    confidenceImpact: Number.isFinite(Number(structure.confidenceAdjustment)) ? Number(structure.confidenceAdjustment) : null
  };
}

function higherTimeframeCategory(signal) {
  const score = finiteScore(signal.confluenceScore ?? signal.indicators?.confluenceScore);
  const badge = String(signal.alignmentBadge || signal.indicators?.alignmentBadge || "");
  if (score === null && !badge) return limitedCategory("Higher timeframe confirmation is limited.", "multi_timeframe");
  const normalizedScore = score ?? (badge === "Full Alignment" ? 90 : badge === "Countertrend" ? 30 : 60);
  return {
    status: badge === "Full Alignment" || normalizedScore >= 85 ? "strong" : normalizedScore >= 70 ? "good" : normalizedScore >= 50 ? "fair" : "weak",
    score: normalizedScore,
    reason: badge === "Full Alignment"
      ? "Higher timeframes are aligned with the setup direction."
      : badge === "Countertrend"
        ? "Higher timeframe structure conflicts with the setup direction."
        : "Higher timeframe alignment is partial.",
    ruleSource: "multi_timeframe_confluence",
    confidenceImpact: Number.isFinite(Number(signal.confluence?.confidenceAdjustment))
      ? Number(signal.confluence.confidenceAdjustment)
      : null
  };
}

function learningCategory(signal) {
  const sampleSize = Number(signal.learningInsight?.sampleSize ?? signal.indicators?.learningSampleSize ?? 0);
  const adjustment = Number(signal.learningInsight?.adjustment ?? signal.indicators?.learningAdjustment ?? 0);
  if (!sampleSize) return limitedCategory("Not enough closed signals yet for strong learning confidence.", "learning_history");
  return {
    status: sampleSize >= 20 && adjustment >= 0 ? "good" : sampleSize >= 5 ? "fair" : "limited",
    score: sampleSize >= 20 && adjustment >= 0 ? 76 : sampleSize >= 5 ? 60 : null,
    reason: humanReason(signal.learningInsight?.message || signal.indicators?.learningInsight, `${sampleSize} comparable closed signals informed calibration.`),
    ruleSource: "historical_learning",
    confidenceImpact: adjustment
  };
}

function buildDebug(signal, categories, indicators) {
  const penaltiesApplied = categories
    .filter((item) => item.confidenceImpact !== null && Number(item.confidenceImpact) < 0)
    .map((item) => ({ category: item.key, points: Number(item.confidenceImpact), reason: item.reason }));
  const confidenceCapsApplied = [];
  if (!Number(signal.learningInsight?.sampleSize || indicators.learningSampleSize || 0)) confidenceCapsApplied.push({ cap: 92, reason: "Limited learning history" });
  if (String(signal.entryQuality || indicators.entryQuality || "").toLowerCase() === "fair") confidenceCapsApplied.push({ cap: 85, reason: "Fair entry quality" });
  if (String(signal.alignmentBadge || indicators.alignmentBadge || "") !== "Full Alignment") confidenceCapsApplied.push({ cap: 88, reason: "Higher timeframes are not fully aligned" });
  const volume = categories.find((item) => item.key === "volumeConfirmation");
  if (volume && ["fair", "weak", "failed"].includes(volume.status)) confidenceCapsApplied.push({ cap: 82, reason: "Volume confirmation is weak" });
  return {
    categories: categories.map(({ key, label, score, status, reason, ruleSource, confidenceImpact }) => ({ key, label, score, status, reason, ruleSource, confidenceImpact })),
    penaltiesApplied,
    confidenceCapsApplied
  };
}

function findConfirmation(confirmations, names) {
  const wanted = names.map((name) => name.toLowerCase());
  return confirmations.find((item) => wanted.some((name) => String(item?.name || "").toLowerCase().includes(name)));
}

function statusFromScore(score) {
  if (score >= 88) return "strong";
  if (score >= 75) return "good";
  if (score >= 65) return "fair";
  if (score > 0) return "weak";
  return "missing";
}

function normalizeStatus(status) {
  return ["strong", "good", "fair", "weak", "missing", "failed", "limited"].includes(status) ? status : "missing";
}

function finiteScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;
}

function missingCategory(reason, source) {
  return { status: "missing", score: null, reason: `Not enough data. ${reason}`, ruleSource: source, confidenceImpact: 0 };
}

function limitedCategory(reason, source) {
  return { status: "limited", score: null, reason, ruleSource: source, confidenceImpact: 0 };
}

function humanReason(value, fallback) {
  const reason = String(value || "").trim();
  return reason || fallback;
}

function isCommodity(signal) {
  return ["XAU/USD", "XAG/USD", "WTI", "BRENT", "NATGAS"].includes(signal.symbol);
}

function joinLabels(labels) {
  if (labels.length < 2) return labels[0] || "Core confirmations";
  return `${labels[0]} and ${labels[1].toLowerCase()}`;
}
