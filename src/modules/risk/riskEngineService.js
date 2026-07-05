export const allowedRiskPercents = [0.25, 0.5, 1, 2];
export const maximumRiskPercent = 2;
export const minimumRiskReward = 1.8;

export function buildDynamicRiskPlan({
  direction,
  entry,
  atr,
  regime,
  setupType,
  qualityScore,
  protectiveLevel = null,
  opposingLevel = null
}) {
  const atrValue = Number(atr);
  if (!Number.isFinite(atrValue) || atrValue <= 0) {
    throw new Error("ATR is required for dynamic risk planning.");
  }

  const stopMultiplier = getStopMultiplier(regime);
  const atrStopDistance = atrValue * stopMultiplier;
  const structuralDistance = getStructuralDistance(direction, entry, protectiveLevel, atrValue);
  const stopDistance = Math.max(atrStopDistance, structuralDistance || 0);
  const targetMultiple = getTargetMultiple(regime, setupType);
  const availableR = opposingLevel
    ? Math.abs(Number(opposingLevel.price) - entry) / stopDistance
    : targetMultiple;
  const riskRewardRatio = Math.min(targetMultiple, availableR);
  const stopLoss = direction === "long" ? entry - stopDistance : entry + stopDistance;
  const takeProfit = direction === "long"
    ? entry + stopDistance * riskRewardRatio
    : entry - stopDistance * riskRewardRatio;
  const riskTier = getRiskTier(qualityScore);

  return {
    stopLoss,
    takeProfit,
    stopDistance,
    stopStyle: structuralDistance > atrStopDistance ? "ATR + structure" : "ATR regime",
    stopMultiplier,
    targetStyle: regime?.label === "Range"
      ? "Range-capped dynamic"
      : regime?.trendStrength >= 0.75
        ? "Strong-trend dynamic"
        : "Regime dynamic",
    targetMultiple,
    riskRewardRatio,
    availableR,
    riskTier,
    recommendedRiskPercent: riskTier === "High quality" ? 1 : riskTier === "Medium quality" ? 0.5 : 0,
    tradeAllowed: riskTier !== "No trade" && riskRewardRatio >= minimumRiskReward,
    explanation: buildRiskExplanation({
      regime,
      stopMultiplier,
      stopStyle: structuralDistance > atrStopDistance ? "ATR plus confirmed structure" : "regime-adjusted ATR",
      riskRewardRatio,
      targetMultiple,
      riskTier
    })
  };
}

export function calculatePositionSizing({
  accountSize,
  requestedRiskPercent,
  qualityScore,
  entryPrice,
  stopLoss,
  takeProfit
}) {
  const balance = Number(accountSize);
  const requested = Number(requestedRiskPercent);
  const entry = Number(entryPrice);
  const stop = Number(stopLoss);
  const target = Number(takeProfit);

  if (!Number.isFinite(balance) || balance <= 0) {
    throw validationError("Account size must be greater than zero.");
  }
  if (!allowedRiskPercents.includes(requested)) {
    throw validationError("Risk percent must be 0.25%, 0.5%, 1%, or 2%.");
  }

  const tier = getRiskTier(qualityScore);
  if (tier === "No trade") {
    return {
      tradeAllowed: false,
      riskTier: tier,
      requestedRiskPercent: requested,
      effectiveRiskPercent: 0,
      accountSize: balance,
      positionSize: 0,
      riskAmount: 0,
      potentialProfit: 0,
      riskRewardRatio: 0,
      explanation: "Low-quality setup: the Dynamic Risk Engine suggests no trade."
    };
  }

  const scale = tier === "Medium quality" ? 0.5 : 1;
  const effectiveRiskPercent = Math.min(maximumRiskPercent, requested * scale);
  const riskAmount = balance * (effectiveRiskPercent / 100);
  const perUnitRisk = Math.abs(entry - stop);
  const rewardPerUnit = Math.abs(target - entry);
  const riskRewardRatio = perUnitRisk > 0 ? rewardPerUnit / perUnitRisk : 0;
  const positionSize = perUnitRisk > 0 ? riskAmount / perUnitRisk : 0;
  const tradeAllowed = perUnitRisk > 0 && riskRewardRatio >= minimumRiskReward;

  return {
    tradeAllowed,
    riskTier: tier,
    requestedRiskPercent: requested,
    effectiveRiskPercent,
    accountSize: balance,
    positionSize,
    riskAmount,
    potentialProfit: positionSize * rewardPerUnit,
    riskRewardRatio,
    explanation: !tradeAllowed
      ? `Trade blocked because the calculated reward is ${riskRewardRatio.toFixed(2)}R; at least ${minimumRiskReward}R is required.`
      : tier === "Medium quality"
        ? `Medium-quality setup: requested risk was reduced by half to ${effectiveRiskPercent}%.`
        : `High-quality setup: normal risk applies, capped at ${maximumRiskPercent}%.`
  };
}

export function getRiskTier(qualityScore) {
  const quality = Number(qualityScore);
  if (quality >= 86) return "High quality";
  if (quality > 70) return "Medium quality";
  return "No trade";
}

function getStopMultiplier(regime) {
  if (regime?.label === "High Volatility") return 1.9;
  if (regime?.label === "Breakout") return 1.65;
  if (regime?.label === "Range") return 1.15;
  if (regime?.label === "Low Volatility") return 1.25;
  if (regime?.trendStrength >= 0.75) return 1.55;
  return 1.4;
}

function getTargetMultiple(regime, setupType) {
  if (regime?.label === "Range") return minimumRiskReward;
  if (regime?.label === "Breakout" || setupType === "Breakout retest") return 2.5;
  if (regime?.trendStrength >= 0.8) return 2.6;
  if (regime?.trendStrength >= 0.65) return 2.3;
  return 2;
}

function getStructuralDistance(direction, entry, level, atr) {
  if (!level) return null;
  const buffer = atr * 0.2;
  const structuralStop = direction === "long"
    ? Number(level.price) - buffer
    : Number(level.price) + buffer;
  const distance = direction === "long" ? entry - structuralStop : structuralStop - entry;
  return distance > 0 && distance <= atr * 3.5 ? distance : null;
}

function buildRiskExplanation({
  regime,
  stopMultiplier,
  stopStyle,
  riskRewardRatio,
  targetMultiple,
  riskTier
}) {
  return `Stop uses ${stopMultiplier.toFixed(2)}x ATR with ${stopStyle} for the ${regime?.label || "current"} regime. The target adapts to trend strength at up to ${targetMultiple.toFixed(2)}R and is capped by opposing structure, producing ${riskRewardRatio.toFixed(2)}R. ${riskTier} risk scaling applies.`;
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
