const TIMELINE_ORDER = Object.freeze([
  "candidate_generated",
  "strategy_evaluated",
  "raw_confidence_calculated",
  "stop_validated",
  "stop_repair",
  "take_profit_validated",
  "take_profit_repair",
  "historical_calibration",
  "quality_gate",
  "duplicate_check",
  "cooldown_check",
  "quarantine_check",
  "final_decision",
  "telegram_preference",
  "telegram_delivery"
]);

const REASON_COPY = Object.freeze({
  all_signal_requirements_passed: "Passed all validation and was promoted to a ready signal.",
  below_ready_promotion_threshold: "Final confidence was below the ready-promotion threshold.",
  weak_strategy_match: "The current setup did not match its assigned strategy strongly enough.",
  exact_historical_underperformance: "A sufficiently specific historical group is underperforming.",
  historical_underperformer: "A sufficiently specific historical group is underperforming.",
  invalid_stop_loss: "The stop loss was invalid and could not be repaired.",
  repaired_stop_breaks_rr_requirement: "The repaired stop could not preserve the minimum risk/reward.",
  unrealistic_take_profit: "No realistic target could preserve the minimum risk/reward.",
  repaired_take_profit_breaks_rr_requirement: "The repaired target fell below the minimum risk/reward.",
  duplicate: "The candidate duplicated an active promoted signal.",
  duplicate_blocked: "The candidate duplicated an active promoted signal.",
  correlated_duplicate: "A stronger active signal already represents this correlated setup.",
  cooldown: "A similar failed promoted signal remains in cooldown.",
  cooldown_blocked: "A similar failed promoted signal remains in cooldown.",
  quarantined_timeframe: "The timeframe is explicitly quarantined from ready promotion.",
  readiness_failed: "Entry readiness did not meet ready-signal requirements.",
  calibration_error: "Confidence calibration failed, so the candidate remained internal.",
  insufficient_historical_data: "Historical calibration data was insufficient; no result was invented.",
  telegram_blocked_user_confidence_preference: "The final confidence did not meet the user's Telegram preference.",
  telegram_blocked_user_preference: "The signal did not meet the user's Telegram preferences.",
  telegram_sent: "Telegram accepted and sent the ready trade alert.",
  telegram_queued: "The ready trade alert is queued for delivery."
});

export function buildAdminSignalDiagnostics(signal = {}) {
  const legacy = isLegacy(signal);
  const analysis = signal.fullAnalysis || {};
  const indicators = analysis.indicators || {};
  const calibration = signal.confidenceCalibration || indicators.confidenceCalibration || {};
  const stop = buildStopDiagnostics(analysis.stopValidation || indicators.stopRepairDiagnostics, legacy);
  const target = buildTargetDiagnostics(analysis.takeProfitValidation || indicators.takeProfitRepairDiagnostics, legacy);
  const generatedGate = indicators.generatedQualityGate || {};
  const duplicate = buildDuplicateDiagnostics(generatedGate, indicators.duplicateSelection, signal, legacy);
  const cooldown = buildCooldownDiagnostics(generatedGate, indicators.cooldownDecision, signal, legacy);
  const qualityGate = buildQualityGateDiagnostics(signal, generatedGate, indicators.qualityGateV2, legacy);
  const quarantine = buildQuarantineDiagnostics(signal, generatedGate, indicators, legacy);
  const confidence = buildConfidenceDiagnostics(signal, calibration, legacy);
  const telegram = buildTelegramDiagnostics(signal, legacy);
  const summary = buildSummary(signal, telegram, legacy);
  const timeline = buildTimeline({ signal, summary, confidence, stop, target, qualityGate, duplicate, cooldown, quarantine, telegram, legacy });

  return {
    legacy,
    unavailableMessage: legacy ? "Data unavailable for this decision version." : null,
    summary,
    timeline,
    timelineOrder: TIMELINE_ORDER,
    confidence,
    stopLoss: stop,
    takeProfit: target,
    duplicate,
    cooldown,
    qualityGate,
    quarantine,
    telegram
  };
}

export function attachAdminSignalReferences(diagnostics, references = {}) {
  if (!diagnostics) return diagnostics;
  const duplicateSignalId = diagnostics.duplicate?.matchedSignalId;
  const cooldownSignalId = diagnostics.cooldown?.priorSignalId;
  return {
    ...diagnostics,
    duplicate: diagnostics.duplicate ? {
      ...diagnostics.duplicate,
      relatedGeneratedSignalId: duplicateSignalId ? references[duplicateSignalId] || null : null
    } : null,
    cooldown: diagnostics.cooldown ? {
      ...diagnostics.cooldown,
      relatedGeneratedSignalId: cooldownSignalId ? references[cooldownSignalId] || null : null
    } : null
  };
}

function buildSummary(signal, telegram, legacy) {
  const finalDecision = legacy ? null : signal.finalDecision || null;
  const reasonCode = signal.primaryDecisionReason || signal.qualityGateReason || normalize(signal.resultReason) || null;
  return {
    finalDecision,
    finalDecisionLabel: legacy ? "Legacy record" : signal.finalDecisionLabel || label(finalDecision) || "Admin-only",
    primaryReasonCode: reasonCode,
    primaryReason: explainReason(reasonCode, signal.resultReason, legacy),
    secondaryNotes: array(signal.secondaryDecisionNotes),
    userVisibility: legacy ? "Legacy visibility unavailable" : signal.userVisibility || "Admin-only",
    creditEligible: legacy ? null : finalDecision === "ready_signal",
    telegramEligible: legacy ? null : ["telegram_sent", "telegram_queued"].includes(telegram.status),
    signalSource: signal.source || null,
    decisionVersion: signal.decisionVersion || null,
    createdAt: signal.decisionCreatedAt || signal.createdAt || null,
    legacy
  };
}

function buildConfidenceDiagnostics(signal, calibration, legacy) {
  const recorded = signal.diagnosticAvailability || {};
  const rawConfidence = finite(
    calibration.rawSetupScore,
    calibration.originalConfidence,
    recorded.rawConfidenceRecorded === false ? null : signal.rawSetupScore,
    recorded.rawConfidenceRecorded === false ? null : signal.originalConfidence
  );
  const finalConfidence = finite(
    calibration.finalCalibratedConfidence,
    calibration.calibratedConfidence,
    calibration.finalConfidence,
    recorded.calibratedConfidenceRecorded === false ? null : signal.calibratedConfidence,
    recorded.calibratedConfidenceRecorded === false ? null : signal.finalConfidence
  );
  const historicalGroup = calibration.historicalGroupUsed || calibration.blockingEvidence || null;
  const telegramDetails = latestTelegramDetails(signal);
  return {
    available: rawConfidence !== null || finalConfidence !== null || Boolean(calibration.version),
    unavailableReason: rawConfidence === null && finalConfidence === null
      ? unavailable("Confidence breakdown", legacy)
      : null,
    rawConfidence,
    strategyMatchScore: finite(calibration.strategyMatchScore, signal.strategyMatchScore),
    calibrationStatus: calibration.status || (legacy ? "legacy_unavailable" : "not_recorded"),
    historicalPenalty: finite(calibration.historicalCalibrationAdjustment, calibration.totalPenalty),
    confidenceCap: finite(calibration.confidenceCap),
    finalCalibratedConfidence: finalConfidence,
    readyPromotionThreshold: finite(
      signal.qualityGateDetails?.readyPromotionThreshold,
      signal.qualityGateDetails?.minimumConfidence,
      signal.validationSummary?.readyPromotionThreshold
    ),
    userTelegramThreshold: finite(telegramDetails.userAlertThreshold),
    globalTelegramThreshold: finite(telegramDetails.globalAlertThreshold),
    effectiveTelegramThreshold: finite(telegramDetails.effectiveAlertThreshold),
    historicalGroup: historicalGroup ? {
      type: historicalGroup.groupType || historicalGroup.type || null,
      value: historicalGroup.groupValue || historicalGroup.value || null,
      pair: historicalGroup.pair || signal.pair || null,
      timeframe: historicalGroup.timeframe || signal.timeframe || null,
      strategy: historicalGroup.strategy || signal.strategy || null,
      direction: historicalGroup.direction || signal.direction || null,
      marketRegime: historicalGroup.marketRegime || historicalGroup.regime || null,
      sampleSize: finite(historicalGroup.closedSignals, historicalGroup.sampleSize, calibration.historicalSampleSize),
      winRate: finite(historicalGroup.winRate, calibration.historicalWinRate),
      expectancy: finite(historicalGroup.estimatedExpectancy, historicalGroup.expectancy, calibration.historicalExpectancy)
    } : null,
    reason: calibration.calibrationReason || signal.calibrationReason || null,
    technicalError: calibration.technicalError || null
  };
}

function buildStopDiagnostics(value, legacy) {
  if (!value || typeof value !== "object") {
    return { available: false, unavailableReason: unavailable("Stop validation", legacy) };
  }
  const attempted = Boolean(value.repairAttempted ?? value.stopRepairAttempted ?? value.stop_repair_attempted);
  const succeeded = Boolean(value.repairSucceeded ?? value.stopRepairSucceeded ?? value.stop_repair_succeeded);
  return {
    available: true,
    originalStop: finite(value.originalStopLoss, value.original_stop_loss),
    validationResult: value.originalFailureReason || value.stopValidationReason ? "failed" : "passed",
    originalFailureReason: value.originalFailureReason || value.stopValidationReason || value.stop_validation_reason || null,
    repairAttempted: attempted,
    repairSucceeded: succeeded,
    repairSource: value.repairSource || value.stopRepairSource || value.stop_repair_source || null,
    repairedStop: finite(value.repairedStopLoss, value.repaired_stop_loss),
    atrBuffer: finite(value.atrBufferUsed),
    originalDistance: finite(value.originalStopDistance, value.original_stop_distance),
    repairedDistance: finite(value.repairedStopDistance, value.repaired_stop_distance),
    distanceAtr: finite(value.repairedStopDistanceAtr, value.stopDistanceAtr, value.stop_distance_atr),
    riskRewardAfterRepair: finite(value.repairedRiskReward),
    finalResult: value.finalResult || (succeeded ? "passed" : attempted ? "failed" : "passed"),
    finalReason: value.repairFailureReason || value.stopValidationReason || value.stop_validation_reason || null,
    repairNotAttemptedReason: !attempted && value.originalFailureReason
      ? value.repairFailureReason || "No valid repair path was recorded."
      : null
  };
}

function buildTargetDiagnostics(value, legacy) {
  if (!value || typeof value !== "object") {
    return { available: false, unavailableReason: unavailable("Take-profit validation", legacy) };
  }
  const attempted = Boolean(value.repairAttempted ?? value.takeProfitRepairAttempted ?? value.take_profit_repair_attempted);
  const succeeded = Boolean(value.repairSucceeded ?? value.takeProfitRepairSucceeded ?? value.take_profit_repair_succeeded);
  return {
    available: true,
    originalTarget: finite(value.originalTakeProfit, value.original_take_profit),
    validationResult: value.originalFailureReason || value.targetValidationReason ? "failed" : "passed",
    originalFailureReason: value.originalFailureReason || value.targetValidationReason || value.target_validation_reason || null,
    repairAttempted: attempted,
    repairSucceeded: succeeded,
    repairSource: value.repairSource || value.takeProfitRepairSource || value.take_profit_repair_source || null,
    repairedTarget: finite(value.repairedTakeProfit, value.repaired_take_profit),
    nearestOpposingStructure: finite(value.nearestOpposingStructure),
    requiredAtrMove: finite(value.atrMoveRequired),
    originalRiskReward: finite(value.originalRiskReward, value.original_rr),
    repairedRiskReward: finite(value.repairedRiskReward, value.repaired_rr),
    finalResult: value.finalResult || (succeeded ? "passed" : attempted ? "failed" : "passed"),
    finalReason: value.repairFailureReason || value.targetValidationReason || value.target_validation_reason || null,
    repairNotAttemptedReason: !attempted && value.originalFailureReason
      ? value.repairFailureReason || "No valid repair path was recorded."
      : null
  };
}

function buildDuplicateDiagnostics(generatedGate, selection, signal, legacy) {
  const details = ["duplicate", "correlated"].includes(generatedGate?.type)
    ? generatedGate.details || {}
    : selection || null;
  const blocked = ["duplicate", "duplicate_blocked", "correlated_duplicate"].includes(signal.primaryDecisionReason) ||
    /duplicate/i.test(String(signal.status || "")) && !selection?.selectedSignal;
  if (!details && legacy) return { available: false, result: "unavailable", unavailableReason: unavailable("Duplicate check", true) };
  if (!details) return { available: true, result: blocked ? "blocked" : "passed" };
  return {
    available: true,
    result: blocked || details.selectedSignal === "existing" ? "blocked" : "passed",
    matchedSignalId: details.matchedSignalId || details.matched_signal_id || null,
    matchedCandidateId: details.matchedCandidateId || details.matched_candidate_id || null,
    matchedStatus: details.priorSignalStatus || null,
    matchedOutcome: details.priorSignalOutcome || null,
    samePair: compare(details.matchedPair, signal.pair),
    sameTimeframe: compare(details.matchedTimeframe, signal.timeframe),
    sameDirection: compare(details.matchedDirection, signal.direction),
    sameStrategyFamily: details.strategyFamilyMatch ?? compare(details.matchedStrategy, signal.strategy),
    entryDistancePercent: finite(details.entryDistancePercent, details.duplicate_entry_distance_percent),
    entryDistanceAtr: finite(details.entryDistanceAtr, details.duplicate_entry_distance_atr),
    timeDifferenceMinutes: finite(details.timeDifferenceMinutes, details.time_difference_minutes),
    matchType: details.matchType || null,
    rule: details.exactRule || details.duplicateMatchMethod || details.duplicate_match_method || null,
    selectionReason: details.selectionReason || null,
    relatedGeneratedSignalId: null
  };
}

function buildCooldownDiagnostics(generatedGate, stored, signal, legacy) {
  const details = generatedGate?.type === "cooldown" ? generatedGate.details || {} : stored || null;
  const blocked = ["cooldown", "cooldown_blocked"].includes(signal.primaryDecisionReason) || /cooldown/i.test(String(signal.status || ""));
  if (!details && legacy) return { available: false, result: "unavailable", unavailableReason: unavailable("Cooldown check", true) };
  if (!details) return { available: true, result: blocked ? "blocked" : "passed" };
  return {
    available: true,
    result: blocked ? "blocked" : details.cooldownReleasedEarly ? "released" : "passed",
    priorSignalId: details.matchedSignalId || details.previousSignalId || null,
    priorOutcome: details.previousOutcome || null,
    priorUserReady: maybeBoolean(details.previousSignalPromoted),
    priorTelegramSent: maybeBoolean(details.previousTelegramSent),
    pairSimilarity: compare(details.previousPair, signal.pair),
    timeframeSimilarity: compare(details.previousTimeframe, signal.timeframe),
    directionSimilarity: compare(details.previousDirection, signal.direction),
    strategySimilarity: compare(details.previousStrategy, signal.strategy),
    startedAt: details.cooldownStartedAt || null,
    expiresAt: details.cooldownExpiresAt || null,
    remainingDuration: details.remainingDurationLabel || null,
    structureSimilarity: details.structureSimilarity || null,
    earlyReleaseEvaluated: details.earlyReleaseAllowed == null ? null : true,
    earlyReleaseAllowed: maybeBoolean(details.earlyReleaseAllowed),
    releaseReason: details.cooldownReleaseReason || null,
    rule: details.exactMatchingRule || null,
    relatedGeneratedSignalId: null
  };
}

function buildQualityGateDiagnostics(signal, generatedGate, v2, legacy) {
  const details = signal.qualityGateDetails || v2 || generatedGate?.qualityGateV2 || generatedGate || {};
  const status = signal.qualityGateStatus || details.status || (generatedGate.passed === true ? "passed" : generatedGate.passed === false ? "failed" : null);
  const checks = array(details.checks);
  const laterBlocked = status === "passed" && signal.finalDecision === "blocked";
  return {
    available: Boolean(status || checks.length || signal.qualityGateReason),
    unavailableReason: !status && !checks.length ? unavailable("Quality Gate", legacy) : null,
    status,
    passed: status === "passed" || details.passed === true,
    version: details.version || generatedGate.version || null,
    checksPassed: checks.filter((item) => item?.passed === true).map(compactCheck),
    checksFailed: checks.filter((item) => item?.passed === false).map(compactCheck),
    primaryReason: signal.qualityGateReason || details.reasonCode || generatedGate.reasonCode || null,
    secondaryNotes: array(details.secondaryNotes || details.reasons),
    neededToPass: details.whatWouldImprove || details.neededToPass || details.publicExplanation || null,
    laterBlockExplanation: laterBlocked
      ? `Quality Gate passed. The candidate was later blocked by ${laterProtectionLabel(signal.primaryDecisionReason)}.`
      : null
  };
}

function buildQuarantineDiagnostics(signal, generatedGate, indicators, legacy) {
  const blocked = signal.primaryDecisionReason === "quarantined_timeframe" || /quarantined/i.test(String(signal.status || ""));
  const policy = generatedGate?.details?.timeframePolicy || indicators.timeframeQualityPolicy || null;
  if (!blocked && !policy && legacy) return { available: false, result: "unavailable", unavailableReason: unavailable("Quarantine check", true) };
  if (!blocked) return { available: true, result: "passed", scope: null, explanation: "No hard quarantine applied." };
  const scope = generatedGate?.details?.quarantineScope || policy?.scope || (signal.primaryDecisionReason === "quarantined_timeframe" ? "timeframe" : "specific_group");
  return {
    available: true,
    result: "blocked",
    scope,
    group: generatedGate?.details?.groupValue || (scope === "timeframe" ? signal.timeframe : null),
    manual: Boolean(generatedGate?.details?.adminManualQuarantine),
    explanation: generatedGate?.reason || policy?.reason || (scope === "timeframe"
      ? `Blocked by explicit ${signal.timeframe} timeframe quarantine.`
      : "Blocked by a specific performance quarantine.")
  };
}

function buildTelegramDiagnostics(signal, legacy) {
  const decisions = array(signal.telegramDecisions);
  const latest = decisions[0] || null;
  const details = latest?.details || signal.telegramBlockDetails || {};
  const status = latest?.status || signal.telegramStatus || (legacy ? "legacy_unavailable" : "reconciliation_pending");
  const reasonCode = latest?.reason || signal.telegramBlockReason || null;
  return {
    available: status !== "legacy_unavailable",
    status,
    statusLabel: telegramStatusLabel(status),
    dispatchConsidered: status !== "legacy_unavailable" && status !== "reconciliation_pending",
    signalFinalDecision: legacy ? null : signal.finalDecision || null,
    finalCalibratedConfidence: finite(details.finalCalibratedConfidence, signal.diagnosticAvailability?.calibratedConfidenceRecorded === false ? null : signal.calibratedConfidence),
    globalThreshold: finite(details.globalAlertThreshold),
    userThreshold: finite(details.userAlertThreshold),
    effectiveThreshold: finite(details.effectiveAlertThreshold),
    preferencePassed: maybeBoolean(details.preferenceCheckPassed),
    signalId: signal.signalId || null,
    queueId: latest?.queueId || details.queueId || null,
    attemptCount: finite(latest?.attemptCount, details.attemptCount),
    lastAttemptAt: latest?.attemptedAt || signal.telegramLastCheckedAt || null,
    telegramMessageId: latest?.telegramMessageId || details.telegramApiResponse?.messageId || null,
    deepLinkUrl: details.deepLinkUrl || null,
    reasonCode,
    reason: telegramReason(reasonCode, details, signal, legacy),
    finalErrorCode: latest?.finalErrorCode || details.errorCode || null,
    finalErrorMessage: latest?.finalErrorMessage || details.errorMessage || null,
    decisions: decisions.map((item) => ({
      userId: item.userId || null,
      status: item.status,
      reason: item.reason || null,
      attemptedAt: item.attemptedAt || null,
      queueId: item.queueId || null,
      attemptCount: finite(item.attemptCount),
      telegramMessageId: item.telegramMessageId || null,
      finalErrorCode: item.finalErrorCode || null,
      finalErrorMessage: item.finalErrorMessage || null
    })),
    unavailableReason: status === "legacy_unavailable" ? unavailable("Telegram decision", true) : null
  };
}

function buildTimeline(context) {
  const { signal, summary, confidence, stop, target, qualityGate, duplicate, cooldown, quarantine, telegram, legacy } = context;
  const strategyScore = confidence.strategyMatchScore;
  return [
    step("candidate_generated", "Candidate generated", "passed", `Created from ${signal.source || "unknown source"}.`),
    step("strategy_evaluated", "Strategy evaluated", legacy && strategyScore === null && !signal.strategyValidationStatus ? "skipped" : signal.strategyValidationStatus === "failed" ? "failed" : "passed", strategyScore === null ? signal.strategyValidationReason || unavailable("Strategy score", legacy) : `Strategy match score ${formatNumber(strategyScore)}.`),
    step("raw_confidence_calculated", "Raw confidence calculated", confidence.rawConfidence === null ? "skipped" : "passed", confidence.rawConfidence === null ? unavailable("Raw confidence", legacy) : `${formatNumber(confidence.rawConfidence)}%.`),
    step("stop_validated", "Stop validated", stop.available ? stop.validationResult : "skipped", stop.available ? stop.originalFailureReason || "Original stop passed validation." : stop.unavailableReason),
    step("stop_repair", "Stop repair", !stop.available || !stop.repairAttempted ? "not_applicable" : stop.repairSucceeded ? "repaired" : "failed", stop.repairAttempted ? stop.repairSource || stop.finalReason || "Repair result recorded." : stop.repairNotAttemptedReason || "Repair was not needed."),
    step("take_profit_validated", "Take profit validated", target.available ? target.validationResult : "skipped", target.available ? target.originalFailureReason || "Original target passed validation." : target.unavailableReason),
    step("take_profit_repair", "Take-profit repair", !target.available || !target.repairAttempted ? "not_applicable" : target.repairSucceeded ? "repaired" : "failed", target.repairAttempted ? target.repairSource || target.finalReason || "Repair result recorded." : target.repairNotAttemptedReason || "Repair was not needed."),
    step("historical_calibration", "Historical calibration applied", !confidence.available ? "skipped" : confidence.calibrationStatus === "calibration_error" ? "failed" : "passed", confidence.reason || label(confidence.calibrationStatus)),
    step("quality_gate", "Quality Gate evaluated", !qualityGate.available ? "skipped" : qualityGate.passed ? "passed" : "failed", qualityGate.laterBlockExplanation || qualityGate.primaryReason || qualityGate.unavailableReason),
    step("duplicate_check", "Duplicate check", duplicate.result === "unavailable" ? "skipped" : duplicate.result === "blocked" ? "failed" : "passed", duplicate.result === "blocked" ? `Matched active signal ${duplicate.matchedSignalId || "recorded signal"}.` : duplicate.unavailableReason || "No blocking duplicate found."),
    step("cooldown_check", "Cooldown check", cooldown.result === "unavailable" ? "skipped" : cooldown.result === "blocked" ? "failed" : cooldown.result === "released" ? "repaired" : "passed", cooldown.result === "blocked" ? `Cooldown remains active from ${cooldown.priorSignalId || "a prior promoted signal"}.` : cooldown.unavailableReason || (cooldown.result === "released" ? cooldown.releaseReason : "No applicable cooldown found.")),
    step("quarantine_check", "Quarantine check", quarantine.result === "unavailable" ? "skipped" : quarantine.result === "blocked" ? "failed" : "passed", quarantine.explanation || quarantine.unavailableReason),
    step("final_decision", "Final decision", summary.finalDecision === "ready_signal" ? "passed" : ["blocked", "rejected"].includes(summary.finalDecision) ? "failed" : "skipped", `${summary.finalDecisionLabel}: ${summary.primaryReason}`),
    step("telegram_preference", "Telegram preference check", telegram.status === "legacy_unavailable" || telegram.status === "reconciliation_pending" ? "skipped" : telegram.preferencePassed === false ? "failed" : telegram.preferencePassed === true ? "passed" : "not_applicable", telegramPreferenceSummary(telegram)),
    step("telegram_delivery", "Telegram delivery result", ["telegram_sent", "telegram_queued"].includes(telegram.status) ? "passed" : telegram.status === "telegram_failed" ? "failed" : telegram.status === "legacy_unavailable" ? "skipped" : "not_applicable", `${telegram.statusLabel}${telegram.reason ? `: ${telegram.reason}` : ""}`)
  ];
}

function latestTelegramDetails(signal) {
  return signal.telegramDecisions?.[0]?.details || signal.telegramBlockDetails || {};
}

function explainReason(code, fallback, legacy) {
  if (code && REASON_COPY[code]) return REASON_COPY[code];
  if (fallback) return String(fallback);
  if (code) return label(code);
  return legacy ? "Data unavailable for this decision version." : "No primary decision reason was recorded.";
}

function telegramReason(code, details, signal, legacy) {
  if (code === "telegram_blocked_user_confidence_preference" || code === "telegram_blocked_user_preference") {
    const confidence = finite(details.finalCalibratedConfidence, signal.calibratedConfidence);
    const threshold = finite(details.effectiveAlertThreshold, details.userAlertThreshold);
    if (confidence !== null && threshold !== null) return `Final confidence ${formatNumber(confidence)} is below the user's effective alert threshold of ${formatNumber(threshold)}.`;
  }
  return explainReason(code, signal.telegramBlockReason, legacy);
}

function telegramPreferenceSummary(telegram) {
  if (telegram.status === "legacy_unavailable") return telegram.unavailableReason;
  if (telegram.status === "reconciliation_pending") return "A current delivery decision has not yet been reconciled.";
  if (telegram.preferencePassed === false) return telegram.reason || "User preference check failed.";
  if (telegram.preferencePassed === true) return `Passed effective threshold ${formatNumber(telegram.effectiveThreshold)}.`;
  return "Preference check was not applicable to this final signal decision.";
}

function telegramStatusLabel(status) {
  return {
    telegram_sent: "Telegram sent",
    telegram_queued: "Telegram queued",
    telegram_failed: "Telegram failed",
    reconciliation_pending: "Telegram reconciliation pending",
    legacy_unavailable: "Legacy Telegram status unavailable"
  }[status] || (/^telegram_blocked_/.test(status || "") ? "Telegram not sent" : label(status));
}

function laterProtectionLabel(reason) {
  if (/duplicate/.test(reason || "")) return "duplicate protection";
  if (/cooldown/.test(reason || "")) return "cooldown protection";
  if (/quarant/.test(reason || "")) return "quarantine policy";
  return label(reason || "a later protection rule").toLowerCase();
}

function compactCheck(item) {
  return {
    stage: item.stage || item.key || null,
    reason: item.reasonCode || item.reason || null,
    explanation: item.explanation || item.message || null
  };
}

function step(key, labelText, status, summary) {
  return { key, label: labelText, status, summary: summary || null };
}

function unavailable(name, legacy) {
  return legacy ? `${name}: Data unavailable for this decision version.` : `${name}: Not recorded.`;
}

function isLegacy(signal) {
  return !signal.decisionVersion || /^legacy_/.test(String(signal.source || ""));
}

function compare(left, right) {
  if (left == null || right == null) return null;
  return normalize(left) === normalize(right);
}

function maybeBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function finite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function array(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function label(value) {
  return String(value || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatNumber(value) {
  return value === null || value === undefined ? "unavailable" : Number(value).toFixed(Number(value) % 1 ? 1 : 0);
}
