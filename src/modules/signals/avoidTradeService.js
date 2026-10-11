import { appConfig } from "../../config/appConfig.js";

const AVOID_REASON_RULES = [
  {
    match: /poor[_ ]?rr|risk.?reward|reward.?risk/,
    reason: "Risk/reward is not strong enough for a clean setup.",
    improvement: "Wait for a better entry or more room to the next target."
  },
  {
    match: /trend conflict|weak trend|trend.*unclear|countertrend/,
    reason: "Trend direction is unclear or conflicts with the higher timeframe.",
    improvement: "Wait for trend and higher-timeframe structure to agree."
  },
  {
    match: /volume/,
    reason: "Volume is below average, so the move is not confirmed yet.",
    improvement: "Wait for volume to strengthen above its recent average."
  },
  {
    match: /low volatility|low[_ ]?vol|atr.*low/,
    reason: "Volatility is too low for a clean move.",
    improvement: "Wait for volatility and candle ranges to expand."
  },
  {
    match: /high volatility|volatility spike|atr.*high/,
    reason: "Volatility is unusually high, making entry and stop placement unreliable.",
    improvement: "Wait for volatility to settle before reassessing the setup."
  },
  {
    match: /resistance/,
    reason: "Price is too close to resistance for a clean long setup.",
    improvement: "Wait for a confirmed break and retest or a cleaner pullback."
  },
  {
    match: /support/,
    reason: "Price is too close to support for a clean short setup.",
    improvement: "Wait for a confirmed breakdown and retest or more target room."
  },
  {
    match: /overextended|already moved|too late|chasing|far from.*entry/,
    reason: "The recent move is already extended, so entering now would chase price.",
    improvement: "Wait for price to pull back into a cleaner entry area."
  },
  {
    match: /candle confirmation|candle.*missing/,
    reason: "Candle confirmation is missing.",
    improvement: "Wait for a stronger directional candle close."
  },
  {
    match: /stop.*tight/,
    reason: "The stop loss would be too tight for current volatility.",
    improvement: "Wait for structure and volatility to support a safer stop distance."
  },
  {
    match: /target.*realistic|target.*far/,
    reason: "The available take-profit target is not realistic from this entry.",
    improvement: "Wait for a setup with a reachable target and better structure."
  },
  {
    match: /stale|outdated|last candle/,
    reason: "Market data is stale, so current conditions cannot be verified.",
    improvement: "Wait for fresh provider data before considering a setup."
  },
  {
    match: /choppy|range|no clean structure|strategy not matched|weak confirmation|confluence/,
    reason: "Market structure is choppy and confirmations do not align.",
    improvement: "Wait for cleaner structure and stronger confirmation."
  },
  {
    match: /momentum/,
    reason: "Momentum is fading and does not confirm continuation.",
    improvement: "Wait for momentum to rebuild with a decisive close."
  }
];

const REJECT_ONLY_CODES = new Set([
  "provider_unavailable",
  "provider_rate_limit",
  "unsupported_market",
  "unsupported_timeframe",
  "invalid_market_data"
]);

export const SCANNER_RESULT_TYPES = Object.freeze({
  READY: "ready_signal",
  WATCHING: "watching_setup",
  AVOID: "avoid_trade",
  REJECTED: "rejected_setup",
  EXPIRED: "expired_setup"
});

export function classifyScannerResult({ valid, candidate, analysis = {}, providerError = false }) {
  if (valid) return SCANNER_RESULT_TYPES.READY;
  if (["watching", "almost_ready", "ready"].includes(candidate?.status)) return SCANNER_RESULT_TYPES.WATCHING;
  if (candidate?.status === "expired") return SCANNER_RESULT_TYPES.EXPIRED;

  const codes = (analysis.rejectionReasonCodes || []).map(normalizeCode);
  if (providerError && codes.some((code) => REJECT_ONLY_CODES.has(code))) {
    return SCANNER_RESULT_TYPES.REJECTED;
  }
  return SCANNER_RESULT_TYPES.AVOID;
}

// Publication gates (liquidity floor, admin-disabled groups) are explained by their stage and structured details,
// never by keyword rules on their internal reason text: "24h volume" in a liquidity reason is not a candle-volume
// problem. Returns null for every other stage.
export function gateGuidance(rejected = {}) {
  const stage = normalizeCode(rejected?.stage);
  if (stage === "liquidity_floor") {
    const floorUsd = Number(rejected.floorUsd ?? appConfig.cryptoMarkets.minVolume24hUsd);
    return {
      stage,
      reason: `This market trades less than ${formatDollars(floorUsd)} per day. SignalForge doesn't generate signals on thin markets.`,
      improvement: "Scan a more actively traded market.",
      marketCondition: "Low liquidity"
    };
  }
  if (stage === "admin_disabled") {
    const shortsPaused = rejected.groupKey === "direction:short";
    return {
      stage,
      reason: shortsPaused ? "Short setups are paused while we review their performance." : "This setup type is paused by SignalForge.",
      improvement: shortsPaused ? "Long setups are still scanned as usual." : "Other setup types are still scanned as usual.",
      marketCondition: "Paused by SignalForge"
    };
  }
  return null;
}

export function buildAvoidTradeResult({ symbol, timeframe, analysis = {}, candidate = null, now = new Date() }) {
  const resultType = classifyScannerResult({ valid: false, candidate, analysis });
  if (resultType !== SCANNER_RESULT_TYPES.AVOID) return null;

  const gates = (analysis.rejectedReasons || []).map(gateGuidance).filter(Boolean);
  if (gates.length) {
    return {
      resultType: SCANNER_RESULT_TYPES.AVOID,
      symbol,
      timeframe,
      label: "No Trade",
      reason: gates[0].reason,
      reasons: unique(gates.map((gate) => gate.reason)),
      improvements: unique(gates.map((gate) => gate.improvement)),
      marketCondition: gates[0].marketCondition,
      gateStage: gates[0].stage,
      setupQualityScore: finiteScore(candidate?.setupQualityScore ?? candidate?.candidateScore ?? analysis.qualityScore),
      entryReadinessScore: finiteScore(candidate?.entryReadinessScore ?? candidate?.readinessScore ?? analysis.readinessScore),
      patternContext: analysis.patternContext || candidate?.patternContext || null,
      createdAt: new Date(now).toISOString()
    };
  }

  const sourceReasons = [
    ...(analysis.rejectionReasons || []),
    ...(analysis.rejectionReasonCodes || []),
    analysis.rejectionSummary,
    analysis.message,
    candidate?.rejectionReason
  ].filter(Boolean);
  const patternContext = analysis.patternContext || candidate?.patternContext || null;
  if (patternContext?.category === "uncertain") {
    sourceReasons.unshift(`Unclear pattern: ${patternContext.label}.`);
  }
  const guidance = sourceReasons.map(toAvoidGuidance).filter(Boolean);
  const uniqueReasons = unique(guidance.map((item) => item.reason)).slice(0, 4);
  const improvements = unique(guidance.map((item) => item.improvement)).slice(0, 4);
  const reasons = uniqueReasons.length
    ? uniqueReasons
    : ["SignalForge does not see enough clean confirmation for a trade right now."];

  return {
    resultType: SCANNER_RESULT_TYPES.AVOID,
    symbol,
    timeframe,
    label: "No Trade",
    reason: reasons[0],
    reasons,
    improvements: improvements.length ? improvements : ["Wait for cleaner structure and stronger confirmation."],
    marketCondition: inferMarketCondition(sourceReasons.join(" ")),
    setupQualityScore: finiteScore(candidate?.setupQualityScore ?? candidate?.candidateScore ?? analysis.qualityScore),
    entryReadinessScore: finiteScore(candidate?.entryReadinessScore ?? candidate?.readinessScore ?? analysis.readinessScore),
    patternContext,
    createdAt: new Date(now).toISOString()
  };
}

export function toAvoidGuidance(value) {
  const normalized = String(value || "").replace(/[_-]+/g, " ").trim().toLowerCase();
  if (!normalized) return null;
  const matched = AVOID_REASON_RULES.find((rule) => rule.match.test(normalized));
  return matched || {
    reason: "The active confirmations do not form a clean setup right now.",
    improvement: "Wait for clearer trend, structure, and entry confirmation."
  };
}

function inferMarketCondition(text) {
  const value = String(text || "").toLowerCase();
  if (/choppy|range|structure/.test(value)) return "Choppy / unclear structure";
  if (/volatility|atr/.test(value)) return "Unsuitable volatility";
  if (/trend|timeframe|confluence/.test(value)) return "Conflicting trend context";
  if (/volume|momentum/.test(value)) return "Weak participation";
  if (/stale|provider/.test(value)) return "Data not current";
  return "Confirmations not aligned";
}

// 2000000 -> "$2M"; 2500000 -> "$2.5M"; otherwise whole dollars.
function formatDollars(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1e6 && number % 1e5 === 0) return `$${Number((number / 1e6).toFixed(1))}M`;
  return `$${Math.round(number).toLocaleString("en-US")}`;
}

function normalizeCode(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function finiteScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.min(100, Math.max(0, Math.round(score))) : 0;
}
