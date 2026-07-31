import { getCachedOhlcv, getOhlcv, getPair } from "../market-data/marketDataService.js";
import {
  applyGeneratedSignalQualityBlock,
  applyTimeframeConfidencePolicy,
  evaluateGeneratedSignalQualityGate,
  hasGeneratedSignalQualityGate
} from "../signals/generatedSignalQualityGate.js";
import {
  getAdminSignalQualityBreakdown,
  updateSignalGroupStatus
} from "../signals/signalConfidenceCalibrationService.js";
import { getSignalQualityGateDashboard } from "../signals/signalQualityGateRepository.js";
import {
  evaluateGeneratedSignalTelegramDecision,
  recordTelegramAlertDiagnostic
} from "../notifications/telegramAlertDiagnosticsService.js";
import { applyFinalSignalDecision } from "../signals/signalDecisionService.js";
import {
  findGeneratedSignalReferences,
  getGeneratedSignalById,
  getGeneratedSignalStats,
  listActiveGeneratedSignals,
  listGeneratedSignals,
  updateGeneratedSignalStatus,
  upsertGeneratedSignal
} from "./generatedSignalRepository.js";
import {
  attachAdminSignalReferences,
  buildAdminSignalDiagnostics
} from "./adminSignalDiagnosticService.js";

export async function saveGeneratedSignal(signal, context = {}) {
  if (!signal || signal.validationPassed === false) return null;
  const source = context.source || signal.generationSource || signal.source || signal.indicators?.generationSource || "manual_scan";
  const cappedSignal = applyTimeframeConfidencePolicy(signal);
  const evaluatedSignal = await ensureGeneratedSignalQualityGate(cappedSignal, { ...context, source });
  const finalizedSignal = applyFinalSignalDecision({
    ...evaluatedSignal,
    source
  });
  const stored = await upsertGeneratedSignal(finalizedSignal, { ...context, source });
  await recordGeneratedSignalTelegramDecision(stored, finalizedSignal, { ...context, source });
  if (stored && ["Hit TP", "Hit SL", "Expired", "Manually closed"].includes(signal.status)) {
    return updateGeneratedSignalStatus(stored.id, signal.status, {
      resolvedAt: signal.resolvedAt || signal.closedAt || new Date(),
      reason: signal.resultReason || signal.statusReason || null
    });
  }
  return stored;
}

async function ensureGeneratedSignalQualityGate(signal, context = {}) {
  if (!shouldEvaluateGeneratedSignalQualityGate(context.source) || hasGeneratedSignalQualityGate(signal)) {
    return signal;
  }

  const gate = await evaluateGeneratedSignalQualityGate(signal, context);
  if (gate.passed) {
    const adjustedSignal = gate.adjustedSignal || signal;
    return {
      ...adjustedSignal,
      indicators: {
        ...(adjustedSignal.indicators || {}),
        qualityGatePassed: true,
        qualityGateV2: gate.qualityGateV2 || gate.details?.qualityGateV2 || null
      }
    };
  }

  return applyGeneratedSignalQualityBlock(signal, gate);
}

function shouldEvaluateGeneratedSignalQualityGate(source) {
  return !["legacy_saved_signal", "legacy_unlocked_signal", "backtest_shadow"].includes(source);
}

async function recordGeneratedSignalTelegramDecision(stored, signal, context = {}) {
  if (!stored || !shouldEvaluateGeneratedSignalQualityGate(context.source)) return;
  if (signal.finalDecision === "ready_signal") return;
  const decision = evaluateGeneratedSignalTelegramDecision(signal);
  try {
    await recordTelegramAlertDiagnostic({
      signal: {
        id: stored.signalId,
        signalId: stored.signalId,
        setupKey: stored.setupKey
      },
      userId: context.userId || null,
      status: decision.status,
      reason: decision.reason,
      details: decision.details
    });
  } catch (error) {
    console.warn(`[telegram-alerts] generated_decision_write_failed reason=${error.message}`);
  }
}

export async function getAdminGeneratedSignals(filters) {
  const [listing, stats, qualityBreakdown, qualityGate] = await Promise.all([
    listGeneratedSignals(filters),
    getGeneratedSignalStats(),
    getAdminSignalQualityBreakdown(filters?.performanceScope || "current"),
    getSignalQualityGateDashboard()
  ]);
  return { ...listing, stats, qualityBreakdown, qualityGate };
}

export async function getAdminGeneratedSignal(id) {
  const signal = await getGeneratedSignalById(id);
  if (!signal) return null;
  const diagnostics = buildAdminSignalDiagnostics(signal);
  const references = await findGeneratedSignalReferences([
    diagnostics.duplicate?.matchedSignalId,
    diagnostics.cooldown?.priorSignalId
  ]);
  return {
    ...signal,
    adminDiagnostics: attachAdminSignalReferences(diagnostics, references)
  };
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
