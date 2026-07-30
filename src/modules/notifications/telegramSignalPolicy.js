import { appConfig } from "../../config/appConfig.js";
import { isSignalExpired } from "../signals/signalValidityService.js";

export function formatTelegramTradeLevels(setup = {}) {
  const values = [
    Number(setup.entryPrice ?? setup.entry),
    Number(setup.stopLoss ?? setup.stop_loss),
    Number(setup.takeProfit ?? setup.take_profit)
  ];
  const smallest = Math.min(...values.map(Math.abs).filter((value) => Number.isFinite(value) && value > 0));
  let decimals = smallest >= 1000 ? 2 : smallest >= 1 ? 4 : smallest >= 0.01 ? 5 : 6;
  const format = (value, precision = decimals) => Number(value).toLocaleString("en-US", {
    minimumFractionDigits: smallest < 0.01 ? Math.min(6, precision) : 0,
    maximumFractionDigits: precision,
    useGrouping: true
  });
  while (decimals < 8) {
    const formatted = values.map((value) => format(value, decimals));
    if (new Set(formatted).size === formatted.length) break;
    decimals += 1;
  }
  return {
    entry: format(values[0], decimals),
    stopLoss: format(values[1], decimals),
    takeProfit: format(values[2], decimals),
    decimals
  };
}

export function validateTelegramTradeSignal(setup = {}) {
  const entry = Number(setup.entryPrice ?? setup.entry);
  const stopLoss = Number(setup.stopLoss ?? setup.stop_loss);
  const takeProfit = Number(setup.takeProfit ?? setup.take_profit);
  const riskReward = Number(setup.riskRewardRatio ?? setup.riskReward);
  const direction = String(setup.direction || "").toLowerCase();
  if (!setup.id && !setup.setupKey) return { valid: false, status: "blocked_missing_signal_id", reason: "Signal ID or unlock token is missing." };
  if (![entry, stopLoss, takeProfit, riskReward].every(Number.isFinite) || riskReward <= 0) {
    return { valid: false, status: "blocked_invalid_trade_levels", reason: "Entry, stop, target, or R/R is missing or invalid." };
  }
  if (!["long", "short"].includes(direction)) {
    return { valid: false, status: "blocked_invalid_trade_levels", reason: "Signal direction is invalid." };
  }
  if (direction === "long" && !(stopLoss < entry && takeProfit > entry)) {
    return { valid: false, status: "blocked_invalid_trade_levels", reason: "Long levels require stop below entry and target above entry." };
  }
  if (direction === "short" && !(stopLoss > entry && takeProfit < entry)) {
    return { valid: false, status: "blocked_invalid_trade_levels", reason: "Short levels require stop above entry and target below entry." };
  }
  if (isSignalExpired(setup)) {
    return { valid: false, status: "blocked_signal_expired", reason: "Signal expired before Telegram delivery." };
  }
  const formatted = formatTelegramTradeLevels(setup);
  if (new Set([formatted.entry, formatted.stopLoss, formatted.takeProfit]).size !== 3) {
    return { valid: false, status: "blocked_invalid_trade_levels", reason: "Trade levels cannot be displayed distinctly at supported precision." };
  }
  return { valid: true, formatted };
}

export function buildTelegramUnlockUrl(setup) {
  const appUrl = appConfig.appUrl || appConfig.affiliate.publicAppUrl;
  const setupKey = setup?.setupKey || setup?.id;
  if (!appUrl || !setupKey) return "";

  const url = new URL(appUrl);
  url.searchParams.delete("telegramUnlock");
  const params = new URLSearchParams({ unlock: setupKey });
  if (setup?.signalId || setup?.id) params.set("signalId", setup.signalId || setup.id);
  url.hash = `signals?${params.toString()}`;
  return url.toString();
}
