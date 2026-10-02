import { appConfig } from "../../config/appConfig.js";
import {
  expireActiveSignalsPastValidity,
  listActiveSignals,
  listSignalsByUser,
  recordSignalLearningEvent,
  refreshLearningStats,
  updateSignalOutcome
} from "../../db/repositories.js";
import { getOhlcv } from "../market-data/marketDataService.js";
import { runSignalPostMortem } from "./signalLearningService.js";
import { getSignalValidUntil } from "./signalValidityService.js";
import { recordPromotedCandidatePatternOutcome } from "./setupCandidateRepository.js";
import { listActiveGeneratedSignals, syncGeneratedSignalOutcome } from "../admin-signals/generatedSignalRepository.js";
import { candleOutcome, recordGeneratedSignalOutcome, updateAllGeneratedSignalOutcomes } from "../admin-signals/generatedSignalService.js";
import { getNonCryptoMarket, listNonCryptoMarkets } from "../markets/marketRegistry.js";
import { isMarketOpen, nextOpen } from "../markets/sessionService.js";

const terminalStatuses = new Set(["Hit TP", "Hit SL", "Expired"]);
let trackingTimer = null;
let trackingInProgress = false;
let sessionTrackingTimer = null;
let sessionTrackingInProgress = false;
const timeframeMs = Object.freeze({ "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 });

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

  // Win rate is TP / (TP + SL), matching every other win rate in the app; expired and manually
  // closed signals count toward closedCount but are neither wins nor losses.
  const decided = totals.hitTpCount + totals.hitSlCount;
  totals.winRate = decided === 0 ? 0 : Math.round((totals.hitTpCount / decided) * 100);
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
  await expireSignalsPastValidity();
  const signals = await listSignalsByUser(user.id);
  await updateSignalOutcomes(signals);
  return listSignalsByUser(user.id);
}

export async function updateAllActiveSignalOutcomes() {
  await expireSignalsPastValidity();
  await updateSignalOutcomes(await listActiveSignals());
  await updateAllGeneratedSignalOutcomes();
}

export async function expireSignalsPastValidity() {
  const expiredSignals = await expireActiveSignalsPastValidity();
  for (const signal of expiredSignals) {
    await runSignalPostMortem({ recordSignalLearningEvent, refreshLearningStats }, signal);
    await recordPromotedCandidatePatternOutcome(signal);
    await syncGeneratedSignalOutcome(signal);
  }
  console.info(`[signals] expired=${expiredSignals.length}`);
  return expiredSignals;
}

export function startSignalOutcomeTracker() {
  if (!appConfig.signalTracking.enabled || trackingTimer) {
    return;
  }

  updateAllActiveSignalOutcomes().catch((error) => {
    console.warn(`[signal-outcome-tracker] Startup cycle skipped: ${error.message}`);
  });

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
  // Session-bound markets are tracked by trackSessionBoundSignalOutcomes on their own cadence.
  const activeSignals = signals.filter((signal) =>
    !terminalStatuses.has(signal.status || "Active") && !isSessionBoundSignal(signal));

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
  const expiresAt = new Date(getSignalValidUntil(signal));

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

// Whether the every-minute tracker fetches market data for this signal. Session-bound markets are
// never fetched here: trackSessionBoundSignalOutcomes owns them, at a rate the provider can sustain.
export function shouldFetchSignalOutcomeMarketData(signal) {
  return !isSessionBoundSignal(signal);
}

export function isSessionBoundSignal(signal) {
  return Boolean(getNonCryptoMarket(signal?.symbol || signal?.pair));
}

export function startSessionBoundOutcomeTracker() {
  if (!appConfig.signalTracking.enabled || sessionTrackingTimer) return;
  const runCycle = async () => {
    if (sessionTrackingInProgress) return;
    sessionTrackingInProgress = true;
    try {
      await trackSessionBoundSignalOutcomes();
    } catch (error) {
      console.warn(`[signal-outcome-tracker] session-bound cycle skipped: ${error.message}`);
    } finally {
      sessionTrackingInProgress = false;
    }
  };
  setTimeout(runCycle, 30_000).unref?.();
  sessionTrackingTimer = setInterval(runCycle, appConfig.signalTracking.nonCryptoIntervalMs);
  console.info(`[signal-outcome-tracker] session-bound tracker started interval_ms=${appConfig.signalTracking.nonCryptoIntervalMs}`);
}

// Resolves open signals on session-bound (non-crypto) markets — saved user signals and the
// generated signals behind admin performance stats — against real candles:
// - one provider request per market per cycle, shared by every open signal on that market;
// - nothing is fetched for a closed market (its validity clock is paused anyway), unless a signal
//   there has reached the end of its window and needs its final check;
// - a signal is only expired after its whole window has been checked against candles; if that is
//   impossible for longer than the grace period it expires as explicitly unverified.
export async function trackSessionBoundSignalOutcomes(dependencies = {}) {
  const nowMs = dependencies.now ? new Date(dependencies.now()).getTime() : Date.now();
  const listSaved = dependencies.listActiveSignals || listActiveSignals;
  // Only session-bound pairs, so they can never sit behind hundreds of active crypto rows.
  const listGenerated = dependencies.listActiveGeneratedSignals ||
    (() => listActiveGeneratedSignals(5000, { pairs: listNonCryptoMarkets().map((market) => market.symbol) }));
  const loadMarketData = dependencies.loadMarketData || ((symbol, timeframe) => getOhlcv(symbol, timeframe));
  const graceMs = dependencies.finalCheckGraceMs ?? appConfig.signalTracking.nonCryptoFinalCheckGraceMs;

  const tracked = [
    ...(await listSaved())
      .filter((signal) => !terminalStatuses.has(signal.status || "Active") && isSessionBoundSignal(signal))
      .map((signal) => ({ kind: "saved", signal, symbol: signal.symbol, generatedAtMs: Date.parse(signal.generatedAt), validUntilMs: Date.parse(getSignalValidUntil(signal)) })),
    ...(await listGenerated())
      .filter((signal) => isSessionBoundSignal(signal))
      .map((signal) => ({ kind: "generated", signal, symbol: signal.pair, generatedAtMs: Date.parse(signal.createdAt), validUntilMs: Date.parse(signal.validUntil) }))
  ];
  const bySymbol = new Map();
  for (const item of tracked) {
    if (!bySymbol.has(item.symbol)) bySymbol.set(item.symbol, []);
    bySymbol.get(item.symbol).push(item);
  }

  const summary = {
    markets: bySymbol.size, signals: tracked.length, requests: 0, skippedClosed: 0, providerFailures: 0,
    hitTp: 0, hitSl: 0, expired: 0, expiredUnverified: 0, pending: 0, failures: []
  };
  for (const [symbol, items] of bySymbol) {
    const market = getNonCryptoMarket(symbol);
    const needsFinalCheck = items.some((item) => item.validUntilMs <= nowMs);
    if (!isMarketOpen(market, nowMs) && !needsFinalCheck) {
      summary.skippedClosed += 1;
      summary.pending += items.length;
      continue;
    }
    // Each signal gets the finest candles whose history still reaches back to it; signals that
    // agree share one request (the usual case: one request per market per cycle).
    const byTimeframe = new Map();
    for (const item of items) {
      const timeframe = chooseTrackingTimeframe(item, nowMs);
      if (!byTimeframe.has(timeframe)) byTimeframe.set(timeframe, []);
      byTimeframe.get(timeframe).push(item);
    }
    for (const [timeframe, group] of byTimeframe) {
      let candles = null;
      try {
        summary.requests += 1;
        candles = (await loadMarketData(symbol, timeframe))?.candles || [];
      } catch (error) {
        summary.providerFailures += 1;
        summary.failures.push({ symbol, timeframe, code: error.code || "PROVIDER_ERROR", message: error.message });
      }
      for (const item of group) {
        const decision = decideSessionBoundOutcome(item, candles, timeframe, market, nowMs, graceMs);
        if (decision.status === "pending") {
          summary.pending += 1;
          continue;
        }
        await recordSessionBoundOutcome(item, decision, dependencies);
        if (decision.status === "Hit TP") summary.hitTp += 1;
        else if (decision.status === "Hit SL") summary.hitSl += 1;
        else if (decision.verified) summary.expired += 1;
        else summary.expiredUnverified += 1;
      }
    }
  }

  if (summary.signals || summary.providerFailures) {
    console.info(
      `[signal-outcome-tracker] session_bound markets=${summary.markets} signals=${summary.signals} ` +
      `requests=${summary.requests} skipped_closed=${summary.skippedClosed} provider_failures=${summary.providerFailures} ` +
      `hit_tp=${summary.hitTp} hit_sl=${summary.hitSl} expired=${summary.expired} ` +
      `expired_unverified=${summary.expiredUnverified} pending=${summary.pending}`
    );
  }
  for (const failure of summary.failures) {
    console.warn(`[signal-outcome-tracker] session_bound_fetch_failed symbol=${failure.symbol} timeframe=${failure.timeframe} code=${failure.code}`);
  }
  return summary;
}

// Finest timeframe whose candle history (the provider returns a fixed number of candles) still
// reaches back to the signal. Finer candles order TP/SL hits better and bound window-edge error.
function chooseTrackingTimeframe(item, nowMs) {
  const span = Math.max(0, nowMs - item.generatedAtMs);
  const limit = appConfig.marketData.candleLimit;
  // 0.8: margin for the in-progress candle and minor provider gaps.
  return Object.keys(timeframeMs).find((timeframe) => timeframeMs[timeframe] * limit * 0.8 >= span) || "4h";
}

function decideSessionBoundOutcome(item, candles, timeframe, market, nowMs, graceMs) {
  const { signal, generatedAtMs, validUntilMs } = item;
  if (candles) {
    const inWindow = candles.filter((candle) => {
      const openedAt = Number(candle.time) * 1000;
      return openedAt >= generatedAtMs && openedAt < validUntilMs;
    });
    for (const candle of inWindow) {
      const hit = item.kind === "saved" ? getCandleOutcome(signal, candle, market) : candleOutcome(signal, candle);
      if (hit) return { status: hit.status, reason: hit.reason, resolvedAtMs: Number(candle.time) * 1000, verified: true };
    }
  }
  if (nowMs < validUntilMs) return { status: "pending" };

  // The window is over and no hit was found. Expire only if the candles actually cover it: from the
  // first open-market moment after generation through the end of validity.
  const stepMs = timeframeMs[timeframe];
  const coverageStartMs = isMarketOpen(market, generatedAtMs) ? generatedAtMs : nextOpen(market, generatedAtMs)?.getTime() ?? generatedAtMs;
  const covered = Boolean(candles?.length) &&
    Number(candles[0].time) * 1000 <= coverageStartMs &&
    Number(candles.at(-1).time) * 1000 + stepMs >= validUntilMs;
  if (covered) {
    return {
      status: "Expired",
      reason: "Validity window ended before TP or SL was reached (checked against market candles for the full window).",
      resolvedAtMs: validUntilMs,
      verified: true
    };
  }
  if (nowMs - validUntilMs < graceMs) return { status: "pending" };
  return {
    status: "Expired",
    reason: "Validity window ended, but market data for the full window could not be retrieved, so the outcome is unverified.",
    resolvedAtMs: validUntilMs,
    verified: false
  };
}

async function recordSessionBoundOutcome(item, decision, dependencies) {
  if (item.kind === "generated") {
    await recordGeneratedSignalOutcome(item.signal, decision.status, {
      resolvedAt: new Date(decision.resolvedAtMs),
      reason: decision.reason,
      verified: decision.verified
    }, dependencies);
    return;
  }
  const mark = dependencies.markSavedSignal || markSignal;
  await mark(item.signal, decision.status, decision.reason, Math.floor(decision.resolvedAtMs / 1000));
}

function getCandleOutcome(signal, candle, market = null) {
  const isLong = signal.direction === "long";
  const hitTp = isLong ? candle.high >= signal.takeProfit : candle.low <= signal.takeProfit;
  const hitSl = isLong ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;

  if (!hitTp && !hitSl) {
    return null;
  }

  if (hitTp && hitSl) {
    return resolveSameCandleHit(signal, candle);
  }

  const source = market ? "market" : "Coinbase";
  return hitTp
    ? { status: "Hit TP", reason: `Take profit reached by live ${source} candle.` }
    : { status: "Hit SL", reason: `Stop loss reached by live ${source} candle.` };
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
    .then(async () => {
      await runSignalPostMortem({ recordSignalLearningEvent, refreshLearningStats }, signal);
      await recordPromotedCandidatePatternOutcome(signal);
      await syncGeneratedSignalOutcome(signal);
    });
}
