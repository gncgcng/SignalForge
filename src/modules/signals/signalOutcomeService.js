import { appConfig } from "../../config/appConfig.js";
import { listActiveSignals, listSignalsByUser, updateSignalOutcome } from "../../db/repositories.js";
import { getOhlcv } from "../market-data/marketDataService.js";

const terminalStatuses = new Set(["Hit TP", "Hit SL", "Expired"]);
let trackingTimer = null;
let trackingInProgress = false;

export function calculateSignalStats(signals) {
  const totals = signals.reduce((stats, signal) => {
    const status = signal.status || "Active";
    stats.totalSignals += 1;

    if (status === "Hit TP") stats.hitTpCount += 1;
    if (status === "Hit SL") stats.hitSlCount += 1;
    if (status === "Expired") stats.expiredCount += 1;

    return stats;
  }, {
    totalSignals: 0,
    hitTpCount: 0,
    hitSlCount: 0,
    expiredCount: 0,
    winRate: 0
  });

  const resolved = totals.hitTpCount + totals.hitSlCount;
  totals.winRate = resolved === 0 ? 0 : Math.round((totals.hitTpCount / resolved) * 100);
  return totals;
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
      console.warn(`Signal outcome tracker skipped a cycle: ${error.message}`);
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

  const marketData = await getOhlcv(signal.symbol, signal.timeframe);
  const candles = marketData.candles.filter((candle) => candle.time * 1000 >= createdAt.getTime());

  for (const candle of candles) {
    const outcome = getCandleOutcome(signal, candle);

    if (outcome) {
      await markSignal(signal, outcome.status, outcome.reason, candle.time);
      return;
    }
  }
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
  return updateSignalOutcome(signal);
}
