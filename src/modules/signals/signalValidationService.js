import { getPair } from "../market-data/marketDataService.js";

export const knownSignalStrategies = new Set([
  "Trend continuation",
  "Pullback bounce",
  "Breakout retest",
  "Range bounce",
  "Mean reversion",
  "Momentum breakout",
  "Liquidity sweep reversal",
  "Liquidity sweep",
  "VWAP reclaim/rejection",
  "VWAP Reclaim",
  "Support/resistance retest",
  "Support Retest",
  "Multi-timeframe continuation"
]);

const confidenceBands = [
  { minimum: 95, label: "Elite" },
  { minimum: 90, label: "Excellent" },
  { minimum: 80, label: "Strong" },
  { minimum: 70, label: "Good" }
];

export async function validateSignalPipeline(signal, context = {}) {
  const rejected = [];
  const marketData = context.marketData || null;
  const pair = marketData?.pair || getPair(signal?.symbol) || {};
  const latest = marketData?.candles?.[marketData.candles.length - 1] || null;
  const atr = Number(signal?.indicators?.atr14 ?? marketData?.regime?.metrics?.atr14);
  const strategy = signal?.setupType || signal?.strategy || "";

  addMarketDataRejections(rejected, signal, marketData, latest, atr, pair);
  addPriceRejections(rejected, signal);
  addRiskRewardRejections(rejected, signal);
  addCurrentPriceRejections(rejected, signal, latest, atr);
  addConfidenceRejections(rejected, signal);
  addStrategyRejections(rejected, signal, strategy);
  await addDuplicateRejections(rejected, signal, context);
  addSessionRejections(rejected, signal, marketData, pair);
  addSanityRejections(rejected, signal, atr);

  const validationScore = calculateValidationScore(signal, rejected, marketData);
  const passed = rejected.length === 0;
  const result = {
    passed,
    validationScore,
    confidenceBand: getConfidenceBand(signal?.confidenceScore),
    rejectedReasons: rejected,
    validatedAt: new Date().toISOString()
  };

  if (!passed && context.recordRejection !== false && typeof context.recordValidationRejection === "function") {
    await context.recordValidationRejection(toValidationRejectionRecord(signal, result, context));
  }

  return result;
}

export function applyValidationToSignal(signal, validation) {
  if (!signal || !validation?.passed) return signal;
  return {
    ...signal,
    validationPassed: true,
    validationScore: validation.validationScore,
    confidenceBand: validation.confidenceBand,
    rejectedReasons: [],
    validation: {
      passed: true,
      score: validation.validationScore,
      confidenceBand: validation.confidenceBand,
      validatedAt: validation.validatedAt
    },
    indicators: {
      ...(signal.indicators || {}),
      validationPassed: true,
      validationScore: validation.validationScore,
      validationConfidenceBand: validation.confidenceBand,
      validationRejectedReasons: []
    }
  };
}

export function validationNoSetupAnalysis(signal, validation) {
  const topReasons = validation.rejectedReasons.map((item) => item.reason);
  return {
    symbol: signal?.symbol,
    timeframe: signal?.timeframe,
    message: "Signal rejected by final validation.",
    validationPassed: false,
    validationScore: validation.validationScore,
    rejectedReasons: validation.rejectedReasons,
    rejectionReasons: topReasons,
    rejectionReasonCodes: validation.rejectedReasons.map((item) => item.stage),
    rejectionSummary: topReasons.length
      ? `No setup found because: ${topReasons.slice(0, 4).join(", ")}.`
      : "No setup found because: final validation failed.",
    evaluatedAt: validation.validatedAt
  };
}

export function getConfidenceBand(confidenceScore) {
  const confidence = Number(confidenceScore || 0);
  return confidenceBands.find((band) => confidence >= band.minimum)?.label || "No signal";
}

function addMarketDataRejections(rejected, signal, marketData, latest, atr, pair) {
  if (!marketData) {
    reject(rejected, "market_data", "Market data unavailable.", signal);
    return;
  }

  const marketStatus = marketData.marketStatus || {};
  if (marketStatus.code === "PROVIDER_ISSUE" || pair.status !== "active") {
    reject(rejected, "market_data", "Provider unavailable.", signal);
  }
  if (marketStatus.stale || marketStatus.code === "DELAYED") {
    reject(rejected, "market_data", "Latest candle is stale.", signal);
  }
  if (!latest || ["open", "high", "low", "close"].some((key) => !isFinitePositive(latest[key]))) {
    reject(rejected, "market_data", "Missing OHLC values.", signal);
  }
  if (!Number.isFinite(atr) || atr <= 0) {
    reject(rejected, "market_data", "ATR unavailable.", signal);
  }
  const volumeRequired = pair.category === "Crypto" || pair.assetClass === "Crypto";
  if (volumeRequired && (!Number.isFinite(Number(latest?.volume)) || Number(latest?.volume) <= 0)) {
    reject(rejected, "market_data", "Invalid volume data.", signal);
  }
}

function addPriceRejections(rejected, signal) {
  const direction = String(signal?.direction || "").toLowerCase();
  const entry = Number(signal?.entryPrice);
  const takeProfit = Number(signal?.takeProfit);
  const stopLoss = Number(signal?.stopLoss);

  if (direction === "long" && !(entry < takeProfit && entry > stopLoss)) {
    reject(rejected, "price", "LONG requires Entry < TP and Entry > SL.", signal);
  }
  if (direction === "short" && !(entry > takeProfit && entry < stopLoss)) {
    reject(rejected, "price", "SHORT requires Entry > TP and Entry < SL.", signal);
  }
  if (!["long", "short"].includes(direction)) {
    reject(rejected, "price", "Signal direction is invalid.", signal);
  }
}

function addRiskRewardRejections(rejected, signal) {
  const riskReward = Number(signal?.riskRewardRatio);
  if (!Number.isFinite(riskReward) || riskReward < 1.5) {
    reject(rejected, "risk_reward", "Risk/reward is below 1.5R.", signal);
  }
}

function addCurrentPriceRejections(rejected, signal, latest, atr) {
  if (!latest || !Number.isFinite(atr) || atr <= 0) return;
  const direction = String(signal?.direction || "").toLowerCase();
  const current = Number(latest.close);
  const entry = Number(signal?.entryPrice);
  const takeProfit = Number(signal?.takeProfit);
  const stopLoss = Number(signal?.stopLoss);
  const tolerance = atr * 0.25;

  if (Math.abs(current - entry) > tolerance) {
    reject(rejected, "current_price", "Current price moved too far from intended entry.", signal);
  }
  if (direction === "long" && (current >= takeProfit || current <= stopLoss)) {
    reject(rejected, "current_price", "Current price has already crossed TP or SL.", signal);
  }
  if (direction === "short" && (current <= takeProfit || current >= stopLoss)) {
    reject(rejected, "current_price", "Current price has already crossed TP or SL.", signal);
  }
}

function addConfidenceRejections(rejected, signal) {
  const confidence = Number(signal?.confidenceScore);
  if (!Number.isFinite(confidence) || confidence < 70) {
    reject(rejected, "confidence", "Confidence is below 70.", signal);
  }
  if (confidence > 99) {
    reject(rejected, "confidence", "Confidence cannot exceed 99.", signal);
  }
}

function addStrategyRejections(rejected, signal, strategy) {
  if (!strategy || !knownSignalStrategies.has(strategy)) {
    reject(rejected, "strategy", "Signal strategy is missing or unknown.", signal);
  }
}

async function addDuplicateRejections(rejected, signal, context) {
  if (!context.userId || typeof context.findActiveDuplicateSignal !== "function") return;
  const duplicate = await context.findActiveDuplicateSignal(context.userId, signal);
  if (duplicate) {
    reject(rejected, "duplicate", "Matching active signal already exists for this user.", signal);
  }
}

function addSessionRejections(rejected, signal, marketData, pair) {
  const status = marketData?.marketStatus || {};
  const newsRisk = signal?.newsRisk || {};
  const indicators = signal?.indicators || {};
  const regime = marketData?.regime || {};

  if (pair.category !== "Crypto" && status.code === "CLOSED") {
    reject(rejected, "session", "Market is closed.", signal);
  }
  if (status.code === "PROVIDER_ISSUE") {
    reject(rejected, "session", "Provider unavailable.", signal);
  }
  if (newsRisk.blockSignal || indicators.newsRiskBlocked || indicators.newsRiskLevel === "Danger") {
    reject(rejected, "session", "News lock is active.", signal);
  }
  if (regime.atrPass === false || regime.label === "Low Volatility") {
    reject(rejected, "session", "Volatility is below minimum.", signal);
  }
}

function addSanityRejections(rejected, signal, atr) {
  const values = [
    ["entry", signal?.entryPrice],
    ["stop", signal?.stopLoss],
    ["target", signal?.takeProfit],
    ["risk/reward", signal?.riskRewardRatio],
    ["confidence", signal?.confidenceScore],
    ["ATR", atr]
  ];

  for (const [label, value] of values) {
    if (!Number.isFinite(Number(value))) {
      reject(rejected, "sanity", `${label} is NaN or Infinity.`, signal);
    }
  }

  if (Number(atr) < 0) {
    reject(rejected, "sanity", "ATR is negative.", signal);
  }

  const stopDistance = Math.abs(Number(signal?.entryPrice) - Number(signal?.stopLoss));
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    reject(rejected, "sanity", "Stop distance is zero or invalid.", signal);
  }

  if (Number(signal?.riskRewardRatio) < 0) {
    reject(rejected, "sanity", "Risk/reward is negative.", signal);
  }
}

function calculateValidationScore(signal, rejected, marketData) {
  let score = 100;
  const confirmations = signal?.confirmations || [];
  const failed = confirmations.filter((item) => !item.passed);

  for (const item of failed) {
    const name = String(item.name || "").toLowerCase();
    if (name.includes("rsi")) score -= 4;
    else if (name.includes("volume")) score -= 3;
    else if (name.includes("atr")) score -= 2;
    else if (name.includes("confluence") || name.includes("timeframe")) score -= 5;
    else score -= 2;
  }

  if (signal?.alignmentBadge === "Partial Alignment") score -= 5;
  if (Number(signal?.riskRewardRatio || 0) < 2) score -= 6;
  if (marketData?.regime?.label === "Low Volatility") score -= 2;
  score -= rejected.length * 12;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function toValidationRejectionRecord(signal, validation, context) {
  return {
    userId: context.userId || null,
    setupKey: signal?.setupKey || signal?.id || null,
    symbol: signal?.symbol || "unknown",
    timeframe: signal?.timeframe || "unknown",
    direction: signal?.direction || null,
    strategy: signal?.setupType || signal?.strategy || "unknown",
    validationScore: validation.validationScore,
    confidenceScore: Number(signal?.confidenceScore || 0),
    riskRewardRatio: Number(signal?.riskRewardRatio || 0),
    reasons: validation.rejectedReasons,
    source: context.source || "unknown"
  };
}

function reject(rejected, stage, reason, signal) {
  rejected.push({
    stage,
    reason,
    timestamp: new Date().toISOString(),
    market: signal?.symbol || "unknown",
    strategy: signal?.setupType || signal?.strategy || "unknown"
  });
}

function isFinitePositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}
