import { getCachedOhlcv, getOhlcv, getPair } from "../market-data/marketDataService.js";
import {
  getAdminSignalQualityBreakdown,
  updateSignalGroupStatus
} from "../signals/signalConfidenceCalibrationService.js";
import {
  getGeneratedSignalById,
  getGeneratedSignalStats,
  listActiveGeneratedSignals,
  listGeneratedSignals,
  isForwardOutcomeEligibleSignal,
  updateGeneratedSignalStatus,
  upsertGeneratedSignal
} from "./generatedSignalRepository.js";

export async function saveGeneratedSignal(signal, context = {}) {
  if (!signal || signal.validationPassed === false) return null;
  const stored = await upsertGeneratedSignal(signal, context);
  if (stored && ["Hit TP", "Hit SL", "Expired", "Manually closed"].includes(signal.status)) {
    return updateGeneratedSignalStatus(stored.id, signal.status, {
      resolvedAt: signal.resolvedAt || signal.closedAt || new Date(),
      evaluatedAt: new Date(),
      reason: signal.resultReason || signal.statusReason || null,
      riskReward: stored.riskReward,
      recordForwardOutcomeMetrics: isForwardOutcomeEligibleSignal(stored)
    });
  }
  return stored;
}

export async function getAdminGeneratedSignals(filters) {
  const [listing, stats, qualityBreakdown] = await Promise.all([
    listGeneratedSignals(filters),
    getGeneratedSignalStats(),
    getAdminSignalQualityBreakdown(filters?.performanceScope || "current")
  ]);
  return { ...listing, stats, qualityBreakdown };
}

export async function getAdminGeneratedSignal(id) {
  return getGeneratedSignalById(id);
}

export async function updateAdminSignalGroupStatus(input, user) {
  return updateSignalGroupStatus({ ...input, userId: user?.id || "admin" });
}

export async function updateAllGeneratedSignalOutcomes(dependencies = {}) {
  const listActive = dependencies.listActiveGeneratedSignals || listActiveGeneratedSignals;
  const updateStatus = dependencies.updateGeneratedSignalStatus || updateGeneratedSignalStatus;
  const loadMarketData = dependencies.loadMarketData || loadGeneratedSignalMarketData;
  const warn = dependencies.warn || console.warn;
  const nowMs = dependencies.now ? Number(dependencies.now()) : Date.now();
  const active = await listActive();
  const groups = new Map();
  for (const signal of active) {
    const key = `${signal.pair}:${signal.timeframe}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(signal);
  }
  let updated = 0;
  for (const signals of groups.values()) {
    const first = signals[0];
    if (new Date(first.validUntil).getTime() <= nowMs) {
      for (const signal of signals) {
        if (new Date(signal.validUntil).getTime() <= nowMs) {
          const succeeded = await updateOutcomeStatus(signal, "Expired", {
            evaluatedAt: new Date(),
            reason: "Signal validity window ended before TP or SL was recorded.",
            riskReward: signal.riskReward,
            recordForwardOutcomeMetrics: isForwardOutcomeEligibleSignal(signal)
          }, { updateStatus, warn });
          if (succeeded) updated += 1;
        }
      }
    }
    const stillActive = signals.filter((signal) => new Date(signal.validUntil).getTime() > nowMs);
    if (!stillActive.length) continue;
    let marketData;
    try {
      marketData = await loadMarketData(first);
    } catch (error) {
      warn(`[admin-signals] outcome_tracking_skipped pair=${first.pair} timeframe=${first.timeframe} reason=${error.message}`);
      continue;
    }
    if (!marketData) continue;
    for (const signal of stillActive) {
      const generatedAt = new Date(signal.createdAt).getTime();
      const candles = (marketData.candles || []).filter((candle) => candleTimestamp(candle.time) >= generatedAt);
      for (const candle of candles) {
        const hit = candleOutcome(signal, candle);
        if (!hit) continue;
        const succeeded = await updateOutcomeStatus(signal, hit.status, {
          resolvedAt: new Date(candleTimestamp(candle.time)),
          evaluatedAt: new Date(),
          reason: hit.reason,
          riskReward: signal.riskReward,
          recordForwardOutcomeMetrics: isForwardOutcomeEligibleSignal(signal)
        }, { updateStatus, warn });
        if (succeeded) updated += 1;
        break;
      }
    }
  }
  if (updated) console.info(`[admin-signals] outcomes_updated=${updated}`);
  return updated;
}

async function loadGeneratedSignalMarketData(signal) {
  return getPair(signal.pair)?.category === "Commodities"
    ? getCachedOhlcv(signal.pair, signal.timeframe)
    : getOhlcv(signal.pair, signal.timeframe);
}

async function updateOutcomeStatus(signal, attemptedStatus, details, { updateStatus, warn }) {
  try {
    await updateStatus(signal.id, attemptedStatus, details);
    return true;
  } catch (error) {
    warn(`[admin-signals] outcome_update_failed ${JSON.stringify({
      signalId: signal.id || null,
      pair: signal.pair || null,
      timeframe: signal.timeframe || null,
      attemptedStatus,
      errorCode: error?.code || "UNCLASSIFIED_OUTCOME_UPDATE_ERROR",
      message: error?.message || String(error)
    })}`);
    return false;
  }
}

export function candleOutcome(signal, candle) {
  const long = signal.direction === "long";
  const hitTp = long ? Number(candle.high) >= signal.takeProfit : Number(candle.low) <= signal.takeProfit;
  const hitSl = long ? Number(candle.low) <= signal.stopLoss : Number(candle.high) >= signal.stopLoss;
  if (!hitTp && !hitSl) return null;
  if (hitTp && hitSl) return { status: "Hit SL", reason: "TP and SL touched in one candle; conservative ordering marked SL first." };
  return hitTp ? { status: "Hit TP", reason: "Take profit reached by live market candle." } : { status: "Hit SL", reason: "Stop loss reached by live market candle." };
}

function candleTimestamp(value) { const numeric = Number(value); return Number.isFinite(numeric) ? numeric * (numeric < 1e12 ? 1000 : 1) : new Date(value).getTime(); }
