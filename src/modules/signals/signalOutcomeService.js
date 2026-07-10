import { appConfig } from "../../config/appConfig.js";
import {
  listActiveSignals,
  listSignalsByUser,
  recordSignalLearningEvent,
  refreshLearningStats,
  updateSignalOutcome
} from "../../db/repositories.js";
import { getCachedOhlcv, getOhlcv, getPair } from "../market-data/marketDataService.js";
import { runSignalPostMortem } from "./signalLearningService.js";

const terminalStatuses = new Set(["Hit TP", "Hit SL", "Expired"]);
let trackingTimer = null;
let trackingInProgress = false;

export function calculateSignalStats(signals) {
  const totals = signals.reduce((stats, signal) => {
    const status = normalizeOutcomeStatus(signal.status || signal.outcome);
    stats.totalSignals += 1;

    if (status === "hit-tp") stats.hitTpCount += 1;
    if (status === "hit-sl") stats.hitSlCount += 1;
    if (status === "expired") stats.expiredCount += 1;
    if (["hit-tp", "hit-sl", "expired", "closed", "manually-closed"].includes(status)) stats.closedCount += 1;

    return stats;
  }, {
    totalSignals: 0,
    hitTpCount: 0,
    hitSlCount: 0,
    expiredCount: 0,
    closedCount: 0,
    winRate: 0
  });

  totals.winRate = totals.closedCount === 0 ? 0 : Math.round((totals.hitTpCount / totals.closedCount) * 100);
  return totals;
}

function normalizeOutcomeStatus(value) {
  const status = String(value || "active").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["hit-tp", "tp", "take-profit", "takeprofit"].includes(status)) return "hit-tp";
  if (["hit-sl", "sl", "stop-loss", "stoploss"].includes(status)) return "hit-sl";
  if (["expired", "expire", "timed-out", "timeout"].includes(status)) return "expired";
  if (["manually-closed", "manual-close", "manual-closed"].includes(status)) return "manually-closed";
  if (status === "closed") return "closed";
  return "active";
}

export async function updateSignalsForUser(user) {
  const signals = await listSignalsByUser(user.id);
  await updateSignalOutcomes(signals);
  return signals;
}

export async function updateAllActiveSignalOutcomes() {
  await updateSignalOutcomes(await listActiveSignals());
}

export function startSignalOutcomeTracker() {
  if (!appConfig.signalTracking.enabled || trackingTimer) {
    return;
  }

  trackingTimer = setInterval(async () => {
    if (trackingInProgress) {
      return;
    }

    trackingInProgress = true;

    try {
      await updateAllActiveSignalOutcomes();
    } catch (error) {
      console.warn(`[signal-outcome-tracker] Database cycle skipped: ${error.message}`);
    } finally {
      trackingInProgress = false;
    }
  }, appConfig.signalTracking.intervalMs);
}

async function updateSignalOutcomes(signals) {
  const activeSignals = signals.filter((signal) => !terminalStatuses.has(signal.status || "Active"));

  for (const signal of activeSignals) {
    try {
      await updateSingleSignalOutcome(signal);
    } catch (error) {
      signal.lastTrackingError = error.message;
      signal.lastTrackingAttemptAt = new Date().toISOString();
      await updateSignalOutcome(signal);
    }
  }
}

async function updateSingleSignalOutcome(signal) {
  const createdAt = new Date(signal.generatedAt);
  const expiresAt = new Date(createdAt.getTime() + appConfig.signalTracking.expirationHours * 60 * 60 * 1000);

  if (Date.now() > expiresAt.getTime()) {
    await markSignal(signal, "Expired", "Signal expired before TP or SL was detected.");
    return;
  }

  const marketData = shouldFetchSignalOutcomeMarketData(signal)
    ? await getOhlcv(signal.symbol, signal.timeframe)
    : getCachedOhlcv(signal.symbol, signal.timeframe);

  if (!marketData) {
    return;
  }

  const candles = marketData.candles.filter((candle) => candle.time * 1000 >= createdAt.getTime());

  for (const candle of candles) {
    const outcome = getCandleOutcome(signal, candle);

    if (outcome) {
      await markSignal(signal, outcome.status, outcome.reason, candle.time);
      return;
    }
  }
}

export function shouldFetchSignalOutcomeMarketData(signal) {
  return getPair(signal.symbol)?.category !== "Commodities";
}

function getCandleOutcome(signal, candle) {
  const isLong = signal.direction === "long";
  const hitTp = isLong ? candle.high >= signal.takeProfit : candle.low <= signal.takeProfit;
  const hitSl = isLong ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;

  if (!hitTp && !hitSl) {
    return null;
  }

  if (hitTp && hitSl) {
    return resolveSameCandleHit(signal, candle);
  }

  return hitTp
    ? { status: "Hit TP", reason: "Take profit reached by live Coinbase candle." }
    : { status: "Hit SL", reason: "Stop loss reached by live Coinbase candle." };
}

function resolveSameCandleHit(signal, candle) {
  const isBullish = candle.close >= candle.open;

  if (signal.direction === "long") {
    return isBullish
      ? { status: "Hit SL", reason: "TP and SL were touched in one candle; conservative path marked SL first." }
      : { status: "Hit TP", reason: "TP and SL were touched in one candle; candle path marked TP first." };
  }

  return isBullish
    ? { status: "Hit TP", reason: "TP and SL were touched in one candle; candle path marked TP first." }
    : { status: "Hit SL", reason: "TP and SL were touched in one candle; conservative path marked SL first." };
}

function markSignal(signal, status, reason, candleTime = null) {
  signal.status = status;
  signal.statusReason = reason;
  signal.statusUpdatedAt = new Date().toISOString();
  signal.resolvedAt = candleTime ? new Date(candleTime * 1000).toISOString() : signal.statusUpdatedAt;
  return updateSignalOutcome(signal)
    .then(() => runSignalPostMortem({ recordSignalLearningEvent, refreshLearningStats }, signal));
}
