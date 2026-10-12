// Fee-cost calculator: how much a round trip of fees and slippage costs, measured in R (the distance from entry to
// stop). Pure, so tests can import it; the /research page wires it to the form (public/research.js).

export const FEE_PRESETS = Object.freeze([0.1, 0.25, 0.6]);
export const DEFAULTS = Object.freeze({ feePerSidePct: 0.6, slippagePerSidePct: 0.05, targetR: 2 });

const toNumber = (value) => (value === "" || value === null || value === undefined ? NaN : Number(value));

function invalid(message) {
  return { ok: false, message };
}

// Break-even win rate for a target of T R when every trade also costs C R: (1 + C) / (T + 1).
export function breakEvenWinRate(targetR, costR = 0) {
  return (1 + costR) / (targetR + 1);
}

// Long trades only: the stop sits below the entry.
export function computeFeeCost({
  entry,
  stop,
  feePerSidePct = DEFAULTS.feePerSidePct,
  slippagePerSidePct = DEFAULTS.slippagePerSidePct,
  targetR = DEFAULTS.targetR
} = {}) {
  const entryPrice = toNumber(entry);
  const stopPrice = toNumber(stop);
  const fee = toNumber(feePerSidePct);
  const slippage = toNumber(slippagePerSidePct);
  const target = toNumber(targetR);

  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopPrice)) return invalid("Enter an entry price and a stop price.");
  if (entryPrice <= 0 || stopPrice <= 0) return invalid("Prices must be above zero.");
  if (stopPrice >= entryPrice) {
    return invalid(stopPrice === entryPrice
      ? "The stop can't be at the entry price: there would be no risk to measure against."
      : "For a long trade, the stop must be below the entry price.");
  }
  if (!Number.isFinite(fee) || !Number.isFinite(slippage)) return invalid("Enter a fee and a slippage per side (0 is allowed).");
  if (fee < 0 || slippage < 0) return invalid("Fees and slippage can't be negative.");
  if (!Number.isFinite(target) || target <= 0) return invalid("The target must be above 0R.");

  const stopDistancePct = ((entryPrice - stopPrice) / entryPrice) * 100;
  const roundTripPct = 2 * (fee + slippage);
  const costR = roundTripPct / stopDistancePct;
  const breakEvenWithCosts = breakEvenWinRate(target, costR);
  const breakEvenWithoutCosts = breakEvenWinRate(target, 0);
  return {
    ok: true,
    stopDistancePct,
    roundTripPct,
    costR,
    targetR: target,
    breakEvenWithCosts,
    breakEvenWithoutCosts,
    sentence: describeFeeCost({ costR, targetR: target, breakEvenWithCosts, breakEvenWithoutCosts })
  };
}

const trimNumber = (value, digits) => Number(value.toFixed(digits)).toString();
export const formatPercentValue = (fraction, digits = 1) => `${(fraction * 100).toFixed(digits)}%`;

export function describeFeeCost({ costR, targetR, breakEvenWithCosts, breakEvenWithoutCosts }) {
  const cost = `Fees and slippage cost you ${costR.toFixed(2)}R on every trade, win or lose.`;
  const target = `${trimNumber(targetR, 2)}R target`;
  if (breakEvenWithCosts >= 1) {
    return `${cost} On a ${target} you could not break even: you would need to win ${formatPercentValue(breakEvenWithCosts)} of the time, which is impossible (without costs it would be ${formatPercentValue(breakEvenWithoutCosts)}).`;
  }
  return `${cost} To break even on a ${target} you'd need to win ${formatPercentValue(breakEvenWithCosts)} of the time instead of ${formatPercentValue(breakEvenWithoutCosts)}.`;
}
