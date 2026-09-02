export const MOMENTUM_1H_WATCH_VERSION = "momentum_1h_watch_v1";
export const MOMENTUM_1H_WATCH_STARTED_AT = "2026-09-02T00:00:00.000Z";

const PASS = "PASS";

export function calculateMomentum1hWatchDiagnostics(signal = {}) {
  const strategy = String(signal.setupType || "");
  const timeframe = String(signal.timeframe || "");
  const generatedAt = validTimestamp(signal.generatedAt);
  if (
    strategy !== "Momentum breakout" ||
    timeframe !== "1h" ||
    !generatedAt ||
    generatedAt < MOMENTUM_1H_WATCH_STARTED_AT
  ) {
    return null;
  }

  const indicators = signal.indicators || {};
  const momentum = indicators.momentumEntryDiagnostics || {};
  const evidence = signal.strategyEvidence || indicators.strategyEvidence || {};
  const preFixCounterfactual = evaluatePreFixMomentumClassifier({
    direction: signal.direction,
    entryPrice: signal.entryPrice,
    indicators,
    momentum,
    evidence
  });

  return {
    version: MOMENTUM_1H_WATCH_VERSION,
    studyStartedAt: MOMENTUM_1H_WATCH_STARTED_AT,
    generatedAt,
    observationalOnly: true,
    productionDecisionInput: false,
    symbol: signal.symbol || null,
    timeframe,
    strategy,
    direction: normalizedDirection(signal.direction),
    productionSnapshot: {
      entry: finiteOrNull(signal.entryPrice),
      stopLoss: finiteOrNull(signal.stopLoss),
      takeProfit: finiteOrNull(signal.takeProfit),
      riskReward: finiteOrNull(signal.riskRewardRatio),
      confidence: finiteOrNull(signal.confidenceScore),
      quality: finiteOrNull(signal.qualityScore),
      readiness: finiteOrNull(signal.readinessScore ?? indicators.readinessScore),
      regime: indicators.regime || null,
      status: signal.status || null
    },
    marketConditionSnapshot: {
      atr: finiteOrNull(indicators.atr14),
      rsi: finiteOrNull(indicators.rsi14),
      adx: finiteOrNull(indicators.adx14),
      trendStrength: finiteOrNull(indicators.trendStrength),
      relativeVolume: finiteOrNull(momentum.volumeRatio),
      ema20DistanceAtr: finiteOrNull(momentum.ema20DistanceAtr),
      ema50DistanceAtr: finiteOrNull(momentum.ema50DistanceAtr),
      breakoutDistanceAtr: finiteOrNull(momentum.breakoutDistanceAtr),
      threeBarExpansionAtr: finiteOrNull(momentum.prior3BarMoveAtr),
      regime: indicators.regime || null
    },
    momentumEvidence: {
      candleRangeAtr: finiteOrNull(momentum.latestCandleRangeAtr),
      bodyAtr: finiteOrNull(momentum.latestBodyAtr),
      bodyToRange: finiteOrNull(momentum.bodyToRangeRatio),
      rsi: finiteOrNull(indicators.rsi14),
      volumeRatio: finiteOrNull(momentum.volumeRatio),
      ema20DistanceAtr: finiteOrNull(momentum.ema20DistanceAtr),
      ema50DistanceAtr: finiteOrNull(momentum.ema50DistanceAtr),
      breakoutDistanceAtr: finiteOrNull(momentum.breakoutDistanceAtr),
      stopClearanceAtr: finiteOrNull(momentum.stopBeyondBreakoutCandleAtr),
      stopDistanceAtr: finiteOrNull(momentum.stopDistanceAtr),
      threeBarExpansionAtr: finiteOrNull(momentum.prior3BarMoveAtr),
      directionalExpansionCount3: finiteOrNull(momentum.directionalExpansionCount3),
      closeBeyondLevelAtr: finiteOrNull(momentum.closeBeyondLevelAtr),
      referenceLevel: finiteOrNull(evidence.referenceLevel),
      freshness: {
        qualified: booleanOrNull(evidence.qualified),
        breakoutFresh: booleanOrNull(evidence.breakoutFresh),
        priorBreakoutDetected: booleanOrNull(evidence.priorBreakoutDetected),
        interveningCloseMinus3: finiteOrNull(evidence.interveningCloseMinus3),
        interveningCloseMinus2: finiteOrNull(evidence.interveningCloseMinus2),
        triggerCandle: compactCandle(evidence.triggerCandle)
      }
    },
    preFixCounterfactual,
    shadowDisabled: {
      wouldSkip: true,
      modeledRealizedR: 0,
      affectsProduction: false
    }
  };
}

export function evaluatePreFixMomentumClassifier({
  direction,
  entryPrice,
  indicators = {},
  momentum = {},
  evidence = {}
} = {}) {
  const normalized = normalizedDirection(direction);
  const entry = finiteOrNull(entryPrice);
  const referenceLevel = finiteOrNull(evidence.referenceLevel);
  const previousClose = finiteOrNull(evidence.interveningCloseMinus2);
  const trigger = compactCandle(evidence.triggerCandle);
  const ema20 = finiteOrNull(indicators.ema20);
  const ema50 = finiteOrNull(indicators.ema50);
  const volumeRatio = finiteOrNull(momentum.volumeRatio);
  const deterministic = [entry, referenceLevel, previousClose, trigger?.open, trigger?.close, ema20, ema50, volumeRatio]
    .every((value) => value != null) && ["long", "short"].includes(normalized);

  if (!deterministic) {
    const reason = !["long", "short"].includes(normalized)
      ? "OTHER"
      : referenceLevel == null || previousClose == null || !trigger
        ? "REFERENCE"
        : ema20 == null || ema50 == null || entry == null
          ? "EMA"
          : volumeRatio == null ? "VOLUME" : "OTHER";
    return counterfactual(false, reason, false, {
      referenceAvailable: referenceLevel != null,
      triggerAvailable: Boolean(trigger),
      emaAvailable: ema20 != null && ema50 != null,
      volumeAvailable: volumeRatio != null
    });
  }

  const referencePassed = normalized === "long"
    ? previousClose <= referenceLevel && trigger.close > referenceLevel && trigger.close > trigger.open
    : previousClose >= referenceLevel && trigger.close < referenceLevel && trigger.close < trigger.open;
  const emaPassed = normalized === "long"
    ? entry > ema20 && ema20 > ema50
    : entry < ema20 && ema20 < ema50;
  const volumePassed = volumeRatio >= 1.02;
  const checks = { referenceAvailable: true, freshnessPassed: referencePassed, emaPassed, volumePassed };

  if (!referencePassed) return counterfactual(false, "FRESHNESS", true, checks);
  if (!emaPassed) return counterfactual(false, "EMA", true, checks);
  if (!volumePassed) return counterfactual(false, "VOLUME", true, checks);
  return counterfactual(true, PASS, true, checks);
}

function counterfactual(wouldPass, reason, deterministic, checks) {
  return {
    scope: "pre_fix_momentum_classifier",
    wouldPreFixMomentumPass: wouldPass,
    reason,
    deterministic,
    diagnosticOnly: true,
    checks
  };
}

function compactCandle(candle) {
  if (!candle || typeof candle !== "object") return null;
  const open = finiteOrNull(candle.open);
  const high = finiteOrNull(candle.high);
  const low = finiteOrNull(candle.low);
  const close = finiteOrNull(candle.close);
  const volume = finiteOrNull(candle.volume);
  if ([open, high, low, close].some((value) => value == null)) return null;
  return { time: candle.time ?? null, open, high, low, close, volume };
}

function validTimestamp(value) {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function normalizedDirection(value) {
  return String(value || "").toLowerCase();
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}
