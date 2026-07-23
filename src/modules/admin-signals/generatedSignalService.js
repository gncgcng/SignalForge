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
  updateGeneratedSignalStatus,
  upsertGeneratedSignal
} from "./generatedSignalRepository.js";

export async function saveGeneratedSignal(signal, context = {}) {
  if (!signal || signal.validationPassed === false) return null;
  const stored = await upsertGeneratedSignal(signal, context);
  if (stored && ["Hit TP", "Hit SL", "Expired", "Manually closed"].includes(signal.status)) {
    return updateGeneratedSignalStatus(stored.id, signal.status, {
      resolvedAt: signal.resolvedAt || signal.closedAt || new Date(),
      reason: signal.resultReason || signal.statusReason || null
    });
  }
  return stored;
}

export async function getAdminGeneratedSignals(filters) {
  const [listing, stats, qualityBreakdown] = await Promise.all([
    listGeneratedSignals(filters),
    getGeneratedSignalStats(),
    getAdminSignalQualityBreakdown()
  ]);
  return { ...listing, stats, qualityBreakdown };
}

export async function getAdminGeneratedSignal(id) {
  return getGeneratedSignalById(id);
}

export async function updateAdminSignalGroupStatus(input, user) {
  return updateSignalGroupStatus({ ...input, userId: user?.id || "admin" });
}

export async function updateAllGeneratedSignalOutcomes() {
  const active = await listActiveGeneratedSignals();
  const groups = new Map();
  for (const signal of active) {
    const key = `${signal.pair}:${signal.timeframe}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(signal);
  }
  let updated = 0;
  for (const signals of groups.values()) {
    const first = signals[0];
    if (new Date(first.validUntil).getTime() <= Date.now()) {
      for (const signal of signals) {
        if (new Date(signal.validUntil).getTime() <= Date.now()) {
          await updateGeneratedSignalStatus(signal.id, "Expired", { reason: "Signal validity window ended before TP or SL was recorded." });
          updated += 1;
        }
      }
    }
    const stillActive = signals.filter((signal) => new Date(signal.validUntil).getTime() > Date.now());
    if (!stillActive.length) continue;
    try {
      const marketData = getPair(first.pair)?.category === "Commodities"
        ? getCachedOhlcv(first.pair, first.timeframe)
        : await getOhlcv(first.pair, first.timeframe);
      if (!marketData) continue;
      for (const signal of stillActive) {
        const generatedAt = new Date(signal.createdAt).getTime();
        const candles = (marketData.candles || []).filter((candle) => candleTimestamp(candle.time) >= generatedAt);
        for (const candle of candles) {
          const hit = candleOutcome(signal, candle);
          if (!hit) continue;
          await updateGeneratedSignalStatus(signal.id, hit.status, { resolvedAt: new Date(candleTimestamp(candle.time)), reason: hit.reason });
          updated += 1;
          break;
        }
      }
    } catch (error) {
      console.warn(`[admin-signals] outcome_tracking_skipped pair=${first.pair} timeframe=${first.timeframe} reason=${error.message}`);
    }
  }
  if (updated) console.info(`[admin-signals] outcomes_updated=${updated}`);
  return updated;
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
