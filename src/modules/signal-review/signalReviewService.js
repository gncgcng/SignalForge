import { isAdminUser } from "../auth/authService.js";
import { getReadOnlySignalReviewMarketData } from "../market-data/marketDataService.js";
import { findReviewableSignal } from "./signalReviewRepository.js";

const timeframeSeconds = Object.freeze({ "5m": 300, "15m": 900, "1h": 3600, "4h": 21600 });

export async function getSignalReview(user, signalId, dependencies = {}) {
  const cleanId = String(signalId || "").trim();
  if (!cleanId) throw httpError(400, "Signal ID is required.");

  const findSignal = dependencies.findSignal || findReviewableSignal;
  const loadMarketData = dependencies.loadMarketData || getReadOnlySignalReviewMarketData;
  const signal = await findSignal(cleanId, user.id, isAdminUser(user));
  if (!signal) throw httpError(404, "Signal review is not available for this account.");

  const review = buildSignalReview(signal);
  const window = buildSignalReviewWindow(signal);
  try {
    const marketData = await loadMarketData(signal.symbol, signal.timeframe, window);
    const candles = normalizeReviewCandles(marketData?.candles || []);
    if (!candles.length) throw new Error("No historical candles were returned.");
    return {
      review,
      chart: {
        available: true,
        candles,
        currentPrice: finiteOrNull(marketData.latestPrice ?? candles.at(-1)?.close),
        source: marketData.source || signal.provider || null,
        from: window.from,
        to: window.to,
        outcomeCandleTime: findOutcomeCandleTime(candles, review.outcomeAt, signal.timeframe),
        message: null
      },
      disclaimer: "Educational tool only. Not financial advice. Signal Review is read-only."
    };
  } catch (error) {
    return {
      review,
      chart: {
        available: false,
        candles: [],
        currentPrice: null,
        source: signal.provider || null,
        from: window.from,
        to: window.to,
        outcomeCandleTime: null,
        message: "Historical chart data is unavailable for this signal."
      },
      disclaimer: "Educational tool only. Not financial advice. Signal Review is read-only."
    };
  }
}

export function buildSignalReview(signal) {
  const outcomeAt = getOutcomeTimestamp(signal);
  return {
    id: signal.id,
    signalId: signal.signalId,
    symbol: signal.symbol,
    displaySymbol: signal.displaySymbol,
    provider: signal.provider,
    timeframe: signal.timeframe,
    direction: signal.direction,
    strategy: signal.strategy,
    entry: Number(signal.entry),
    stopLoss: Number(signal.stopLoss),
    takeProfit: Number(signal.takeProfit),
    riskReward: Number(signal.riskReward),
    confidence: Number(signal.confidence),
    status: signal.status,
    source: signal.source,
    createdAt: signal.createdAt,
    validUntil: signal.validUntil,
    outcomeAt,
    realizedR: signal.realizedR == null ? null : Number(signal.realizedR),
    resultReason: signal.resultReason,
    legacy: Boolean(signal.legacy)
  };
}

export function buildSignalReviewWindow(signal, now = Date.now()) {
  const seconds = timeframeSeconds[signal.timeframe] || 900;
  const intervalMs = seconds * 1000;
  const created = validTime(signal.createdAt) || now;
  const outcome = validTime(getOutcomeTimestamp(signal));
  const terminal = outcome || (signal.status === "Active" ? now : validTime(signal.validUntil) || now);
  const paddedEnd = outcome ? Math.min(now, Math.max(created, terminal) + intervalMs * 24) : now;
  return {
    from: new Date(created - intervalMs * 32).toISOString(),
    to: new Date(Math.max(created, paddedEnd)).toISOString(),
    maxCandles: 2400
  };
}

export function findOutcomeCandleTime(candles, outcomeAt, timeframe) {
  const outcomeMs = validTime(outcomeAt);
  if (!outcomeMs || !candles.length) return null;
  const intervalMs = (timeframeSeconds[timeframe] || 900) * 1000;
  let closest = null;
  let closestDistance = Infinity;
  for (const candle of candles) {
    const distance = Math.abs(Number(candle.time) * 1000 - outcomeMs);
    if (distance < closestDistance) {
      closest = Number(candle.time);
      closestDistance = distance;
    }
  }
  return closestDistance <= intervalMs * 1.5 ? closest : null;
}

function normalizeReviewCandles(candles) {
  return candles
    .map((candle) => ({
      time: Number(candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume || 0)
    }))
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .sort((a, b) => a.time - b.time)
    .filter((candle, index, items) => index === 0 || candle.time !== items[index - 1].time);
}

function getOutcomeTimestamp(signal) {
  if (signal.status === "Hit TP") return signal.hitTpAt || signal.outcomeEvaluatedAt || null;
  if (signal.status === "Hit SL") return signal.hitSlAt || signal.outcomeEvaluatedAt || null;
  if (signal.status === "Expired") return signal.expiredAt || signal.outcomeEvaluatedAt || null;
  return null;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validTime(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) && time > 0 ? time : null;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

