import { getTimeframeQualityPolicy } from "./generatedSignalQualityGate.js";

const USER_REASON_LABELS = {
  trend_conflict: "Higher-timeframe trend is conflicting.",
  weak_confirmation: "Confirmation is still too weak.",
  poor_rr: "Risk/reward is not strong enough.",
  low_volatility: "Volatility is too low for a clean setup.",
  too_close_to_support_resistance: "Price is too close to support or resistance.",
  failed_volume_filter: "Volume confirmation is missing.",
  failed_confluence_threshold: "Confluence is below the required threshold.",
  news_session_blocked: "Session or news risk is blocking the setup.",
  strategy_not_matched: "No approved strategy matched cleanly.",
  entry_not_ready: "Entry is not ready yet.",
  readiness_pending: "SignalForge is waiting for better entry readiness.",
  strategy_strictness: "The named strategy did not pass strict validation.",
  generated_quality: "The final quality gate blocked this setup.",
  generated_quality_calibration: "Historical calibration blocked this setup.",
  quarantined_timeframe: "This timeframe is currently quarantined from ready signals.",
  cooldown_blocked: "A similar recent signal is cooling down after a poor result.",
  duplicate_blocked: "A similar active signal already exists.",
  correlated_duplicate: "A nearby timeframe already has a correlated setup.",
  poor_entry_quality: "Entry quality is not clean enough.",
  weak_strategy_match: "The strategy match is too weak.",
  bad_market_regime: "The strategy does not fit the current market condition.",
  invalid_stop_loss: "Stop loss placement is not structurally valid.",
  unrealistic_take_profit: "Take profit is not realistic for current structure.",
  weak_risk_reward: "Risk/reward quality is weak.",
  similar_to_past_losers: "This setup looks too similar to past losing examples.",
  historical_underperformer: "This strategy group has underperformed historically."
};

export function buildWhyNoSignalReport({
  symbol,
  timeframe,
  marketData = null,
  generatorResult = null,
  analysis = null,
  readiness = null,
  candidate = null,
  strictness = null,
  validation = null,
  qualityGate = null,
  calibrationBlocked = false,
  qualityBlocked = false,
  publishable = false,
  admin = false
} = {}) {
  if (publishable) return null;

  const reportAnalysis = analysis || generatorResult?.analysis || {};
  const policy = getTimeframeQualityPolicy(timeframe);
  const detector = detectFailedBreakoutMomentumExhaustion(marketData?.candles || [], { symbol, timeframe });
  const reasonItems = collectReasonItems({
    analysis: reportAnalysis,
    readiness,
    strictness,
    validation,
    qualityGate,
    calibrationBlocked,
    qualityBlocked,
    timeframePolicy: policy
  });
  const possibleSetups = buildPossibleSetups({
    analysis: reportAnalysis,
    candidate,
    detector,
    qualityGate,
    strictness,
    readiness,
    timeframePolicy: policy
  });
  const topReasons = reasonItems.slice(0, 6);

  return {
    available: true,
    symbol: symbol || reportAnalysis.symbol,
    timeframe: timeframe || reportAnalysis.timeframe,
    title: topReasons.length ? "Why no signal?" : "No clean signal yet.",
    summary: topReasons.length
      ? `No setup found because: ${topReasons.slice(0, 3).map((item) => item.label).join(" ")}`
      : reportAnalysis.message || "SignalForge did not find a clean rule-based setup right now.",
    reasons: topReasons,
    possibleSetups,
    whatToImprove: deriveImprovements(topReasons, possibleSetups, detector),
    educationalCopy: "No signal can be a useful result. SignalForge filters out weak setups instead of forcing trades.",
    admin: admin ? buildAdminMissedSetupDebug({
      reportAnalysis,
      readiness,
      candidate,
      strictness,
      validation,
      qualityGate,
      calibrationBlocked,
      qualityBlocked,
      detector,
      timeframePolicy: policy
    }) : null
  };
}

export function detectFailedBreakoutMomentumExhaustion(candles = [], { symbol = null, timeframe = null } = {}) {
  const clean = candles
    .filter((candle) => ["open", "high", "low", "close"].every((key) => Number.isFinite(Number(candle[key]))))
    .map((candle) => ({
      ...candle,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume || 0)
    }));
  if (clean.length < 30) return null;

  const latest = clean[clean.length - 1];
  const recent = clean.slice(-7, -1);
  const prior = clean.slice(-34, -7);
  if (prior.length < 12 || recent.length < 3) return null;

  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const priorLow = Math.min(...prior.map((candle) => candle.low));
  const recentBreakAbove = recent.find((candle) => candle.close > priorHigh);
  const recentBreakBelow = recent.find((candle) => candle.close < priorLow);
  const atr = averageTrueRange(clean.slice(-18));
  const volumeMa = average(clean.slice(-24, -4).map((candle) => candle.volume));
  const volumeFaded = Number.isFinite(volumeMa) && volumeMa > 0 && latest.volume < volumeMa * 0.9;

  if (recentBreakAbove && latest.close < priorHigh && latest.close < latest.open) {
    const distance = Math.abs(latest.close - priorHigh);
    const late = Number.isFinite(atr) && atr > 0 && distance > atr * 1.05;
    return {
      status: late ? "rejected" : "watching",
      direction: "short",
      attemptedStrategy: "Failed breakout / momentum exhaustion",
      reasonCode: late ? "late_entry" : "failed_breakout_watch",
      reason: late
        ? "The failed breakout already moved too far from the broken level, so entry would be late."
        : "A bullish breakout failed back below resistance, but SignalForge needs retest or continuation confirmation.",
      confidenceEstimate: late ? 58 : 66,
      rawScore: late ? 61 : 69,
      calibratedConfidence: late ? 54 : 63,
      keyLevel: round(priorHigh),
      blockers: [
        late ? "Entry is chasing after the failed breakout." : "Retest confirmation is still missing.",
        volumeFaded ? "Volume faded after the breakout attempt." : "Volume confirmation is not strong enough yet.",
        "The setup must still pass the final quality gate before becoming a signal."
      ],
      whatToImprove: [
        "Retest the broken level without reclaiming it.",
        "Show stronger reversal candle confirmation.",
        "Keep risk/reward above the minimum after stop and target validation."
      ],
      symbol,
      timeframe
    };
  }

  if (recentBreakBelow && latest.close > priorLow && latest.close > latest.open) {
    const distance = Math.abs(latest.close - priorLow);
    const late = Number.isFinite(atr) && atr > 0 && distance > atr * 1.05;
    return {
      status: late ? "rejected" : "watching",
      direction: "long",
      attemptedStrategy: "Failed breakout / momentum exhaustion",
      reasonCode: late ? "late_entry" : "failed_breakout_watch",
      reason: late
        ? "The failed breakdown already moved too far from the broken level, so entry would be late."
        : "A bearish breakdown failed back above support, but SignalForge needs retest or continuation confirmation.",
      confidenceEstimate: late ? 58 : 66,
      rawScore: late ? 61 : 69,
      calibratedConfidence: late ? 54 : 63,
      keyLevel: round(priorLow),
      blockers: [
        late ? "Entry is chasing after the failed breakdown." : "Retest confirmation is still missing.",
        volumeFaded ? "Volume faded after the breakdown attempt." : "Volume confirmation is not strong enough yet.",
        "The setup must still pass the final quality gate before becoming a signal."
      ],
      whatToImprove: [
        "Retest the broken level without losing it again.",
        "Show stronger reversal candle confirmation.",
        "Keep risk/reward above the minimum after stop and target validation."
      ],
      symbol,
      timeframe
    };
  }

  return null;
}

function collectReasonItems({
  analysis = {},
  readiness = null,
  strictness = null,
  validation = null,
  qualityGate = null,
  calibrationBlocked = false,
  qualityBlocked = false,
  timeframePolicy = null
}) {
  const items = [];
  const add = (code, label, source = "scanner") => {
    const cleanCode = normalizeCode(code || label);
    const cleanLabel = humanizeReason(cleanCode, label);
    if (!cleanLabel || items.some((item) => item.code === cleanCode || item.label === cleanLabel)) return;
    items.push({ code: cleanCode, label: cleanLabel, source });
  };

  for (const code of analysis.rejectionReasonCodes || []) add(code, null, "scanner");
  for (const reason of analysis.rejectionReasons || []) add(reason, reason, "scanner");
  for (const reason of readiness?.reasons || []) add(reason, reason, "readiness");
  if (readiness?.entryQuality === "fair") add("entry_not_ready", "Entry is only fair right now, so SignalForge is waiting.", "readiness");
  if (readiness?.entryQuality === "poor") add("poor_entry_quality", "Entry quality is poor.", "readiness");
  if (strictness?.passed === false) add(strictness.code || strictness.status, strictness.reason, "strategy");
  for (const rejected of validation?.rejectedReasons || []) add(rejected.stage, rejected.reason, "validation");
  if (calibrationBlocked) add("historical_underperformer", "Historical calibration blocked this setup.", "calibration");
  if (qualityBlocked && qualityGate?.reason) add(qualityGate.reasonCode || qualityGate.status || qualityGate.type, qualityGate.reason, "quality_gate");
  if (timeframePolicy?.status === "quarantined") add("quarantined_timeframe", timeframePolicy.reason, "timeframe_policy");
  return items.length ? items : [{ code: "strategy_not_matched", label: USER_REASON_LABELS.strategy_not_matched, source: "scanner" }];
}

function buildPossibleSetups({ analysis = {}, candidate = null, detector = null, qualityGate = null, strictness = null, readiness = null, timeframePolicy = null }) {
  const rows = [];
  const candidates = Array.isArray(analysis.candidates) ? analysis.candidates : [];
  for (const item of candidates) {
    const failedConfirmations = (item.confirmations || []).filter((confirmation) => !confirmation.passed);
    const passedConfirmations = (item.confirmations || []).filter((confirmation) => confirmation.passed);
    const quality = Number(item.qualityScore || 0);
    rows.push({
      resultType: quality >= 62 ? "watching_setup" : "no_setup",
      direction: item.direction,
      attemptedStrategy: item.setupType || "Strategy not matched",
      status: quality >= 62 ? "watching" : "rejected",
      confidenceEstimate: Math.max(0, Math.min(69, Math.round(quality - failedConfirmations.length * 2))),
      rawScore: quality,
      calibratedConfidence: Math.max(0, Math.min(69, Math.round(quality - failedConfirmations.length * 3))),
      reason: item.rejectionReasons?.[0] || (failedConfirmations[0]?.reason) || "Required confirmations did not align.",
      whatToImprove: failedConfirmations.slice(0, 3).map((confirmation) => confirmation.reason || `${confirmation.name} must improve.`),
      passedRules: passedConfirmations.map((confirmation) => confirmation.name),
      failedRules: failedConfirmations.map((confirmation) => confirmation.name),
      marketRegime: item.regime?.label || item.indicators?.regime || null
    });
  }

  if (candidate) {
    rows.unshift({
      resultType: candidate.resultType || "watching_setup",
      direction: candidate.direction,
      attemptedStrategy: candidate.setupType,
      status: candidate.status || "watching",
      confidenceEstimate: candidate.confidenceEstimate ?? candidate.candidateScore ?? null,
      rawScore: candidate.setupQualityScore ?? candidate.candidateScore ?? null,
      calibratedConfidence: candidate.confidenceEstimate ?? null,
      reason: candidate.rejectionReason || candidate.reasonsForWatching?.[0] || "SignalForge is waiting for better confirmation.",
      whatToImprove: candidate.nextConditions || candidate.missingConfirmations || [],
      passedRules: [],
      failedRules: candidate.missingConfirmations || []
    });
  }

  if (detector) {
    rows.unshift({
      resultType: "watching_setup",
      direction: detector.direction,
      attemptedStrategy: detector.attemptedStrategy,
      status: detector.status,
      confidenceEstimate: detector.confidenceEstimate,
      rawScore: detector.rawScore,
      calibratedConfidence: detector.calibratedConfidence,
      reason: detector.reason,
      whatToImprove: detector.whatToImprove,
      passedRules: ["Failed breakout detected"],
      failedRules: detector.blockers,
      keyLevel: detector.keyLevel
    });
  }

  if (qualityGate?.passed === false) {
    rows.unshift({
      resultType: "blocked",
      direction: null,
      attemptedStrategy: "Final Quality Gate",
      status: qualityGate.reasonCode || qualityGate.status || "quality_gate_rejected",
      confidenceEstimate: null,
      rawScore: null,
      calibratedConfidence: null,
      reason: qualityGate.reason || "Quality gate blocked this setup.",
      whatToImprove: qualityGate.details?.qualityGateV2?.improvements || [],
      passedRules: [],
      failedRules: [qualityGate.reasonCode || qualityGate.status || "quality_gate"]
    });
  }

  if (strictness?.passed === false) {
    rows.unshift({
      resultType: "rejected_setup",
      direction: null,
      attemptedStrategy: "Strict strategy validation",
      status: strictness.status || "strategy_misread_rejected",
      confidenceEstimate: null,
      rawScore: null,
      calibratedConfidence: null,
      reason: strictness.reason,
      whatToImprove: ["Wait for the strategy to meet its required structure before promoting it."],
      passedRules: [],
      failedRules: [strictness.code || strictness.status || "strategy_strictness"]
    });
  }

  if (timeframePolicy?.status === "quarantined") {
    rows.unshift({
      resultType: "blocked",
      direction: null,
      attemptedStrategy: "Timeframe policy",
      status: "quarantined_timeframe",
      confidenceEstimate: timeframePolicy.confidenceCap,
      rawScore: null,
      calibratedConfidence: timeframePolicy.confidenceCap,
      reason: timeframePolicy.reason,
      whatToImprove: ["Use this timeframe for context until current-engine results improve."],
      passedRules: [],
      failedRules: ["timeframe_quarantine"]
    });
  }

  if (readiness?.ready === false && !rows.length) {
    rows.push({
      resultType: "watching_setup",
      direction: null,
      attemptedStrategy: "Entry readiness",
      status: readiness.rejected ? "rejected" : "watching",
      confidenceEstimate: readiness.readinessScore ?? null,
      rawScore: readiness.readinessScore ?? null,
      calibratedConfidence: readiness.readinessScore ?? null,
      reason: readiness.reasons?.[0] || "Entry is not ready yet.",
      whatToImprove: readiness.reasons || [],
      passedRules: [],
      failedRules: readiness.reasons || []
    });
  }

  return rows.slice(0, 6);
}

function deriveImprovements(reasons, possibleSetups, detector) {
  const improvements = [];
  for (const setup of possibleSetups || []) {
    for (const item of setup.whatToImprove || []) {
      if (item && !improvements.includes(item)) improvements.push(item);
    }
  }
  for (const reason of reasons || []) {
    if (reason.code.includes("volume")) improvements.push("Wait for stronger volume confirmation.");
    if (reason.code.includes("rr") || reason.code.includes("reward")) improvements.push("Wait for cleaner room to target and stronger risk/reward.");
    if (reason.code.includes("entry")) improvements.push("Wait for price to return closer to the trigger or retest level.");
    if (reason.code.includes("trend") || reason.code.includes("regime")) improvements.push("Wait for trend and market regime to align with the setup.");
  }
  for (const item of detector?.whatToImprove || []) improvements.push(item);
  return [...new Set(improvements)].slice(0, 5);
}

function buildAdminMissedSetupDebug({
  reportAnalysis,
  readiness,
  candidate,
  strictness,
  validation,
  qualityGate,
  calibrationBlocked,
  qualityBlocked,
  detector,
  timeframePolicy
}) {
  return {
    candidateSource: candidate?.id ? "setup_candidate" : detector ? "failed_breakout_detector" : "scanner_analysis",
    candidateId: candidate?.id || null,
    attemptedStrategies: [
      ...(reportAnalysis.candidates || []).map((item) => item.setupType).filter(Boolean),
      detector?.attemptedStrategy
    ].filter(Boolean),
    rawScore: candidate?.setupQualityScore ?? reportAnalysis.qualityScore ?? detector?.rawScore ?? null,
    calibratedConfidence: detector?.calibratedConfidence ?? candidate?.confidenceEstimate ?? null,
    setupQualityScore: candidate?.setupQualityScore ?? null,
    entryReadinessScore: candidate?.entryReadinessScore ?? readiness?.readinessScore ?? null,
    qualityGate: qualityGate || null,
    strictness: strictness || null,
    validation: validation || null,
    calibrationBlocked,
    qualityBlocked,
    timeframePolicy,
    telegramDecision: qualityGate?.passed === false ? "blocked_not_alertable" : "not_evaluated",
    finalDecision: qualityGate?.passed === false
      ? qualityGate.reasonCode || qualityGate.status || "quality_gate_blocked"
      : strictness?.passed === false
        ? strictness.status
        : readiness?.ready === false
          ? "watching"
          : "no_ready_signal"
  };
}

function humanizeReason(code, fallback) {
  const normalized = normalizeCode(code);
  if (USER_REASON_LABELS[normalized]) return USER_REASON_LABELS[normalized];
  if (fallback && !/^[a-z0-9_]+$/.test(String(fallback))) return String(fallback).trim();
  return titleCase(String(fallback || normalized || "No clean setup").replace(/_/g, " ")) + ".";
}

function normalizeCode(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function averageTrueRange(candles) {
  if (candles.length < 2) return null;
  const ranges = [];
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    ranges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close)
    ));
  }
  return average(ranges);
}

function round(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(numeric > 1000 ? 2 : 4));
}

function titleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}
