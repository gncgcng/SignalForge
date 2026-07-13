import {
  cancelPaperOrder,
  closePaperOrder,
  createPaperOrder,
  createPaperTrade,
  expirePendingPaperOrders,
  fillPaperOrder,
  findPaperOrder,
  findSignalById,
  getPaperAccount,
  listPaperOrders,
  listPaperTradesByUser,
  resetPaperAccount
} from "../../db/repositories.js";
import { updateSignalsForUser } from "../signals/signalOutcomeService.js";
import { calculatePositionSizing } from "../risk/riskEngineService.js";
import { getCachedOhlcv, getOhlcv, getPair, listPairs } from "../market-data/marketDataService.js";

const supportedPaperTimeframes = ["5m", "15m", "1h", "4h"];

export async function getPaperPortfolio(user) {
  await updateSignalsForUser(user);
  const trades = await listPaperTradesByUser(user.id);

  return {
    trades,
    stats: calculatePaperStats(trades)
  };
}

export async function enterPaperTrade(user, signalId, input = {}) {
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

  const sizing = calculatePositionSizing({
    accountSize: input.accountSize,
    requestedRiskPercent: input.riskPercent,
    qualityScore: signal.qualityScore,
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit
  });

  if (!sizing.tradeAllowed) {
    throw validationError(sizing.explanation || "Dynamic Risk Engine suggests no trade.");
  }

  const inserted = await createPaperTrade(user.id, signal.id, sizing);

  if (!inserted) {
    const error = validationError("This signal is already in your Paper Portfolio.");
    error.statusCode = 409;
    throw error;
  }

  return getPaperPortfolio(user);
}

export async function getPaperTradingTerminal(user, input = {}) {
  const symbol = String(input.symbol || "BTC-USD");
  const timeframe = supportedPaperTimeframes.includes(input.timeframe) ? input.timeframe : "15m";
  let marketData = null;
  let marketError = null;
  await expirePendingPaperOrders(user.id);

  try {
    marketData = await getOhlcv(symbol, timeframe);
    await syncPaperOrders(user.id, symbol, marketData.candles);
  } catch (error) {
    marketError = error.message;
  }

  const [account, orders] = await Promise.all([
    getPaperAccount(user.id),
    listPaperOrders(user.id)
  ]);
  const latestPrices = new Map();
  if (marketData?.pair?.lastPrice) latestPrices.set(symbol, Number(marketData.pair.lastPrice));
  for (const order of orders) {
    if (latestPrices.has(order.symbol)) continue;
    const cached = getCachedOhlcv(order.symbol, order.timeframe);
    if (cached?.pair?.lastPrice) latestPrices.set(order.symbol, Number(cached.pair.lastPrice));
  }
  const enriched = orders.map((order) => enrichPaperOrder(order, latestPrices.get(order.symbol)));

  return {
    account: buildPaperAccountSummary(account, enriched),
    orders: enriched,
    marketData,
    marketError,
    markets: listPairs().filter((pair) => pair.selectable && pair.category !== "Stocks & ETFs"),
    supportedTimeframes: supportedPaperTimeframes,
    disclaimer: "Paper trading only. No real orders are placed."
  };
}

export async function placePaperOrder(user, input = {}) {
  const symbol = String(input.symbol || "").trim();
  const timeframe = String(input.timeframe || "15m");
  const pair = getPair(symbol);
  if (!pair?.selectable || pair.category === "Stocks & ETFs") {
    throw validationError("Choose an available crypto or commodity market.");
  }
  if (!supportedPaperTimeframes.includes(timeframe)) {
    throw validationError(`${timeframe} is not supported by the selected market data provider.`);
  }
  if (input.savedSignalId && !await findSignalById(String(input.savedSignalId), user.id)) {
    const error = validationError("Unlocked signal not found for this account.");
    error.statusCode = 403;
    throw error;
  }

  const marketData = await getOhlcv(symbol, timeframe);
  const latestPrice = Number(marketData.pair.lastPrice || marketData.candles.at(-1)?.close);
  const normalized = normalizePaperOrder(input, latestPrice);
  const errors = validatePaperOrder(normalized);
  if (errors.length) throw validationError(errors.join(" "));

  const created = await createPaperOrder(user.id, normalized);
  if (!created) {
    const error = validationError("This signal is already added to Paper Trading.");
    error.statusCode = 409;
    throw error;
  }
  return getPaperTradingTerminal(user, { symbol, timeframe });
}

export async function closePaperPosition(user, orderId) {
  const order = await findPaperOrder(user.id, orderId);
  if (!order || order.status !== "Open") throw validationError("Open paper position not found.");
  const marketData = await getOhlcv(order.symbol, order.timeframe);
  const currentPrice = Number(marketData.pair.lastPrice || marketData.candles.at(-1)?.close);
  const close = calculatePaperClose(order, currentPrice, "Manual close", "Closed");
  await closePaperOrder(user.id, order.id, close);
  return getPaperTradingTerminal(user, { symbol: order.symbol, timeframe: order.timeframe });
}

export async function cancelPendingPaperOrder(user, orderId) {
  const cancelled = await cancelPaperOrder(user.id, orderId);
  if (!cancelled) throw validationError("Pending paper order not found.");
  return getPaperTradingTerminal(user, { symbol: cancelled.symbol, timeframe: cancelled.timeframe });
}

export async function resetPaperTradingAccount(user, confirmation) {
  if (confirmation !== "RESET") throw validationError("Type RESET to confirm the paper account reset.");
  await resetPaperAccount(user.id);
  return getPaperTradingTerminal(user, { symbol: "BTC-USD", timeframe: "15m" });
}

export function normalizePaperOrder(input, latestPrice) {
  const orderType = String(input.orderType || "market").toLowerCase();
  const intendedEntry = orderType === "limit" ? Number(input.limitPrice) : Number(latestPrice);
  const requestedQuantity = Number(input.quantity);
  const requestedPositionSize = Number(input.positionSizeUsd);
  const quantity = requestedQuantity > 0
    ? requestedQuantity
    : requestedPositionSize > 0 && intendedEntry > 0
      ? requestedPositionSize / intendedEntry
      : 0;
  const positionSizeUsd = requestedQuantity > 0 ? quantity * intendedEntry : requestedPositionSize;

  return {
    savedSignalId: input.savedSignalId ? String(input.savedSignalId) : null,
    symbol: String(input.symbol || ""),
    timeframe: String(input.timeframe || "15m"),
    direction: String(input.direction || "long").toLowerCase(),
    orderType,
    status: orderType === "limit" ? "Pending" : "Open",
    quantity,
    positionSizeUsd,
    entryPrice: orderType === "market" ? intendedEntry : null,
    limitPrice: orderType === "limit" ? intendedEntry : null,
    stopLoss: Number(input.stopLoss),
    takeProfit: Number(input.takeProfit),
    notes: String(input.notes || "").trim().slice(0, 1000),
    expiresAt: orderType === "limit" ? paperOrderExpiry(input.timeframe) : null,
    intendedEntry
  };
}

export function recommendSignalPaperAction(signal, currentPrice, atr) {
  const distance = Math.abs(Number(currentPrice) - Number(signal.entryPrice));
  const tolerance = Number(atr) > 0 ? Number(atr) * 0.25 : Math.abs(Number(signal.entryPrice) - Number(signal.stopLoss)) * 0.25;
  if (Number.isFinite(distance) && Number.isFinite(tolerance) && tolerance > 0 && distance <= tolerance) {
    return { action: "market", warning: "Current price is close to the signal entry zone. Simulated entry now is available." };
  }
  return { action: "watch", warning: "Signal entry is away from current price. Watch it or use a limit order that may remain pending until price reaches it." };
}

function paperOrderExpiry(timeframe) {
  const hours = { "1m": 2, "5m": 2, "15m": 6, "1h": 24, "4h": 48 }[timeframe] || 6;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function validatePaperOrder(order) {
  const errors = [];
  const numeric = [
    order.intendedEntry,
    order.quantity,
    order.positionSizeUsd,
    order.stopLoss,
    order.takeProfit
  ];
  if (!numeric.every((value) => Number.isFinite(value) && value > 0)) {
    errors.push("Entry, size, stop, and target must be positive finite values.");
    return errors;
  }
  if (!['long', 'short'].includes(order.direction)) errors.push("Direction must be long or short.");
  if (!['market', 'limit'].includes(order.orderType)) errors.push("Order type must be market or limit.");
  if (order.direction === "long") {
    if (order.stopLoss >= order.intendedEntry) errors.push("LONG stop loss must be below entry.");
    if (order.takeProfit <= order.intendedEntry) errors.push("LONG take profit must be above entry.");
  }
  if (order.direction === "short") {
    if (order.stopLoss <= order.intendedEntry) errors.push("SHORT stop loss must be above entry.");
    if (order.takeProfit >= order.intendedEntry) errors.push("SHORT take profit must be below entry.");
  }
  const risk = Math.abs(order.intendedEntry - order.stopLoss);
  const reward = Math.abs(order.takeProfit - order.intendedEntry);
  if (!risk || !Number.isFinite(reward / risk)) errors.push("Order risk/reward is invalid.");
  return errors;
}

export function evaluatePaperOrderCandle(order, candle) {
  const low = Number(candle.low);
  const high = Number(candle.high);
  if (![low, high].every(Number.isFinite)) return { action: "none" };
  if (order.status === "Pending") {
    const limit = Number(order.limitPrice);
    return low <= limit && high >= limit ? { action: "fill", price: limit } : { action: "none" };
  }
  if (order.status !== "Open") return { action: "none" };
  const stopHit = order.direction === "long" ? low <= order.stopLoss : high >= order.stopLoss;
  const targetHit = order.direction === "long" ? high >= order.takeProfit : low <= order.takeProfit;
  if (stopHit) return { action: "close", status: "Hit SL", outcome: "Hit SL", price: order.stopLoss };
  if (targetHit) return { action: "close", status: "Hit TP", outcome: "Hit TP", price: order.takeProfit };
  return { action: "none" };
}

export function calculatePaperClose(order, exitPrice, outcome = "Manual close", status = "Closed") {
  const direction = order.direction === "long" ? 1 : -1;
  const priceMove = (Number(exitPrice) - Number(order.entryPrice)) * direction;
  const riskPerUnit = Math.abs(Number(order.entryPrice) - Number(order.stopLoss));
  return {
    status,
    outcome,
    exitPrice: Number(exitPrice),
    realizedPnl: round(priceMove * Number(order.quantity)),
    rMultiple: riskPerUnit ? round(priceMove / riskPerUnit) : 0
  };
}

async function syncPaperOrders(userId, symbol, candles) {
  const orders = (await listPaperOrders(userId)).filter((order) =>
    order.symbol === symbol && ["Pending", "Open"].includes(order.status)
  );
  for (const initialOrder of orders) {
    let order = initialOrder;
    const since = new Date(order.openedAt || order.createdAt || 0).getTime();
    for (const candle of candles.filter((item) => Number(item.time) * 1000 >= since)) {
      const event = evaluatePaperOrderCandle(order, candle);
      if (event.action === "fill") {
        order = await fillPaperOrder(userId, order.id, event.price) || order;
        continue;
      }
      if (event.action === "close") {
        await closePaperOrder(
          userId,
          order.id,
          calculatePaperClose(order, event.price, event.outcome, event.status)
        );
        break;
      }
    }
  }
}

function enrichPaperOrder(order, currentPrice) {
  const price = Number(currentPrice || order.exitPrice || order.entryPrice || order.limitPrice || 0);
  if (order.status !== "Open" || !price) return { ...order, currentPrice: price, unrealizedPnl: 0, unrealizedR: 0 };
  const direction = order.direction === "long" ? 1 : -1;
  const move = (price - order.entryPrice) * direction;
  const risk = Math.abs(order.entryPrice - order.stopLoss);
  return {
    ...order,
    currentPrice: price,
    unrealizedPnl: round(move * order.quantity),
    unrealizedR: risk ? round(move / risk) : 0
  };
}

function buildPaperAccountSummary(account, orders) {
  const open = orders.filter((order) => order.status === "Open");
  const closed = orders.filter((order) => ["Hit TP", "Hit SL", "Closed"].includes(order.status));
  const wins = closed.filter((order) => order.realizedPnl > 0).length;
  const unrealizedPnl = round(open.reduce((sum, order) => sum + Number(order.unrealizedPnl || 0), 0));
  const netR = round(closed.reduce((sum, order) => sum + Number(order.rMultiple || 0), 0));
  return {
    ...account,
    equity: round(account.balance + unrealizedPnl),
    unrealizedPnl,
    openPositions: open.length,
    winRate: closed.length ? Math.round((wins / closed.length) * 100) : 0,
    netR,
    averageR: closed.length ? round(netR / closed.length) : 0
  };
}

export function calculatePaperStats(trades) {
  const executedTrades = trades.filter((trade) => !["Pending", "Cancelled", "Expired unfilled"].includes(trade.status));
  const totalPaperTrades = executedTrades.length;
  const wins = trades.filter((trade) => trade.status === "Hit TP").length;
  const losses = trades.filter((trade) => trade.status === "Hit SL").length;
  const resolved = wins + losses;
  const closedTrades = executedTrades.filter((trade) => trade.status !== "Open");
  const averageR = closedTrades.length
    ? round(closedTrades.reduce((sum, trade) => sum + Number(trade.realizedR || 0), 0) / closedTrades.length)
    : 0;

  return {
    totalPaperTrades,
    winRate: resolved ? Math.round((wins / resolved) * 100) : 0,
    averageR,
    bestMarket: findBestGroup(executedTrades, (trade) => trade.symbol),
    bestTimeframe: findBestGroup(executedTrades, (trade) => trade.timeframe),
    accountGrowthCurve: calculateAccountGrowthCurve(executedTrades)
  };
}

export function calculateAccountGrowthCurve(trades) {
  const ordered = [...trades].sort((a, b) => new Date(a.enteredAt) - new Date(b.enteredAt));
  if (!ordered.length) return [];
  let balance = Number(ordered[0].accountSize || 0);
  const curve = [{ label: "Start", value: round(balance) }];

  for (const trade of ordered) {
    if (trade.status === "Open") continue;
    balance += Number(trade.realizedPnl || 0);
    curve.push({
      label: trade.resolvedAt || trade.enteredAt,
      value: round(balance)
    });
  }

  return curve;
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
