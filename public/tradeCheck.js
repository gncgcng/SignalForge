// Trade checker: for a trade the user is considering, the position size, what fees and slippage cost in R, the win
// rate needed to break even, and how similar setups have done historically. Facts only: it never says to take or skip
// a trade. Pure, so tests can import it; the #trade-check view wires it to the form.
import { breakEvenWinRate, FEE_PRESETS } from "./feeCost.js";
import { describeTrackRecord, indexTrackRecords, trackRecordKey } from "./trackRecords.js";

export { FEE_PRESETS };
export const OWN_SETUP = "own";
export const TRADE_CHECK_DEFAULTS = Object.freeze({ riskPercent: 1, feePerSidePct: 0.6, slippagePerSidePct: 0.05 });

const num = (value) => (value === "" || value === null || value === undefined ? NaN : Number(value));
const invalid = (message) => ({ ok: false, message });

export function formatMoney(value) {
  const amount = Number(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(amount) >= 100 ? 0 : 2,
    minimumFractionDigits: Math.abs(amount) >= 100 ? 0 : 2
  }).format(amount);
}

export function formatUnits(value) {
  const units = Number(value);
  if (units >= 1000) return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(units);
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(units);
}

const formatPct = (fraction) => `${Math.round(fraction * 100)}%`;
const trimNumber = (value, digits = 2) => Number(Number(value).toFixed(digits)).toString();

// The base asset for "buy 0.0213 BTC"; generic "units" when no symbol is known.
export function unitLabel(symbol) {
  const base = String(symbol || "").split(/[-/]/)[0].trim().toUpperCase();
  return base || "units";
}

// Long-setup records the user can pick, from the track-records file. Shorts have no published record.
export function trackRecordOptions(file) {
  const records = (file?.available ? file.records : []).filter((record) => record.scope === "setup" && record.direction === "long");
  return {
    setupTypes: [...new Set(records.map((record) => record.strategy))].sort((a, b) => a.localeCompare(b)),
    timeframes: (file?.timeframes || [...new Set(records.map((record) => record.timeframe))])
  };
}

export function checkTrade(input = {}, { trackRecords = null, index = indexTrackRecords(trackRecords) } = {}) {
  const direction = String(input.direction || "").toLowerCase();
  if (direction !== "long" && direction !== "short") return invalid("Choose long or short.");

  const entry = num(input.entry);
  const stop = num(input.stop);
  const targetMode = input.targetMode === "r" ? "r" : "price";
  const targetInput = num(targetMode === "r" ? input.targetR : input.target);
  const account = num(input.accountSize);
  const riskPercent = num(input.riskPercent ?? TRADE_CHECK_DEFAULTS.riskPercent);
  const fee = num(input.feePerSidePct ?? TRADE_CHECK_DEFAULTS.feePerSidePct);
  const slippage = num(input.slippagePerSidePct ?? TRADE_CHECK_DEFAULTS.slippagePerSidePct);

  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return invalid("Enter an entry price and a stop price.");
  if (entry <= 0 || stop <= 0) return invalid("Entry and stop prices must be above zero.");
  if (stop === entry) return invalid("The stop can't be at the entry price: there would be no risk to measure.");
  if (direction === "long" && stop > entry) return invalid("For a long trade, the stop must be below the entry price.");
  if (direction === "short" && stop < entry) return invalid("For a short trade, the stop must be above the entry price.");

  if (!Number.isFinite(targetInput)) return invalid(targetMode === "r" ? "Enter a target in R." : "Enter a target price.");
  if (targetInput <= 0) return invalid(targetMode === "r" ? "The target must be above 0R." : "The target price must be above zero.");
  const distance = Math.abs(entry - stop);
  const target = targetMode === "r"
    ? (direction === "long" ? entry + targetInput * distance : entry - targetInput * distance)
    : targetInput;
  if (targetMode === "price" && direction === "long" && target <= entry) return invalid("For a long trade, the target must be above the entry price.");
  if (targetMode === "price" && direction === "short" && target >= entry) return invalid("For a short trade, the target must be below the entry price.");
  if (targetMode === "r" && target <= 0) return invalid("That target in R would put the target price at or below zero.");

  if (!Number.isFinite(account)) return invalid("Enter your account size.");
  if (account <= 0) return invalid("Account size must be above zero.");
  if (!Number.isFinite(riskPercent)) return invalid("Enter the risk per trade in %.");
  if (riskPercent <= 0) return invalid("Risk per trade must be above 0%.");
  if (riskPercent > 100) return invalid("Risk per trade can't be above 100% of the account.");
  if (!Number.isFinite(fee) || !Number.isFinite(slippage)) return invalid("Enter a fee and a slippage per side (0 is allowed).");
  if (fee < 0 || slippage < 0) return invalid("Fees and slippage can't be negative.");

  // Round-trip cost per unit, priced on the losing path: entry leg at the entry, exit leg at the stop.
  const perSide = (fee + slippage) / 100;
  const costPerUnit = entry * perSide + stop * perSide;
  const costR = costPerUnit / distance;
  const targetRGross = Math.abs(target - entry) / distance;
  const breakEven = breakEvenWinRate(targetRGross, costR);
  const riskAmount = account * (riskPercent / 100);
  // Size so that a stop-out, costs included, loses exactly the risk amount.
  const units = riskAmount / (distance + costPerUnit);
  const notional = units * entry;
  const leverage = notional / account;
  const label = unitLabel(input.symbol);

  const record = recordFor({ direction, setupType: input.setupType, timeframe: input.timeframe }, trackRecords, index);
  const breakEvenSentence = `With these costs you need to win ${formatPct(breakEven)} of the time to break even.` +
    (record?.n
      ? ` ${record.strategy} · ${record.timeframe} has historically won ${Math.round(record.winRate)}% (${new Intl.NumberFormat("en-US").format(record.n)} past case${record.n === 1 ? "" : "s"}).`
      : "");

  return {
    ok: true,
    direction,
    entry,
    stop,
    target,
    stopDistance: distance,
    stopDistancePct: (distance / entry) * 100,
    costPerUnit,
    costR,
    targetR: targetRGross,
    netWinR: targetRGross - costR,
    netLossR: -(1 + costR),
    breakEvenWinRate: breakEven,
    riskAmount,
    units,
    notional,
    leverage,
    leverageWarning: leverage > 1
      ? `This size needs ${leverage.toFixed(1)}× leverage. A move against you can be liquidated before your stop.`
      : null,
    record,
    sentences: {
      breakEven: breakEvenSentence,
      costs: `Fees and slippage cost ${costR.toFixed(2)}R on every trade, win or lose.`,
      size: `Risking ${formatMoney(riskAmount)} (${trimNumber(riskPercent)}% of ${formatMoney(account)}): ${direction === "long" ? "buy" : "sell"} ${formatUnits(units)} ${label} (${formatMoney(notional)}). A stop-out loses about ${formatMoney(riskAmount)} including costs.`,
      outcomes: `If the target is reached: about ${(targetRGross - costR) >= 0 ? "+" : "−"}${Math.abs(targetRGross - costR).toFixed(2)}R. If the stop is hit: about −${(1 + costR).toFixed(2)}R.`
    }
  };
}

// The historical record for a long setup type + timeframe; none for shorts or "My own setup".
export function recordFor({ direction, setupType, timeframe }, trackRecords, index = indexTrackRecords(trackRecords)) {
  if (direction !== "long" || !setupType || setupType === OWN_SETUP || !timeframe) return null;
  const record = index.get(trackRecordKey(setupType, "long", timeframe));
  if (!record) return null;
  const view = describeTrackRecord(record, trackRecords);
  return {
    key: record.key,
    strategy: record.strategy,
    timeframe: record.timeframe,
    label: record.label,
    tone: view.tone,
    n: record.n,
    winRate: record.winRate,
    breakEvenWinRate: record.breakEvenWinRate,
    avgR: record.avgR,
    summary: `${view.heading} · ${view.casesLine}`,
    approximate: Boolean(record.approximate)
  };
}

// "Check this trade" from a setup card: the card's own levels, setup type and timeframe. Shorts get no button.
export function tradeCheckPrefill(signal) {
  const direction = String(signal?.direction || "").toLowerCase();
  if (direction !== "long") return null;
  const levels = [signal.entryPrice, signal.stopLoss, signal.takeProfit].map(Number);
  if (!levels.every((value) => Number.isFinite(value) && value > 0)) return null;
  return {
    direction: "long",
    entry: String(levels[0]),
    stop: String(levels[1]),
    target: String(levels[2]),
    targetMode: "price",
    setupType: signal.setupType || OWN_SETUP,
    timeframe: signal.timeframe || "",
    symbol: signal.symbol || ""
  };
}

export function tradeCheckPrefillParams(signal) {
  const prefill = tradeCheckPrefill(signal);
  return prefill ? new URLSearchParams(prefill) : null;
}

const PREFILL_KEYS = ["direction", "entry", "stop", "target", "targetMode", "setupType", "timeframe", "symbol"];

export function prefillFromParams(params) {
  const prefill = {};
  for (const key of PREFILL_KEYS) {
    const value = params?.get?.(key);
    if (value !== null && value !== undefined && value !== "") prefill[key] = value;
  }
  return prefill;
}
