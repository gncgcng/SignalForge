function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function validateRiskLevels({ direction, entryPrice, stopLoss, takeProfit }) {
  const entry = finitePositive(entryPrice);
  const stop = finitePositive(stopLoss);
  const target = finitePositive(takeProfit);
  const side = String(direction || "").toLowerCase();

  if (!entry || !stop || !target) {
    return { valid: false, reason: "Entry, stop loss, and take profit must be valid positive prices." };
  }
  if (side === "long" && !(stop < entry && entry < target)) {
    return { valid: false, reason: "Long signals require stop loss below entry and take profit above entry." };
  }
  if (side === "short" && !(target < entry && entry < stop)) {
    return { valid: false, reason: "Short signals require take profit below entry and stop loss above entry." };
  }
  if (!['long', 'short'].includes(side)) {
    return { valid: false, reason: "Signal direction must be long or short." };
  }

  return { valid: true, entry, stop, target, direction: side };
}

export function calculateRiskPosition({
  direction,
  entryPrice,
  stopLoss,
  takeProfit,
  accountSize,
  riskPercent = 1,
  customRiskAmount
}) {
  const levels = validateRiskLevels({ direction, entryPrice, stopLoss, takeProfit });
  if (!levels.valid) return levels;

  const account = finitePositive(accountSize);
  const percent = finitePositive(riskPercent);
  const custom = customRiskAmount === "" || customRiskAmount == null
    ? null
    : finitePositive(customRiskAmount);
  if (!account) return { valid: false, reason: "Account size must be greater than zero." };
  if (!percent && !custom) return { valid: false, reason: "Risk percentage or custom risk amount must be greater than zero." };
  if (customRiskAmount !== "" && customRiskAmount != null && !custom) {
    return { valid: false, reason: "Custom risk amount must be greater than zero." };
  }

  const riskAmount = custom ?? account * (percent / 100);
  const stopDistance = Math.abs(levels.entry - levels.stop);
  const targetDistance = Math.abs(levels.target - levels.entry);
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return { valid: false, reason: "Stop distance must be greater than zero." };
  }

  const quantity = riskAmount / stopDistance;
  const positionSize = quantity * levels.entry;
  const potentialProfit = targetDistance * quantity;
  const riskReward = potentialProfit / riskAmount;
  const values = [riskAmount, quantity, positionSize, potentialProfit, riskReward];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return { valid: false, reason: "Risk calculator unavailable because one or more results are invalid." };
  }

  return {
    valid: true,
    accountSize: account,
    riskPercent: (riskAmount / account) * 100,
    riskAmount,
    quantity,
    positionSize,
    potentialLoss: riskAmount,
    potentialProfit,
    riskReward,
    stopDistance,
    targetDistance,
    stopDistancePercent: (stopDistance / levels.entry) * 100,
    targetDistancePercent: (targetDistance / levels.entry) * 100
  };
}
