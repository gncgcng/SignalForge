import { isAdminUser } from "../auth/authService.js";
import { getOhlcv } from "../market-data/marketDataService.js";
import { generateMarketDataSetup } from "../signals/signalGenerator.js";

const supportedSymbols = new Set(["BTC-USD", "ETH-USD", "SOL-USD", "XAU/USD"]);
const supportedTimeframes = new Set(["15m", "1h", "4h"]);
const warmupCandles = 60;
const maximumHoldingBars = 20;

export async function runHistoricalBacktest(user, { symbol, timeframe }) {
  assertAdmin(user);
  assertSupported(symbol, timeframe);

  const marketData = await getOhlcv(symbol, timeframe);
  const report = backtestMarketData(marketData, timeframe);

  console.info(
    `[backtest] symbol=${symbol} timeframe=${timeframe} provider=${marketData.source} candles=${marketData.candles.length} trades=${report.metrics.totalTrades}`
  );

  return report;
}

export function backtestMarketData(marketData, timeframe) {
  const candles = marketData.candles || [];
  const trades = [];
  let index = warmupCandles - 1;

  while (index < candles.length - 1) {
    const historicalMarketData = {
      ...marketData,
      candles: candles.slice(0, index + 1)
    };
    const result = generateMarketDataSetup(historicalMarketData, timeframe);

    if (!result.valid) {
      index += 1;
      continue;
    }

    const finalIndex = Math.min(candles.length - 1, index + maximumHoldingBars);
    const outcome = evaluateTradeOutcome(
      result.signal,
      candles.slice(index + 1, finalIndex + 1),
      index + 1
    );

    trades.push({
      symbol: result.signal.symbol,
      timeframe,
      direction: result.signal.direction,
      setupType: result.signal.setupType,
      qualityScore: result.signal.qualityScore,
      confidenceScore: result.signal.confidenceScore,
      entryPrice: result.signal.entryPrice,
      stopLoss: result.signal.stopLoss,
      takeProfit: result.signal.takeProfit,
      riskRewardRatio: result.signal.riskRewardRatio,
      openedAt: toIso(candles[index].time),
      closedAt: toIso(candles[outcome.exitIndex]?.time),
      outcome: outcome.status,
      realizedR: outcome.realizedR
    });

    index = Math.max(index + 1, outcome.exitIndex);
  }

  const metrics = calculateBacktestMetrics(trades);

  return {
    symbol: marketData.pair.symbol,
    timeframe,
    provider: marketData.source,
    candleCount: candles.length,
    period: {
      from: candles.length ? toIso(candles[0].time) : null,
      to: candles.length ? toIso(candles[candles.length - 1].time) : null
    },
    metrics,
    ruleSetEvaluation: evaluateRuleSet(metrics),
    trades: trades.slice(-50).reverse(),
    generatedAt: new Date().toISOString()
  };
}

export function evaluateTradeOutcome(signal, forwardCandles, firstIndex = 0) {
  for (let offset = 0; offset < forwardCandles.length; offset += 1) {
    const candle = forwardCandles[offset];
    const hitStop = signal.direction === "long"
      ? candle.low <= signal.stopLoss
      : candle.high >= signal.stopLoss;
    const hitTarget = signal.direction === "long"
      ? candle.high >= signal.takeProfit
      : candle.low <= signal.takeProfit;

    // Intrabar order is unknowable from OHLCV. Treat simultaneous touches
    // conservatively as a stopped trade instead of inflating accuracy.
    if (hitStop) {
      return {
        status: "Hit SL",
        realizedR: -1,
        exitIndex: firstIndex + offset
      };
    }

    if (hitTarget) {
      return {
        status: "Hit TP",
        realizedR: Number(signal.riskRewardRatio),
        exitIndex: firstIndex + offset
      };
    }
  }

  return {
    status: "Expired",
    realizedR: 0,
    exitIndex: firstIndex + Math.max(0, forwardCandles.length - 1)
  };
}

export function calculateBacktestMetrics(trades) {
  const wins = trades.filter((trade) => trade.outcome === "Hit TP").length;
  const losses = trades.filter((trade) => trade.outcome === "Hit SL").length;
  const expired = trades.filter((trade) => trade.outcome === "Expired").length;
  const resolved = wins + losses;
  const totalR = trades.reduce((sum, trade) => sum + Number(trade.realizedR || 0), 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const trade of trades) {
    equity += Number(trade.realizedR || 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  return {
    totalTrades: trades.length,
    wins,
    losses,
    expired,
    winRate: resolved ? round((wins / resolved) * 100) : 0,
    averageR: trades.length ? round(totalR / trades.length) : 0,
    netR: round(totalR),
    maxDrawdownR: round(maxDrawdown),
    averageQualityScore: trades.length
      ? round(trades.reduce((sum, trade) => sum + Number(trade.qualityScore || 0), 0) / trades.length)
      : 0
  };
}

function evaluateRuleSet(metrics) {
  if (metrics.totalTrades < 8) {
    return {
      status: "insufficient-sample",
      eligibleForEnablement: false,
      message: "Not enough qualifying historical trades to evaluate this rule set."
    };
  }

  const passed = metrics.winRate >= 50 && metrics.averageR > 0 && metrics.maxDrawdownR <= 6;
  return {
    status: passed ? "passed" : "failed",
    eligibleForEnablement: passed,
    message: passed
      ? "Historical checks passed. Manual review is still required before enabling a rule set."
      : "Historical checks did not meet the minimum win rate, average R, and drawdown thresholds."
  };
}

function assertSupported(symbol, timeframe) {
  if (!supportedSymbols.has(symbol)) {
    const error = new Error("Backtesting currently supports BTC-USD, ETH-USD, SOL-USD, and XAU/USD.");
    error.statusCode = 400;
    throw error;
  }

  if (!supportedTimeframes.has(timeframe)) {
    const error = new Error("Backtesting currently supports 15m, 1h, and 4h.");
    error.statusCode = 400;
    throw error;
  }
}

function assertAdmin(user) {
  if (!isAdminUser(user)) {
    const error = new Error("Admin access required.");
    error.statusCode = 403;
    throw error;
  }
}

function toIso(unixSeconds) {
  return Number.isFinite(Number(unixSeconds))
    ? new Date(Number(unixSeconds) * 1000).toISOString()
    : null;
}

function round(value) {
  return Number(Number(value).toFixed(2));
}
