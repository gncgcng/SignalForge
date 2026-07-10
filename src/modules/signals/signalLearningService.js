const terminalOutcomeTags = {
  "Hit TP": ["winner_confirmations"],
  "Hit SL": ["trend_reversal_after_entry", "weak_confirmation"],
  Expired: ["no_momentum_follow_through", "entry_did_not_develop"]
};

export function buildSignalSnapshot(signal, marketData = null) {
  const indicators = signal.indicators || {};
  const latest = marketData?.candles?.[marketData.candles.length - 1] || null;
  const pair = marketData?.pair || {};
  const confirmations = signal.confirmations || [];

  return Object.freeze({
    pair: signal.symbol,
    displayPair: pair.displaySymbol || signal.symbol?.replace?.("-", "") || signal.symbol,
    provider: signal.marketSource || marketData?.source || pair.provider || null,
    timeframe: signal.timeframe,
    direction: signal.direction,
    strategy: signal.setupType,
    entry: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    riskRewardRatio: signal.riskRewardRatio,
    confidence: signal.confidenceScore,
    confidenceBand: signal.confidenceBand || indicators.validationConfidenceBand || confidenceBand(signal.confidenceScore),
    validationScore: signal.validationScore,
    marketRegime: indicators.regime || signal.regime || null,
    volatilityRegime: indicators.volatilityLevel || null,
    session: indicators.session || signal.session?.name || signal.session || null,
    spread: indicators.spread || null,
    atr: indicators.atr14,
    rsi: indicators.rsi14,
    adx: indicators.adx14,
    emaRelationship: getEmaRelationship(indicators),
    volumeVsVolumeMa: getVolumeVsMa(signal, indicators),
    supportResistanceDistance: {
      support: indicators.support,
      resistance: indicators.resistance
    },
    vwapAlignment: Boolean(indicators.vwapAligned),
    liquiditySweepStatus: getSmcFactor(signal, "Liquidity Sweep"),
    orderBlockStatus: getSmcFactor(signal, "Order Block"),
    fairValueGapStatus: getSmcFactor(signal, "Fair Value Gap"),
    bosChochStatus: getSmcFactor(signal, "BOS/CHoCH"),
    volumeProfileStatus: Boolean(indicators.volumeProfileAligned),
    correlationFilterStatus: indicators.correlationConflict ? "conflict" : indicators.correlationAligned ? "aligned" : "neutral",
    multiTimeframeAlignment: indicators.alignmentBadge || signal.alignmentBadge,
    rejectionWarnings: indicators.validationRejectedReasons || signal.rejectedReasons || [],
    analystStrengths: indicators.analystStrengths || signal.analyst?.strengths || [],
    analystWeaknesses: indicators.analystWeaknesses || signal.analyst?.weaknesses || [],
    createdAt: signal.generatedAt,
    candleTimestamp: latest?.time ? new Date(latest.time * 1000).toISOString() : null,
    latestCandle: latest ? {
      time: latest.time,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
      volume: latest.volume
    } : null,
    checklist: confirmations.map((item) => ({
      name: item.name,
      passed: Boolean(item.passed),
      detail: item.detail || ""
    }))
  });
}

export async function recordLearningSnapshot(repository, userId, signal, marketData = null) {
  const snapshot = buildSignalSnapshot(signal, marketData);
  await repository.saveSignalSnapshot(userId, signal.id, snapshot);
  return snapshot;
}

export async function runSignalPostMortem(repository, signal) {
  if (!["Hit TP", "Hit SL", "Expired", "Manually closed"].includes(signal.status)) {
    return null;
  }

  const event = buildLearningEvent(signal);
  await repository.recordSignalLearningEvent(event);
  await repository.refreshLearningStats(event);
  return event;
}

export function buildLearningEvent(signal) {
  const outcome = signal.status;
  return {
    signalId: signal.id,
    userId: signal.userId,
    pair: signal.symbol,
    timeframe: signal.timeframe,
    direction: signal.direction,
    strategy: signal.setupType || "Unknown strategy",
    outcome,
    netR: outcome === "Hit TP"
      ? Number(signal.riskRewardRatio || 0)
      : outcome === "Hit SL"
        ? -1
        : 0,
    postMortemTags: buildPostMortemTags(signal),
    createdAt: signal.generatedAt || new Date().toISOString(),
    closedAt: signal.resolvedAt || signal.statusUpdatedAt || new Date().toISOString()
  };
}

export function buildPostMortemTags(signal) {
  const indicators = signal.indicators || {};
  const confirmations = signal.confirmations || [];
  const failed = confirmations
    .filter((item) => !item.passed)
    .map((item) => `failed_${slug(item.name)}`);
  const tags = new Set([...(terminalOutcomeTags[signal.status] || []), ...failed]);

  if (signal.status === "Hit TP") {
    confirmations.filter((item) => item.passed).forEach((item) => tags.add(`confirmed_${slug(item.name)}`));
  }
  if (signal.status === "Hit SL") {
    if (Number(indicators.rsi14 || 0) > 68 || Number(indicators.rsi14 || 0) < 32) tags.add("rsi_too_extended");
    if (indicators.correlationConflict) tags.add("correlation_conflict");
    if (indicators.vwapAvailable && !indicators.vwapAligned) tags.add("vwap_conflict");
    if (String(indicators.sessionLiquidity || "").toLowerCase() === "low") tags.add("low_liquidity_session");
    if (Number(signal.riskRewardRatio || 0) > 2.4) tags.add("target_too_aggressive");
  }
  if (signal.status === "Expired") {
    if (String(indicators.volatilityLevel || "").toLowerCase().includes("low")) tags.add("low_volatility");
    if (Number(indicators.atrRatio || 0) < 0.001) tags.add("atr_too_low");
    if (String(indicators.sessionLiquidity || "").toLowerCase() === "low") tags.add("session_liquidity_issue");
  }

  return [...tags];
}

export function applyLearningAdjustment(signal, learning = null) {
  if (!signal || !learning) {
    return withLearningInsight(signal, neutralInsight());
  }

  const adjustment = calculateLearningAdjustment(learning);
  const nextConfidence = Math.min(99, Math.max(0, Number(signal.confidenceScore || 0) + adjustment));
  const insight = buildLearningInsight(learning, adjustment);

  return {
    ...signal,
    confidenceScore: nextConfidence,
    indicators: {
      ...(signal.indicators || {}),
      learningApplied: true,
      learningAdjustment: adjustment,
      learningInsight: insight.message,
      learningMode: insight.mode,
      learningSampleSize: insight.sampleSize
    },
    learningInsight: insight
  };
}

export function calculateLearningAdjustment(learning = {}) {
  const strategy = learning.strategy || {};
  const market = learning.marketTimeframe || {};
  const factorPenalty = Math.max(-2, Math.min(0, Number(learning.factorPenalty || 0)));
  let adjustment = factorPenalty;

  if (Number(strategy.sampleSize || 0) >= 20) {
    if (Number(strategy.winRate || 0) >= 58 && Number(strategy.avgR || 0) > 0.25) adjustment += 2;
    if (Number(strategy.winRate || 0) < 45 || Number(strategy.avgR || 0) < 0) adjustment -= 2;
  }
  if (Number(market.sampleSize || 0) >= 10) {
    if (Number(market.winRate || 0) >= 56 && Number(market.avgR || 0) > 0.2) adjustment += 1;
    if (Number(market.winRate || 0) < 42 || Number(market.avgR || 0) < -0.1) adjustment -= 1;
  }

  return Math.max(-3, Math.min(3, Math.round(adjustment)));
}

export function buildLearningInsight(learning = {}, adjustment = 0) {
  const sampleSize = Math.max(
    Number(learning.strategy?.sampleSize || 0),
    Number(learning.marketTimeframe?.sampleSize || 0)
  );

  if (sampleSize < 10) {
    return neutralInsight();
  }
  if (adjustment > 0) {
    return {
      mode: "positive",
      sampleSize,
      message: "Similar completed setups have shown constructive historical outcomes, so learning adds a small confidence calibration. This is not a prediction."
    };
  }
  if (adjustment < 0) {
    return {
      mode: "negative",
      sampleSize,
      message: "Similar completed setups have recently underperformed or expired often, so learning adds a small caution penalty."
    };
  }

  return {
    mode: "neutral",
    sampleSize,
    message: "Historical learning is available but does not justify changing this setup score."
  };
}

function withLearningInsight(signal, insight) {
  if (!signal) return signal;
  return {
    ...signal,
    indicators: {
      ...(signal.indicators || {}),
      learningApplied: true,
      learningAdjustment: 0,
      learningInsight: insight.message,
      learningMode: insight.mode,
      learningSampleSize: insight.sampleSize
    },
    learningInsight: insight
  };
}

function neutralInsight() {
  return {
    mode: "neutral",
    sampleSize: 0,
    message: "This market/timeframe has limited completed-signal history, so learning adjustment is neutral."
  };
}

function getEmaRelationship(indicators) {
  const ema20 = Number(indicators.ema20);
  const ema50 = Number(indicators.ema50);
  if (!Number.isFinite(ema20) || !Number.isFinite(ema50)) return "unknown";
  if (ema20 > ema50) return "ema20_above_ema50";
  if (ema20 < ema50) return "ema20_below_ema50";
  return "flat";
}

function getVolumeVsMa(signal, indicators) {
  const volume = Number(signal.latestCandle?.volume || indicators.volume || 0);
  const ma = Number(indicators.volumeMa20 || 0);
  if (!Number.isFinite(volume) || !Number.isFinite(ma) || ma <= 0) return null;
  return Number((volume / ma).toFixed(3));
}

function getSmcFactor(signal, name) {
  const factor = (signal.smc?.factors || signal.indicators?.smcFactors || [])
    .find((item) => String(item.name || "").toLowerCase().includes(name.toLowerCase().split(" ")[0]));
  if (!factor) return "not_active";
  return factor.passed ? "confirmed" : "present_not_confirmed";
}

function confidenceBand(confidence) {
  const score = Number(confidence || 0);
  if (score >= 95) return "Elite";
  if (score >= 90) return "Excellent";
  if (score >= 80) return "Strong";
  if (score >= 70) return "Good";
  return "No signal";
}

function slug(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
