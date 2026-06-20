import {
  createPaperTrade,
  findSignalById,
  listPaperTradesByUser
} from "../../db/repositories.js";
import { updateSignalsForUser } from "../signals/signalOutcomeService.js";

export async function getPaperPortfolio(user) {
  await updateSignalsForUser(user);
  const trades = await listPaperTradesByUser(user.id);

  return {
    trades,
    stats: calculatePaperStats(trades)
  };
}

export async function enterPaperTrade(user, signalId) {
  if (!signalId) {
    throw validationError("Choose an unlocked signal to paper trade.");
  }

  await updateSignalsForUser(user);
  const signal = await findSignalById(signalId, user.id);

  if (!signal) {
    throw validationError("Unlocked signal not found.");
  }

  if (signal.status !== "Active") {
    throw validationError("Only active unlocked signals can be entered as paper trades.");
  }

  const inserted = await createPaperTrade(user.id, signal.id);

  if (!inserted) {
    const error = validationError("This signal is already in your Paper Portfolio.");
    error.statusCode = 409;
    throw error;
  }

  return getPaperPortfolio(user);
}

export function calculatePaperStats(trades) {
  const totalPaperTrades = trades.length;
  const wins = trades.filter((trade) => trade.status === "Hit TP").length;
  const losses = trades.filter((trade) => trade.status === "Hit SL").length;
  const resolved = wins + losses;
  const closedTrades = trades.filter((trade) => trade.status !== "Open");
  const averageR = closedTrades.length
    ? round(closedTrades.reduce((sum, trade) => sum + Number(trade.realizedR || 0), 0) / closedTrades.length)
    : 0;

  return {
    totalPaperTrades,
    winRate: resolved ? Math.round((wins / resolved) * 100) : 0,
    averageR,
    bestMarket: findBestGroup(trades, (trade) => trade.symbol),
    bestTimeframe: findBestGroup(trades, (trade) => trade.timeframe)
  };
}

function findBestGroup(trades, keyFn) {
  const groups = new Map();

  for (const trade of trades) {
    const key = keyFn(trade);
    const group = groups.get(key) || {
      label: key,
      trades: 0,
      netR: 0,
      wins: 0,
      losses: 0
    };
    group.trades += 1;
    group.netR += Number(trade.realizedR || 0);
    if (trade.status === "Hit TP") group.wins += 1;
    if (trade.status === "Hit SL") group.losses += 1;
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      netR: round(group.netR),
      winRate: group.wins + group.losses
        ? Math.round((group.wins / (group.wins + group.losses)) * 100)
        : 0
    }))
    .filter((group) => group.wins + group.losses > 0)
    .sort((a, b) => {
      return b.netR - a.netR ||
        b.winRate - a.winRate ||
        b.trades - a.trades ||
        a.label.localeCompare(b.label);
    })[0] || null;
}

function round(value) {
  return Number(Number(value).toFixed(2));
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
