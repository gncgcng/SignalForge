import { query } from "../../db/client.js";
import { appConfig } from "../../config/appConfig.js";
import { recordSignalQualityGateResult } from "./signalQualityGateRepository.js";
import {
  evaluateSignalQualityGateV2,
  repairUnrealisticTakeProfit
} from "./signalQualityGateV2Service.js";

export const blockedGeneratedSignalStatuses = Object.freeze({
  duplicate: "Duplicate blocked",
  cooldown: "Cooldown blocked",
  correlated: "Correlated duplicate",
  timeframe: "Quarantined timeframe",
  readiness: "Readiness failed",
  weak_strategy_match: "Weak strategy match",
  poor_entry_quality: "Poor entry quality",
  invalid_stop_loss: "Invalid stop loss",
  unrealistic_take_profit: "Unrealistic take profit",
  weak_risk_reward: "Weak risk/reward",
  bad_market_regime: "Bad market regime",
  historical_underperformer: "Historical underperformer",
  insufficient_historical_data: "Insufficient historical data",
  historical_confidence_penalty: "Historical confidence penalty",
  calibration_error: "Calibration error",
  low_confidence: "Confidence below promotion minimum",
  similar_to_past_losers: "Similar to past losers"
});

const blockedGeneratedSignalReasonCodes = Object.freeze({
  duplicate: "duplicate_blocked",
  cooldown: "cooldown_blocked",
  correlated: "correlated_duplicate",
  timeframe: "quarantined_timeframe",
  readiness: "readiness_failed",
  weak_strategy_match: "weak_strategy_match",
  poor_entry_quality: "poor_entry_quality",
  invalid_stop_loss: "invalid_stop_loss",
  unrealistic_take_profit: "unrealistic_take_profit",
  weak_risk_reward: "weak_risk_reward",
  bad_market_regime: "bad_market_regime",
  historical_underperformer: "historical_underperformer",
  insufficient_historical_data: "insufficient_historical_data",
  historical_confidence_penalty: "historical_confidence_penalty",
  calibration_error: "calibration_error",
  low_confidence: "below_ready_confidence",
  similar_to_past_losers: "similar_to_past_losers"
});

const currentEngineSourceSql = "source NOT IN ('legacy_saved_signal','legacy_unlocked_signal')";
const timeframeOrder = ["5m", "15m", "1h", "4h"];
const timeframePolicies = Object.freeze({
  "5m": { status: "quarantined", confidenceCap: 72, reason: "5m generated signals are quarantined after weak realized performance." },
  "1h": { status: "watchlist", confidenceCap: 72, reason: "1h can produce ready signals only when the exact setup passes Quality Gate; confidence remains capped while performance is being rebuilt." },
  "15m": { status: "active", confidenceCap: 88, reason: "15m can remain active, but confidence is capped below 90 until stronger evidence develops." },
  "4h": { status: "promising", confidenceCap: 82, reason: "4h has low current-engine sample size, so confidence is capped instead of hard-blocked." }
});

export async function evaluateGeneratedSignalQualityGate(signal, context = {}) {
  if (!signal) return passGate();
  const readiness = Number(signal.readinessScore ?? signal.entryReadinessScore ?? signal.indicators?.readinessScore ?? signal.indicators?.entryReadinessScore ?? 0);
  if (!Number.isFinite(readiness) || readiness <= 0) {
    return recordAndReturn(signal, blockGate("readiness", "Readiness score is 0, so this setup cannot be promoted as a ready signal.", { readinessScore: readiness }), context);
  }

  const timeframePolicy = getTimeframeQualityPolicy(signal.timeframe);
  if (timeframePolicy.status === "quarantined") {
    return recordAndReturn(signal, blockGate("timeframe", timeframePolicy.reason, { timeframe: signal.timeframe, confidenceCap: timeframePolicy.confidenceCap }), context);
  }
  const signalWithTimeframeCap = applyTimeframeConfidencePolicy(signal);

  const initialV2Result = evaluateSignalQualityGateV2(signalWithTimeframeCap, {
    ...context,
    timeframePolicy
  });
  const stopAdjustedSignal = initialV2Result.adjustedSignal || signalWithTimeframeCap;
  const stopFailed = initialV2Result.checks?.some((check) =>
    check.stage === "stop_loss_quality" && check.passed === false
  );
  const fullyAdjustedSignal = stopFailed
    ? stopAdjustedSignal
    : repairUnrealisticTakeProfit(stopAdjustedSignal, context.marketData || {});
  const v2Result = fullyAdjustedSignal === stopAdjustedSignal
    ? initialV2Result
    : evaluateSignalQualityGateV2(fullyAdjustedSignal, {
      ...context,
      timeframePolicy
    });
  const adjustedSignal = v2Result.adjustedSignal || signalWithTimeframeCap;
  const { adjustedSignal: ignoredAdjustedSignal, ...v2 } = v2Result;
  if (!v2.passed) {
    const gate = attachAdjustedSignal(
      blockGate(v2.status, v2.explanation, { qualityGateV2: v2 }, v2),
      adjustedSignal
    );
    return recordAndReturn(adjustedSignal, gate, context);
  }

  const promotionConfidenceGate = evaluateReadyPromotionConfidence(adjustedSignal, v2);
  if (promotionConfidenceGate) {
    return recordAndReturn(
      adjustedSignal,
      attachAdjustedSignal(promotionConfidenceGate, adjustedSignal),
      context
    );
  }

  const cooldownDecision = await findRecentGeneratedSignalFailure(adjustedSignal, context.marketData || {});
  if (cooldownDecision?.blocked) {
    const gate = attachAdjustedSignal(
      blockGate(
        "cooldown",
        "Blocked by cooldown because a genuinely similar promoted signal recently closed with a loss.",
        cooldownDecision.details
      ),
      adjustedSignal
    );
    return recordAndReturn(adjustedSignal, gate, context);
  }

  const cooldownAdjustedSignal = cooldownDecision?.releasedEarly
    ? withCooldownDecisionDiagnostics(adjustedSignal, cooldownDecision.details)
    : adjustedSignal;
  const duplicateDecision = await findRecentGeneratedSignalDuplicate(cooldownAdjustedSignal);
  if (duplicateDecision?.blocked) {
    const duplicateType = duplicateDecision.matchType === "direct_duplicate" ? "duplicate" : "correlated";
    const gate = attachAdjustedSignal(
      blockGate(
        duplicateType,
        duplicateType === "duplicate"
          ? "A substantially identical active trade idea already exists."
          : "A stronger active setup already represents this correlated cross-timeframe trade idea.",
        duplicateDecision.details
      ),
      cooldownAdjustedSignal
    );
    return recordAndReturn(cooldownAdjustedSignal, gate, context);
  }

  const selectedSignal = duplicateDecision?.selectedCurrent
    ? withDuplicateSelectionDiagnostics(cooldownAdjustedSignal, duplicateDecision.details)
    : cooldownAdjustedSignal;
  await recordGateSafely(selectedSignal, v2, context);
  return attachAdjustedSignal(passGate({
    qualityGateV2: v2,
    duplicateSelection: duplicateDecision?.selectedCurrent ? duplicateDecision.details : null
  }), selectedSignal);
}

export function applyGeneratedSignalQualityBlock(signal, gate) {
  if (!signal || gate?.passed !== false) return signal;
  const status = gate.status || blockedGeneratedSignalStatuses.duplicate;
  const reason = gate.reason || "Generated signal blocked by quality gate.";
  return {
    ...signal,
    status,
    resultReason: reason,
    generatedQualityGate: gate,
    validationPassed: true,
    rejectedReasons: [
      ...(signal.rejectedReasons || []),
      { stage: gate.stage || "generated_quality", reason, timestamp: new Date().toISOString(), market: signal.symbol, strategy: signal.setupType }
    ],
    indicators: {
      ...(signal.indicators || {}),
      generatedQualityGate: gate,
      generatedQualityBlocked: true,
      generatedQualityBlockReason: reason,
      qualityGatePassed: false,
      qualityGateV2: gate.details?.qualityGateV2 || gate.qualityGateV2 || null
    }
  };
}

export function hasGeneratedSignalQualityGate(signal = {}) {
  return Boolean(
    signal.generatedQualityGate?.version ||
    signal.indicators?.generatedQualityGate?.version ||
    signal.indicators?.qualityGateV2?.version ||
    signal.qualityGateStatus ||
    signal.qualityGatePassed === true ||
    signal.indicators?.qualityGatePassed === true
  );
}

export function applyTimeframeConfidencePolicy(signal) {
  if (!signal) return signal;
  const policy = getTimeframeQualityPolicy(signal.timeframe);
  if (!policy.confidenceCap) return signal;
  const currentConfidence = resolveFinalCalibratedConfidence(signal);
  if (currentConfidence === null) return signal;
  const confidenceScore = Math.min(currentConfidence, policy.confidenceCap);
  return {
    ...signal,
    confidenceScore,
    calibratedConfidence: confidenceScore,
    finalCalibratedConfidence: confidenceScore,
    indicators: {
      ...(signal.indicators || {}),
      timeframeConfidenceCap: policy.confidenceCap,
      timeframeConfidenceCapReason: policy.reason
    }
  };
}

export function evaluateReadyPromotionConfidence(signal, qualityGateV2 = null) {
  const confidenceCalibration = signal?.confidenceCalibration || signal?.indicators?.confidenceCalibration || {};
  const historicalCalibration = signal?.indicators?.historicalStrategyCalibration || {};
  const calibrationError = confidenceCalibration.status === "calibration_error" ||
    historicalCalibration.status === "calibration_error";
  if (calibrationError) {
    const technicalError = historicalCalibration.technicalError || confidenceCalibration.technicalError || "Confidence calibration failed.";
    return blockGate(
      "calibration_error",
      "Confidence calibration failed, so this candidate remains admin-only.",
      {
        qualityGateV2,
        technicalError,
        confidenceCalibration,
        historicalCalibration
      },
      qualityGateV2
    );
  }

  const confidence = resolveFinalCalibratedConfidence(signal);
  if (confidence === null) {
    return blockGate(
      "calibration_error",
      "Final calibrated confidence is unavailable, so this candidate remains admin-only.",
      { qualityGateV2, technicalError: "No finite positive final calibrated confidence.", confidenceCalibration, historicalCalibration },
      qualityGateV2
    );
  }
  if (confidence >= 62) return null;

  const insufficient = ["insufficient_data", "needs_more_data"].includes(confidenceCalibration.status) ||
    ["insufficient_data", "needs_more_data"].includes(historicalCalibration.status);
  const historicalPenalty = Number(confidenceCalibration.totalPenalty || 0) < 0 ||
    Number(historicalCalibration.historicalCalibrationAdjustment ?? historicalCalibration.penalty ?? 0) < 0;
  const type = insufficient
    ? "insufficient_historical_data"
    : historicalPenalty
      ? "historical_confidence_penalty"
      : "low_confidence";
  const reason = insufficient
    ? `Final confidence ${Math.round(confidence)} is below the 62 ready-promotion minimum while historical calibration has insufficient data.`
    : historicalPenalty
      ? `Historical calibration reduced final confidence to ${Math.round(confidence)}, below the 62 ready-promotion minimum.`
      : `Final confidence ${Math.round(confidence)} is below the 62 ready-promotion minimum.`;
  return blockGate(
    type,
    reason,
    {
      qualityGateV2,
      confidence,
      minimumReadyConfidence: 62,
      strategyMatchScore: historicalCalibration.strategyMatchScore ?? confidenceCalibration.strategyMatchScore ?? null,
      confidenceCalibration,
      historicalCalibration
    },
    qualityGateV2
  );
}

export function resolveFinalCalibratedConfidence(signal = {}) {
  const historical = signal.indicators?.historicalStrategyCalibration || {};
  const calibration = signal.confidenceCalibration || signal.indicators?.confidenceCalibration || {};
  const values = [
    signal.finalCalibratedConfidence,
    signal.calibratedConfidence,
    signal.confidenceScore,
    historical.finalCalibratedConfidence,
    historical.calibratedConfidence,
    calibration.finalCalibratedConfidence,
    calibration.finalConfidence,
    calibration.calibratedConfidence
  ];
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.min(99, number);
  }
  return null;
}

export function getTimeframeQualityPolicy(timeframe) {
  return timeframePolicies[timeframe] || { status: "active", confidenceCap: null, reason: "" };
}

export function getFailureCooldownMs(timeframe, status = "Hit SL") {
  const configured = appConfig.signals.cooldownAfterSlHours || {};
  const hours = Number(configured[timeframe] ?? configured["15m"] ?? 6);
  const normalizedStatus = normalizeText(status);
  const multiplier = ["expired", "expired-after-entry"].includes(normalizedStatus)
    ? Number(appConfig.signals.cooldownAfterExpiredMultiplier ?? 0.5)
    : 1;
  return hours * multiplier * 60 * 60 * 1000;
}

export function isTradeCooldownEligibleRecord(row = {}) {
  const status = normalizeText(row.status);
  if (!["hit-sl", "expired", "manually-closed"].includes(status)) return false;

  const source = normalizeText(row.source);
  if (["legacy-saved-signal", "legacy-unlocked-signal", "backtest-shadow", "admin-test", "test", "debug"].includes(source)) {
    return false;
  }
  const sourceHistory = arrayValue(row.source_history ?? row.sourceHistory);
  const telegramStatus = normalizeText(row.telegram_status ?? row.telegramStatus);
  const userVisibility = normalizeText(row.user_visibility ?? row.userVisibility);
  const promoted = source === "manual-scan" ||
    sourceHistory.some((item) => normalizeText(item) === "manual-scan") ||
    telegramStatus === "sent" ||
    row.shownToUsers === true ||
    userVisibility === "user-ready";
  if (!promoted || userVisibility === "admin-only") return false;

  const gateStatus = normalizeText(row.quality_gate_status ?? row.qualityGateStatus);
  if (gateStatus && gateStatus !== "passed") return false;
  if (!hasValidTradeLevels(row)) return false;

  if (status === "expired") {
    return readExpirationClassification(row) === "expired-after-entry";
  }
  if (status === "manually-closed") {
    return hasMeaningfulRealizedLoss(row);
  }
  return true;
}

export function evaluateSignalTradeCooldown(signal, row, marketData = {}, options = {}) {
  const now = Number(options.now ?? Date.now());
  const base = {
    matchedSignalId: row?.signal_id || row?.signalId || row?.id || null,
    matchedCandidateId: row?.promoted_from_candidate_id || row?.promotedFromCandidateId || null,
    previousPair: row?.pair || row?.symbol || null,
    previousTimeframe: row?.timeframe || null,
    previousDirection: row?.direction || null,
    previousStrategy: row?.strategy || row?.setupType || null,
    previousOutcome: row?.status || null,
    previousSignalPromoted: isTradeCooldownEligibleRecord(row),
    previousTelegramSent: normalizeText(row?.telegram_status ?? row?.telegramStatus) === "sent",
    cooldownReleasedEarly: false,
    cooldownReleaseReason: null,
    previousStructureId: readStructureId(row),
    currentStructureId: readStructureId(signal),
    earlyReleaseAllowed: false,
    finalCooldownDecision: "not_applied"
  };
  if (!signal || !isTradeCooldownEligibleRecord(row)) {
    return noCooldown("prior_record_not_eligible", base);
  }

  const pair = normalizePair(signal.symbol || signal.pair);
  const previousPair = normalizePair(row.pair || row.symbol || row.display_pair);
  if (!pair || pair !== previousPair) return noCooldown("different_pair", base);
  if (String(signal.timeframe || "") !== String(row.timeframe || "")) {
    return releaseCooldown("different_timeframe", base);
  }

  const resolvedAt = readCooldownResolvedAt(row);
  const cooldownStatus = normalizeText(row.status) === "expired" ? "Expired" : "Hit SL";
  const durationMs = getFailureCooldownMs(signal.timeframe, cooldownStatus);
  const expiresAt = Number.isFinite(resolvedAt) ? resolvedAt + durationMs : null;
  const remainingMs = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : 0;
  const timed = {
    ...base,
    cooldownStartedAt: Number.isFinite(resolvedAt) ? new Date(resolvedAt).toISOString() : null,
    cooldownExpiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
    cooldownDurationMs: durationMs,
    remainingDurationMs: remainingMs,
    remainingDurationLabel: formatCooldownDuration(remainingMs)
  };
  if (!Number.isFinite(resolvedAt)) return noCooldown("missing_resolution_time", timed);
  if (remainingMs <= 0) return noCooldown("cooldown_expired", timed);

  const direction = normalizeText(signal.direction);
  const previousDirection = normalizeText(row.direction);
  if (!direction || direction !== previousDirection) {
    return releaseCooldown("direction_changed", timed);
  }

  const strategy = strategyFamily(signal.setupType || signal.strategy);
  const previousStrategy = strategyFamily(row.setupType || row.strategy);
  if (!strategy || !previousStrategy || strategy !== previousStrategy) {
    return releaseCooldown("strategy_family_changed", timed);
  }

  if (timed.previousStructureId && timed.currentStructureId &&
      timed.previousStructureId !== timed.currentStructureId) {
    return releaseCooldown("new_confirmed_structure", timed);
  }

  const atr = firstFinite(readAtr(signal), readAtr(row));
  const entrySimilarity = getEntryZoneSimilarity(
    signal.entryPrice ?? signal.entry,
    row.entryPrice ?? row.entry,
    atr,
    options
  );
  const triggerSimilarity = compareTriggerStructure(signal, row, atr, options);
  const pattern = patternFamily(readPattern(signal));
  const previousPattern = patternFamily(readPattern(row));
  const patternMatched = Boolean(pattern && previousPattern && pattern === previousPattern);
  const sameSetupKey = Boolean(signal.setupKey && (row.setup_key || row.setupKey) &&
    signal.setupKey === (row.setup_key || row.setupKey));
  const structureMatched = sameSetupKey || triggerSimilarity.matched ||
    (patternMatched && !triggerSimilarity.available && entrySimilarity.matched);
  const previousRegime = readCooldownRegime(row);
  const currentRegime = readCooldownRegime(signal, marketData);
  const regimeChanged = Boolean(previousRegime && currentRegime && previousRegime !== currentRegime);
  const candlesSinceFailure = countCandlesSince(marketData?.candles, resolvedAt);
  const structuralChanges = [
    !entrySimilarity.matched,
    triggerSimilarity.available && !triggerSimilarity.matched,
    regimeChanged,
    candlesSinceFailure >= 8
  ].filter(Boolean).length;
  const compared = {
    ...timed,
    entryDistancePercent: entrySimilarity.distancePercent,
    entryDistanceAtr: entrySimilarity.distanceAtr,
    entryMatchMethod: entrySimilarity.matchMethod,
    triggerMatchMethod: triggerSimilarity.matchMethod,
    structureSimilarity: structureMatched ? "same_trade_structure" : "different_trade_structure",
    previousRegime: previousRegime || null,
    currentRegime: currentRegime || null,
    candlesSinceFailure,
    exactMatchingRule: "same_pair_timeframe_direction_strategy_family_and_materially_similar_structure"
  };

  if (!structureMatched || structuralChanges >= 2) {
    const reason = regimeChanged && structuralChanges >= 2
      ? "market_regime_and_structure_changed"
      : "materially_new_trade_structure";
    return releaseCooldown(reason, compared);
  }

  return {
    matched: true,
    blocked: true,
    releasedEarly: false,
    reason: "similar_promoted_loss_within_cooldown",
    details: cooldownDiagnosticAliases({
      ...compared,
      earlyReleaseAllowed: true,
      finalCooldownDecision: "blocked"
    })
  };
}

export function isNearbyTimeframe(timeframe, otherTimeframe) {
  if (timeframe === otherTimeframe) return true;
  const index = timeframeOrder.indexOf(timeframe);
  const otherIndex = timeframeOrder.indexOf(otherTimeframe);
  return index >= 0 && otherIndex >= 0 && Math.abs(index - otherIndex) <= 1;
}

export function isSimilarEntryPrice(entry, otherEntry) {
  return getEntryZoneSimilarity(entry, otherEntry).matched;
}

export function isSimilarEntryPriceWithin(entry, otherEntry, tolerance = 0.0025) {
  const left = Number(entry);
  const right = Number(otherEntry);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return false;
  return Math.abs(left - right) / Math.max(left, right) <= tolerance;
}

export function isSimilarStrategyOrPattern(signal, row) {
  const strategy = strategyFamily(signal.setupType || signal.strategy);
  const otherStrategy = strategyFamily(row.setupType || row.strategy);
  const pattern = patternFamily(readPattern(signal));
  const otherPattern = patternFamily(readPattern(row));
  return Boolean(strategy && otherStrategy && strategy === otherStrategy) ||
    Boolean(pattern && otherPattern && pattern === otherPattern);
}

export function getEntryZoneSimilarity(entry, otherEntry, atr = null, options = {}) {
  const left = Number(entry);
  const right = Number(otherEntry);
  const atrValue = Number(atr);
  const percentTolerance = Number(options.percentTolerance ?? appConfig.signals.duplicateEntryPercentTolerance);
  const atrTolerance = Number(options.atrTolerance ?? appConfig.signals.duplicateEntryAtrTolerance);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) {
    return {
      matched: false,
      distancePercent: null,
      distanceAtr: null,
      matchMethod: "invalid_entry"
    };
  }
  const distance = Math.abs(left - right);
  const distanceRatio = distance / Math.max(Math.abs(left), Math.abs(right));
  const distanceAtr = Number.isFinite(atrValue) && atrValue > 0 ? distance / atrValue : null;
  const percentMatched = distanceRatio <= percentTolerance;
  const atrMatched = Number.isFinite(distanceAtr) && distanceAtr <= atrTolerance;
  return {
    matched: percentMatched || atrMatched,
    distancePercent: Number((distanceRatio * 100).toFixed(6)),
    distanceAtr: Number.isFinite(distanceAtr) ? Number(distanceAtr.toFixed(6)) : null,
    matchMethod: percentMatched && atrMatched
      ? "entry_percent_and_atr"
      : percentMatched
        ? "entry_percent"
        : atrMatched
          ? "entry_atr"
          : "entry_outside_tolerance"
  };
}

export function isDuplicateBlockingRecord(row, now = Date.now()) {
  if (!row) return false;
  const status = normalizeText(row.status);
  if (!["active", "expiring-soon", "pending", "ready", "alerted"].includes(status)) return false;
  const validUntil = new Date(row.valid_until ?? row.validUntil ?? Infinity).getTime();
  if (Number.isFinite(validUntil) && validUntil <= now) return false;
  const source = normalizeText(row.source);
  if (["legacy-saved-signal", "legacy-unlocked-signal", "backtest-shadow", "admin-test", "test", "debug"].includes(source)) return false;
  const gateStatus = normalizeText(row.quality_gate_status ?? row.qualityGateStatus);
  if (gateStatus && gateStatus !== "passed") return false;
  if (normalizeText(row.user_visibility ?? row.userVisibility) === "admin-only") return false;

  const sourceHistory = Array.isArray(row.source_history ?? row.sourceHistory)
    ? row.source_history ?? row.sourceHistory
    : [];
  const telegramStatus = normalizeText(row.telegram_status ?? row.telegramStatus);
  const promotedToUsers = ["manual-scan", "telegram-alert"].includes(source) ||
    sourceHistory.some((item) => normalizeText(item) === "telegram-alert") ||
    ["queued", "sent"].includes(telegramStatus) ||
    row.shownToUsers === true;
  return promotedToUsers;
}

export function evaluateDuplicateSignalMatch(signal, row, options = {}) {
  if (!signal || !isDuplicateBlockingRecord(row, options.now)) return noDuplicate("record_not_eligible");
  const pair = normalizePair(signal.symbol || signal.pair);
  const otherPair = normalizePair(row.pair || row.symbol || row.display_pair);
  if (!pair || pair !== otherPair) return noDuplicate("different_pair");
  const direction = normalizeText(signal.direction);
  const otherDirection = normalizeText(row.direction);
  if (!direction || direction !== otherDirection) return noDuplicate("different_direction");
  const sameTimeframe = signal.timeframe === row.timeframe;
  if (!sameTimeframe && !isNearbyTimeframe(signal.timeframe, row.timeframe)) return noDuplicate("unrelated_timeframe");

  const strategy = strategyFamily(signal.setupType || signal.strategy);
  const otherStrategy = strategyFamily(row.setupType || row.strategy);
  const pattern = patternFamily(readPattern(signal));
  const otherPattern = patternFamily(readPattern(row));
  const strategyMatched = Boolean(strategy && otherStrategy && strategy === otherStrategy);
  const patternMatched = Boolean(pattern && otherPattern && pattern === otherPattern);
  if (strategy && otherStrategy && !strategyMatched) return noDuplicate("different_strategy_family");
  if (!strategyMatched && !patternMatched) return noDuplicate("different_strategy_family");

  const atr = firstFinite(readAtr(signal), readAtr(row));
  const entrySimilarity = getEntryZoneSimilarity(
    signal.entryPrice ?? signal.entry,
    row.entryPrice ?? row.entry,
    atr,
    options
  );
  if (!entrySimilarity.matched) return noDuplicate("different_entry_zone", entrySimilarity);

  const triggerSimilarity = compareTriggerStructure(signal, row, atr, options);
  const tradePlanSimilarity = compareTradePlan(signal, row, atr, options);
  const otherSetupKey = row.setup_key || row.setupKey;
  const exactSetupKey = Boolean(signal.setupKey && otherSetupKey && signal.setupKey === otherSetupKey);
  const hasStrategy = Boolean(strategy && otherStrategy);
  const patternStructureMatch = patternMatched && !triggerSimilarity.available;
  const directStructureMatch = exactSetupKey || triggerSimilarity.matched || patternStructureMatch || tradePlanSimilarity.matched;
  const correlatedStructureMatch = exactSetupKey || triggerSimilarity.matched || (patternStructureMatch && tradePlanSimilarity.matched);
  if (hasStrategy ? !(sameTimeframe ? directStructureMatch : correlatedStructureMatch) : !(triggerSimilarity.matched && (patternMatched || tradePlanSimilarity.matched))) {
    return noDuplicate("different_market_structure", {
      ...entrySimilarity,
      triggerMatchMethod: triggerSimilarity.matchMethod
    });
  }

  const createdAt = new Date(row.created_at ?? row.createdAt).getTime();
  const now = Number(options.now ?? Date.now());
  const duplicateWindowMs = Number(options.duplicateWindowMs ?? 6 * 60 * 60 * 1000);
  const timeDifferenceMs = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : null;
  if (Number.isFinite(timeDifferenceMs) && timeDifferenceMs > duplicateWindowMs) {
    return noDuplicate("outside_duplicate_window");
  }

  const matchType = sameTimeframe ? "direct_duplicate" : "correlated_duplicate";
  const candidateStrength = duplicateStrength(signal);
  const existingStrength = duplicateStrength(row);
  const alreadyAlerted = ["queued", "sent"].includes(normalizeText(row.telegram_status ?? row.telegramStatus));
  const selected = matchType === "direct_duplicate" || alreadyAlerted || existingStrength.score >= candidateStrength.score
    ? "existing"
    : "candidate";
  const structureMethod = exactSetupKey
    ? "exact_setup_key"
    : triggerSimilarity.matched
      ? triggerSimilarity.matchMethod
      : patternMatched && tradePlanSimilarity.matched
        ? "pattern_and_trade_plan"
        : patternMatched
          ? "pattern_family"
          : tradePlanSimilarity.matchMethod;
  const details = duplicateDiagnostics({
    signal,
    row,
    matchType,
    selected,
    entrySimilarity,
    triggerSimilarity,
    structureMethod,
    timeDifferenceMs,
    candidateStrength,
    existingStrength
  });
  return {
    matched: true,
    blocked: selected === "existing",
    selectedCurrent: selected === "candidate",
    matchType,
    details
  };
}

async function findRecentGeneratedSignalDuplicate(signal) {
  const normalizedPair = normalizePair(signal.symbol || signal.pair);
  const result = await query(`
    SELECT id, signal_id, setup_key, promoted_from_candidate_id, pair, display_pair,
      timeframe, direction, strategy, pattern, pattern_context, entry, stop_loss,
      take_profit, confidence, calibrated_confidence, confidence_calibration,
      risk_reward, setup_quality_score, entry_readiness_score, status, valid_until,
      source, source_history, quality_gate_status, telegram_status, full_analysis,
      result_reason, created_at
    FROM generated_signals
    WHERE regexp_replace(upper(pair), '[^A-Z0-9]', '', 'g') = $1
      AND lower(direction) = $2
      AND status IN ('Active', 'Expiring Soon', 'Pending', 'Ready', 'Alerted')
      AND valid_until > now()
      AND source NOT IN ('legacy_saved_signal','legacy_unlocked_signal','backtest_shadow','admin_test')
      AND (quality_gate_status = 'passed' OR quality_gate_status IS NULL)
      AND (
        source IN ('manual_scan', 'telegram_alert')
        OR source_history ? 'telegram_alert'
        OR telegram_status IN ('queued', 'sent')
      )
      AND created_at >= now() - interval '6 hours'
    ORDER BY created_at DESC
    LIMIT 50
  `, [normalizedPair, normalizeText(signal.direction)]);

  const matches = result.rows
    .map((row) => ({ row, decision: evaluateDuplicateSignalMatch(signal, row) }))
    .filter((item) => item.decision.matched);
  if (!matches.length) return null;

  const direct = matches.find((item) => item.decision.matchType === "direct_duplicate");
  if (direct) return direct.decision;

  const strongestExisting = matches.sort((left, right) =>
    Number(right.decision.details?.existingStrength?.score || 0) -
    Number(left.decision.details?.existingStrength?.score || 0)
  )[0];
  if (strongestExisting.decision.blocked) return strongestExisting.decision;

  const supersededIds = matches
    .filter((item) => item.decision.selectedCurrent)
    .map((item) => item.row.id);
  if (supersededIds.length) {
    await query(`
      UPDATE generated_signals
      SET status = 'Correlated duplicate',
        result_reason = $2,
        updated_at = now()
      WHERE id = ANY($1::text[])
        AND status IN ('Active', 'Expiring Soon', 'Pending', 'Ready')
        AND COALESCE(telegram_status, '') NOT IN ('queued', 'sent')
    `, [
      supersededIds,
      `Superseded by stronger correlated setup ${signal.id || signal.setupKey || "candidate"}.`
    ]);
  }
  return strongestExisting.decision;
}

function compareTriggerStructure(signal, row, atr, options) {
  const triggers = readTriggerLevels(signal);
  const otherTriggers = readTriggerLevels(row);
  let closest = null;
  for (const trigger of triggers) {
    for (const otherTrigger of otherTriggers) {
      const comparison = getEntryZoneSimilarity(trigger.price, otherTrigger.price, atr, options);
      if (!closest || diagnosticDistance(comparison) < diagnosticDistance(closest)) {
        closest = {
          ...comparison,
          available: true,
          trigger: trigger.price,
          matchedTrigger: otherTrigger.price,
          matchMethod: comparison.matched
            ? `${trigger.source}:${otherTrigger.source}:${comparison.matchMethod}`
            : "trigger_outside_tolerance"
        };
      }
    }
  }
  return closest || {
    matched: false,
    available: false,
    distancePercent: null,
    distanceAtr: null,
    matchMethod: "trigger_unavailable"
  };
}

function compareTradePlan(signal, row, atr, options) {
  const stop = getEntryZoneSimilarity(
    signal.stopLoss ?? signal.stop_loss,
    row.stopLoss ?? row.stop_loss,
    atr,
    options
  );
  const target = getEntryZoneSimilarity(
    signal.takeProfit ?? signal.take_profit,
    row.takeProfit ?? row.take_profit,
    atr,
    options
  );
  return {
    matched: stop.matched && target.matched,
    matchMethod: stop.matched && target.matched ? "similar_stop_and_target" : "different_trade_plan",
    stopDistancePercent: stop.distancePercent,
    targetDistancePercent: target.distancePercent
  };
}

function readTriggerLevels(value = {}) {
  const fullAnalysis = value.full_analysis || value.fullAnalysis || {};
  const indicators = value.indicators || fullAnalysis.indicators || {};
  const structure = value.marketStructure || value.market_structure || fullAnalysis.marketStructure || {};
  const patternContext = value.patternContext || value.pattern_context || indicators.patternContext || fullAnalysis.patternContext || {};
  const keyLevels = patternContext.keyLevels || {};
  const riskPlan = value.riskPlan || value.risk_plan || fullAnalysis.riskPlan || {};
  const strategy = strategyFamily(value.setupType || value.strategy);
  const direction = normalizeText(value.direction);
  const levels = [];
  const add = (input, source) => {
    const price = readLevelPrice(input);
    if (!Number.isFinite(price) || price <= 0) return;
    if (levels.some((level) => Math.abs(level.price - price) <= Math.max(price, 1) * 1e-9)) return;
    levels.push({ price, source });
  };

  add(value.triggerLevel ?? value.trigger_level, "signal_trigger");
  add(indicators.triggerLevel ?? indicators.triggerPrice, "indicator_trigger");
  add(structure.triggerLevel ?? structure.entryTrigger, "structure_trigger");
  add(structure.retestLevel ?? structure.breakoutLevel, "structure_retest");
  add(riskPlan.triggerLevel ?? riskPlan.retestLevel, "risk_plan_trigger");
  add(keyLevels.breakoutLevel, "pattern_breakout");
  add(keyLevels.neckline, "pattern_neckline");

  if (strategy === "breakout_retest" || strategy === "structure_breakout") {
    add(direction === "long" ? keyLevels.resistance : keyLevels.support, "broken_structure");
  } else if (strategy === "range_bounce" || strategy === "support_resistance_retest") {
    add(direction === "long" ? keyLevels.support : keyLevels.resistance, "retest_structure");
  } else if (strategy === "liquidity_sweep_reversal") {
    add(keyLevels.invalidation ?? indicators.liquiditySweepLevel, "liquidity_sweep");
  }
  return levels;
}

function strategyFamily(value) {
  const strategy = normalizeText(value);
  if (!strategy || ["unknown-strategy", "qualified-setup"].includes(strategy)) return "";
  if (/breakout.*retest|retest.*breakout|resistance-break-retest|support-break-retest|structure-breakout-retest/.test(strategy)) return "breakout_retest";
  if (/support-breakdown|resistance-breakout|momentum-breakout|range-breakout/.test(strategy)) return "structure_breakout";
  if (/liquidity-sweep/.test(strategy)) return "liquidity_sweep_reversal";
  if (/range-bounce|mean-reversion/.test(strategy)) return "range_bounce";
  if (/support-resistance-retest|resistance-rejection|support-bounce/.test(strategy)) return "support_resistance_retest";
  if (/trend-continuation|pullback-continuation|higher-low-continuation|lower-high-continuation|multi-timeframe-continuation/.test(strategy)) return "trend_continuation";
  if (/momentum-exhaustion|failed-breakout|false-breakout/.test(strategy)) return "momentum_reversal";
  if (/double-top|double-bottom/.test(strategy)) return "double_reversal";
  if (/head-and-shoulders|inverse-head-and-shoulders/.test(strategy)) return "head_shoulders";
  return strategy;
}

function patternFamily(value) {
  const pattern = normalizeText(value);
  if (!pattern) return "";
  if (/bull-flag|bear-flag/.test(pattern)) return "flag";
  if (/ascending-triangle|descending-triangle|symmetrical-triangle/.test(pattern)) return "triangle";
  if (/bullish-rectangle|bearish-rectangle|range-rectangle/.test(pattern)) return "rectangle";
  if (/double-top|double-bottom/.test(pattern)) return "double_reversal";
  if (/head-and-shoulders|inverse-head-and-shoulders/.test(pattern)) return "head_shoulders";
  return pattern;
}

function readPattern(value = {}) {
  const fullAnalysis = value.full_analysis || value.fullAnalysis || {};
  const indicators = value.indicators || fullAnalysis.indicators || {};
  const patternContext = value.patternContext || value.pattern_context || indicators.patternContext || fullAnalysis.patternContext || {};
  return value.pattern || patternContext.pattern || patternContext.label || "";
}

function readAtr(value = {}) {
  const fullAnalysis = value.full_analysis || value.fullAnalysis || {};
  const indicators = value.indicators || fullAnalysis.indicators || {};
  return firstFinite(
    value.atr,
    indicators.atr14,
    fullAnalysis.riskPlan?.atr,
    value.confidence_calibration?.atr
  );
}

function duplicateStrength(value = {}) {
  const fullAnalysis = value.full_analysis || value.fullAnalysis || {};
  const indicators = value.indicators || fullAnalysis.indicators || {};
  const confidence = firstFinite(
    value.finalCalibratedConfidence,
    value.calibratedConfidence,
    value.calibrated_confidence,
    value.confidenceScore,
    value.confidence
  ) || 0;
  const quality = firstFinite(value.qualityScore, value.setupQualityScore, value.setup_quality_score) || 0;
  const readiness = firstFinite(value.readinessScore, value.entryReadinessScore, value.entry_readiness_score, indicators.readinessScore) || 0;
  const riskReward = firstFinite(value.riskRewardRatio, value.riskReward, value.risk_reward) || 0;
  const entryQuality = normalizeText(value.entryQuality || indicators.entryQuality);
  const entryQualityBonus = /excellent/.test(entryQuality) ? 4 : /good|acceptable/.test(entryQuality) ? 2 : 0;
  const timeframeBonus = { "15m": 3, "1h": 2, "4h": 1, "5m": 0 }[value.timeframe] || 0;
  const score = confidence + quality * 0.15 + readiness * 0.15 +
    Math.min(5, Math.max(0, riskReward)) * 2 + entryQualityBonus + timeframeBonus;
  return {
    score: Number(score.toFixed(3)),
    confidence,
    quality,
    readiness,
    riskReward,
    entryQuality: entryQuality || null,
    timeframeBonus
  };
}

function duplicateDiagnostics({
  signal,
  row,
  matchType,
  selected,
  entrySimilarity,
  triggerSimilarity,
  structureMethod,
  timeDifferenceMs,
  candidateStrength,
  existingStrength
}) {
  const timeDifferenceMinutes = Number.isFinite(timeDifferenceMs)
    ? Number((timeDifferenceMs / 60_000).toFixed(2))
    : null;
  const matchedSignalId = row.signal_id || row.signalId || row.id || null;
  const details = {
    matchedSignalId,
    matchedCandidateId: row.promoted_from_candidate_id || row.promotedFromCandidateId || null,
    matchedPair: row.pair || row.symbol || null,
    matchedTimeframe: row.timeframe || null,
    matchedDirection: row.direction || null,
    matchedStrategy: row.strategy || row.setupType || null,
    priorSignalStatus: row.status || null,
    priorSignalOutcome: row.result_reason || row.resultReason || null,
    entryDistancePercent: entrySimilarity.distancePercent,
    entryDistanceAtr: entrySimilarity.distanceAtr,
    timeDifferenceMinutes,
    matchType,
    duplicateMatchMethod: `${entrySimilarity.matchMethod}+${structureMethod}`,
    triggerMatchMethod: triggerSimilarity.matchMethod,
    exactRule: matchType === "direct_duplicate"
      ? "same_pair_timeframe_direction_strategy_entry_and_structure"
      : "nearby_timeframe_same_pair_direction_strategy_entry_and_structure",
    selectedSignal: selected,
    selectedSignalId: selected === "candidate"
      ? signal.id || signal.setupKey || null
      : matchedSignalId,
    selectionReason: selected === "candidate"
      ? "Current candidate has the stronger validated setup score."
      : ["queued", "sent"].includes(normalizeText(row.telegram_status ?? row.telegramStatus))
        ? "The existing signal was already queued or alerted."
        : "The existing active signal is at least as strong as the current candidate.",
    candidateStrength,
    existingStrength
  };
  return {
    ...details,
    matched_signal_id: details.matchedSignalId,
    matched_candidate_id: details.matchedCandidateId,
    duplicate_entry_distance_percent: details.entryDistancePercent,
    duplicate_entry_distance_atr: details.entryDistanceAtr,
    duplicate_match_method: details.duplicateMatchMethod,
    time_difference_minutes: details.timeDifferenceMinutes
  };
}

function noDuplicate(reason, details = {}) {
  return {
    matched: false,
    blocked: false,
    selectedCurrent: false,
    matchType: null,
    reason,
    details
  };
}

function withDuplicateSelectionDiagnostics(signal, details) {
  return {
    ...signal,
    duplicateSelection: details,
    indicators: {
      ...(signal.indicators || {}),
      duplicateSelection: details
    }
  };
}

function withCooldownDecisionDiagnostics(signal, details) {
  return {
    ...signal,
    cooldownDecision: details,
    indicators: {
      ...(signal.indicators || {}),
      cooldownDecision: details
    }
  };
}

function noCooldown(reason, details = {}) {
  return {
    matched: false,
    blocked: false,
    releasedEarly: false,
    reason,
    details: cooldownDiagnosticAliases(details)
  };
}

function releaseCooldown(reason, details = {}) {
  return {
    matched: false,
    blocked: false,
    releasedEarly: true,
    reason,
    details: cooldownDiagnosticAliases({
      ...details,
      cooldownReleasedEarly: true,
      cooldownReleaseReason: reason,
      earlyReleaseAllowed: true,
      finalCooldownDecision: "released_early"
    })
  };
}

function cooldownDiagnosticAliases(details = {}) {
  return {
    ...details,
    matched_signal_id: details.matchedSignalId ?? null,
    matched_candidate_id: details.matchedCandidateId ?? null,
    cooldown_started_at: details.cooldownStartedAt ?? null,
    cooldown_expires_at: details.cooldownExpiresAt ?? null,
    remaining_duration_ms: details.remainingDurationMs ?? null,
    cooldown_released_early: Boolean(details.cooldownReleasedEarly),
    cooldown_release_reason: details.cooldownReleaseReason ?? null,
    previous_structure_id: details.previousStructureId ?? null,
    current_structure_id: details.currentStructureId ?? null
  };
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasValidTradeLevels(value = {}) {
  const entry = firstFinite(value.entryPrice, value.entry);
  const stop = firstFinite(value.stopLoss, value.stop_loss);
  const target = firstFinite(value.takeProfit, value.take_profit);
  const direction = normalizeText(value.direction);
  if (![entry, stop, target].every((number) => Number.isFinite(number) && number > 0)) return false;
  if (direction === "long") return stop < entry && target > entry;
  if (direction === "short") return stop > entry && target < entry;
  return false;
}

function readExpirationClassification(value = {}) {
  const fullAnalysis = value.full_analysis || value.fullAnalysis || {};
  const indicators = value.indicators || fullAnalysis.indicators || {};
  const classification = value.expirationClassification ||
    value.expiration_classification ||
    indicators.expirationClassification ||
    fullAnalysis.expirationClassification ||
    value.result_reason ||
    value.resultReason;
  const normalized = normalizeText(classification);
  if (normalized.includes("expired-after-entry")) return "expired-after-entry";
  if (normalized.includes("expired-without-entry")) return "expired-without-entry";
  if (normalized.includes("invalidated-before-entry")) return "invalidated-before-entry";
  if (normalized.includes("stale-signal")) return "stale-signal";
  return normalized;
}

function hasMeaningfulRealizedLoss(value = {}) {
  const fullAnalysis = value.full_analysis || value.fullAnalysis || {};
  const indicators = value.indicators || fullAnalysis.indicators || {};
  const realizedR = firstFinite(
    value.realizedR,
    value.realized_r,
    value.resultR,
    value.result_r,
    indicators.realizedR,
    fullAnalysis.realizedR
  );
  if (Number.isFinite(realizedR)) return realizedR < 0;
  return /\b(loss|stopped|hit sl|negative r)\b/i.test(String(value.result_reason || value.resultReason || ""));
}

function readStructureId(value = {}) {
  const fullAnalysis = value.full_analysis || value.fullAnalysis || {};
  const indicators = value.indicators || fullAnalysis.indicators || {};
  const structure = value.marketStructure || value.market_structure || fullAnalysis.marketStructure || {};
  const pattern = value.patternContext || value.pattern_context || indicators.patternContext || fullAnalysis.patternContext || {};
  return String(
    value.structureId ||
    value.structure_id ||
    structure.structureId ||
    structure.id ||
    pattern.structureId ||
    ""
  ).trim() || null;
}

function readCooldownRegime(value = {}, marketData = {}) {
  const fullAnalysis = value.full_analysis || value.fullAnalysis || {};
  const indicators = value.indicators || fullAnalysis.indicators || {};
  const regime = value.marketRegime ||
    value.regime ||
    indicators.regime ||
    fullAnalysis.marketStructure?.regime ||
    marketData?.regime?.label ||
    marketData?.analysis?.regime;
  return normalizeText(regime);
}

function readCooldownResolvedAt(row = {}) {
  const value = row.resolved_at ??
    row.resolvedAt ??
    row.hit_sl_at ??
    row.hitSlAt ??
    row.manually_closed_at ??
    row.manuallyClosedAt ??
    row.expired_at ??
    row.expiredAt ??
    row.updated_at ??
    row.updatedAt;
  const resolvedAt = new Date(value).getTime();
  return Number.isFinite(resolvedAt) ? resolvedAt : null;
}

function countCandlesSince(candles, timestamp) {
  if (!Array.isArray(candles) || !Number.isFinite(timestamp)) return 0;
  return candles.filter((candle) => {
    const value = candle?.time ?? candle?.timestamp ?? candle?.openTime ?? candle?.date;
    const candleTime = typeof value === "number" && value < 10_000_000_000
      ? value * 1000
      : new Date(value).getTime();
    return Number.isFinite(candleTime) && candleTime > timestamp;
  }).length;
}

function formatCooldownDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "0m";
  const minutes = Math.ceil(durationMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h ${remainder}m` : `${minutes}m`;
}

function normalizePair(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function readLevelPrice(value) {
  if (value && typeof value === "object") return firstFinite(value.price, value.level, value.value);
  return firstFinite(value);
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (value !== null && value !== undefined && value !== "" && Number.isFinite(number)) return number;
  }
  return null;
}

function diagnosticDistance(value) {
  if (Number.isFinite(value?.distanceAtr)) return value.distanceAtr;
  if (Number.isFinite(value?.distancePercent)) return value.distancePercent;
  return Infinity;
}

async function findRecentGeneratedSignalFailure(signal, marketData = {}) {
  const maxCooldownMs = getFailureCooldownMs("4h", "Hit SL");
  const normalizedPair = normalizePair(signal.symbol || signal.pair);
  const result = await query(`
    SELECT id, signal_id, setup_key, promoted_from_candidate_id, pair, timeframe,
      direction, strategy, pattern, pattern_context, entry, stop_loss, take_profit,
      status, source, source_history, quality_gate_status, telegram_status,
      full_analysis, result_reason, max_adverse_excursion,
      COALESCE(hit_sl_at, manually_closed_at, expired_at, updated_at, created_at) AS resolved_at
    FROM generated_signals
    WHERE regexp_replace(upper(pair), '[^A-Z0-9]', '', 'g') = $1
      AND timeframe = $2
      AND status IN ('Hit SL', 'Expired', 'Manually closed')
      AND ${currentEngineSourceSql}
      AND COALESCE(hit_sl_at, manually_closed_at, expired_at, updated_at, created_at)
        >= now() - ($3::text || ' milliseconds')::interval
    ORDER BY COALESCE(hit_sl_at, manually_closed_at, expired_at, updated_at, created_at) DESC
    LIMIT 25
  `, [normalizedPair, signal.timeframe, String(maxCooldownMs)]);

  let released = null;
  for (const row of result.rows) {
    const decision = evaluateSignalTradeCooldown(signal, row, marketData);
    if (decision.blocked) return decision;
    if (!released && decision.releasedEarly) released = decision;
  }
  return released;
}

async function hasProvenSourceStrategyTimeframe(signal, source) {
  const result = await query(`
    SELECT COUNT(*) FILTER (WHERE status IN ('Hit TP','Hit SL'))::integer AS closed,
      COUNT(*) FILTER (WHERE status = 'Hit TP')::integer AS hit_tp,
      COUNT(*) FILTER (WHERE status = 'Hit SL')::integer AS hit_sl,
      COALESCE(AVG(risk_reward), 0) AS average_rr
    FROM generated_signals
    WHERE source = $1
      AND strategy = $2
      AND timeframe = $3
      AND ${currentEngineSourceSql}
  `, [source, signal.setupType || signal.strategy || "Qualified setup", signal.timeframe]);
  const row = result.rows[0] || {};
  const closed = Number(row.closed || 0);
  if (closed < 20) return false;
  const hitTp = Number(row.hit_tp || 0);
  const hitSl = Number(row.hit_sl || 0);
  const winRate = closed ? hitTp / closed : 0;
  const averageRr = Number(row.average_rr || 0);
  const expectancy = winRate * averageRr - (1 - winRate);
  return expectancy > 0;
}

async function recordAndReturn(signal, gate, context) {
  await recordGateSafely(signal, gate, context);
  return gate;
}

async function recordGateSafely(signal, gate, context) {
  try {
    await recordSignalQualityGateResult(signal, gate, context);
  } catch (error) {
    console.warn(`[signal-quality-gate] diagnostic_write_failed reason=${error.message}`);
  }
}

function passGate(details = {}) {
  return { passed: true, status: "passed", reasons: [], ...details };
}

function attachAdjustedSignal(gate, signal) {
  Object.defineProperty(gate, "adjustedSignal", {
    value: signal,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return gate;
}

function blockGate(type, reason, details = {}, qualityGateV2 = null) {
  const status = blockedGeneratedSignalStatuses[type] || blockedGeneratedSignalStatuses.duplicate;
  return {
    version: qualityGateV2?.version || "quality_gate_v2",
    passed: false,
    type,
    stage: `generated_quality_${type}`,
    status,
    reason,
    details,
    reasonCode: qualityGateV2?.reasonCode || blockedGeneratedSignalReasonCodes[type] || normalizeText(status),
    explanation: qualityGateV2?.explanation || reason,
    userExplanation: qualityGateV2?.userExplanation || reason,
    qualityGateV2,
    checkedAt: new Date().toISOString()
  };
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
