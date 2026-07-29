const minimumRiskReward = 1.5;
const readyEntryLabels = new Set(["excellent_entry", "acceptable_entry"]);
const severeStatuses = new Set([
  "rejected",
  "avoid_trade",
  "weak_strategy_match",
  "poor_entry_quality",
  "invalid_stop_loss",
  "unrealistic_take_profit",
  "weak_risk_reward",
  "bad_market_regime",
  "historical_underperformer",
  "similar_to_past_losers"
]);

export function evaluateSignalQualityGateV2(signal, context = {}) {
  const checks = [];
  const marketData = context.marketData || {};
  const attemptedStrategy = signal?.setupType || signal?.strategy || "Unknown strategy";

  if (!signal) {
    return buildGate({ passed: false, status: "rejected", reasonCode: "missing_signal", explanation: "No setup was available for final quality review.", checks });
  }

  const readings = readSignalNumbers(signal, marketData);
  addCheck(checks, validateStrategyIdentity(signal));
  addCheck(checks, validateMarketRegime(signal, marketData));
  addCheck(checks, validateEntryQuality(signal, marketData, readings));
  addCheck(checks, validateStopLossQuality(signal, marketData, readings));
  addCheck(checks, validateTakeProfitRealism(signal, marketData, readings));
  addCheck(checks, validateRiskReward(signal, readings));
  addCheck(checks, validateVolumeConfirmation(signal, marketData));
  addCheck(checks, validateHigherTimeframe(signal));
  addCheck(checks, validateHistoricalContext(signal, context));
  addCheck(checks, validateSimilarityContext(signal, context));
  addCheck(checks, validateRepeatedMistakes(signal, context));

  const failed = checks.filter((item) => item.passed === false);
  if (!failed.length) {
    return buildGate({
      passed: true,
      status: "passed",
      reasonCode: "quality_gate_passed",
      explanation: "Final quality gate passed.",
      userExplanation: "SignalForge found a clean enough setup after checking strategy fit, entry quality, risk/reward, and market context.",
      checks,
      entryQualityLabel: checks.find((item) => item.stage === "entry_quality")?.entryQualityLabel || "acceptable_entry",
      attemptedStrategy
    });
  }

  const primary = failed.sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0];
  return buildGate({
    passed: false,
    status: primary.status,
    reasonCode: primary.reasonCode,
    explanation: primary.explanation,
    userExplanation: publicExplanation(primary),
    checks,
    entryQualityLabel: checks.find((item) => item.stage === "entry_quality")?.entryQualityLabel || "invalid_entry",
    attemptedStrategy,
    similarityToWinners: getSimilarity(signal, context, "winners"),
    similarityToLosers: getSimilarity(signal, context, "losers"),
    nearestWinningExamples: getNearestExamples(signal, context, "winning"),
    nearestLosingExamples: getNearestExamples(signal, context, "losing")
  });
}

export function repairUnrealisticTakeProfit(signal, marketData = {}) {
  if (!signal) return signal;
  const readings = readSignalNumbers(signal, marketData);
  const { entry, stop, takeProfit, direction, atr, stopDistance, rewardDistance } = readings;
  if (![entry, stop, takeProfit].every(Number.isFinite) || stopDistance <= 0) return signal;
  if (direction === "long" && (stop >= entry || takeProfit <= entry)) return signal;
  if (direction === "short" && (stop <= entry || takeProfit >= entry)) return signal;
  if (Number.isFinite(atr) && atr > 0 && (stopDistance < atr * 0.35 || stopDistance > atr * 3.5)) return signal;

  const targetTooFar = Number.isFinite(atr) && atr > 0 &&
    rewardDistance > atr * timeframeTargetAtrLimit(signal.timeframe);
  const targetBlocked = isTargetBlocked(signal, marketData, readings);
  if (!targetTooFar && !targetBlocked) return signal;

  const targetCandidates = [];
  if (targetTooFar) {
    const atrDistance = atr * timeframeTargetAtrLimit(signal.timeframe);
    targetCandidates.push(direction === "long" ? entry + atrDistance : entry - atrDistance);
  }

  if (targetBlocked) {
    const levels = readLevels(signal, marketData);
    const structure = direction === "long" ? Number(levels.resistance) : Number(levels.support);
    const buffer = Math.max(stopDistance * 0.1, Number.isFinite(atr) && atr > 0 ? atr * 0.1 : 0);
    targetCandidates.push(direction === "long" ? structure - buffer : structure + buffer);
  }

  const minimumRewardDistance = stopDistance * minimumRiskReward;
  const realisticTargets = targetCandidates
    .filter(Number.isFinite)
    .filter((target) => direction === "long" ? target > entry : target < entry)
    .filter((target) => Math.abs(target - entry) >= minimumRewardDistance)
    .sort((left, right) => Math.abs(left - entry) - Math.abs(right - entry));
  const repairedTarget = realisticTargets[0];
  if (!Number.isFinite(repairedTarget)) return signal;

  const repairedRiskReward = Math.abs(repairedTarget - entry) / stopDistance;
  return {
    ...signal,
    takeProfit: repairedTarget,
    take_profit: repairedTarget,
    riskRewardRatio: Number(repairedRiskReward.toFixed(2)),
    riskReward: Number(repairedRiskReward.toFixed(2)),
    indicators: {
      ...(signal.indicators || {}),
      takeProfitRecalculated: true,
      originalTakeProfit: takeProfit,
      takeProfitRecalculationReason: targetBlocked
        ? "Target moved before nearby opposing structure."
        : "Target reduced to the timeframe ATR limit."
    }
  };
}

export function classifySignalMistakeLabels(signal, context = {}) {
  if (!signal || !["Hit SL", "Expired", "Manually closed"].includes(signal.status)) return [];
  const indicators = signal.indicators || {};
  const tags = new Set();
  const gate = indicators.qualityGateV2 || signal.qualityGateV2 || context.qualityGateV2 || {};
  const failedCodes = new Set((gate.checks || []).filter((item) => item.passed === false).map((item) => item.reasonCode));

  if (failedCodes.has("entry_chasing_after_move") || /late|fair|poor/i.test(String(signal.entryQuality || indicators.entryQuality || ""))) tags.add("entered_too_late");
  if (failedCodes.has("stop_too_tight")) tags.add("stop_too_tight");
  if (failedCodes.has("stop_too_wide")) tags.add("stop_too_wide");
  if (failedCodes.has("tp_too_far_for_timeframe") || Number(signal.riskRewardRatio || 0) > 2.4) tags.add("tp_too_far");
  if (/chop|range|sideways/i.test(String(indicators.regime || signal.marketRegime || ""))) tags.add("choppy_market");
  if (/breakout/i.test(String(signal.setupType || "")) && signal.status === "Hit SL") tags.add("false_breakout");
  if (failedCodes.has("breakout_without_retest") || failedCodes.has("retest_too_far_from_level")) tags.add("failed_retest");
  if (failedCodes.has("weak_breakout_volume") || failedCodes.has("missing_volume_confirmation")) tags.add("weak_volume");
  if (failedCodes.has("higher_timeframe_conflict") || signal.alignmentBadge === "Countertrend" || indicators.alignmentBadge === "Countertrend") tags.add("higher_timeframe_conflict");
  if (failedCodes.has("similar_to_past_losers")) tags.add("strategy_misread");
  if (failedCodes.has("low_liquidity") || String(indicators.sessionLiquidity || "").toLowerCase() === "low") tags.add("low_liquidity");
  if (failedCodes.has("entry_chasing_after_move") || Number(indicators.rsi14 || 50) > 72 || Number(indicators.rsi14 || 50) < 28) tags.add("overextended_entry");
  if (failedCodes.has("fake_good_rr") || failedCodes.has("weak_risk_reward")) tags.add("poor_rr_quality");
  if (!tags.size && signal.status === "Hit SL") tags.add("normal_valid_loss");
  if (!tags.size && signal.status === "Expired") tags.add("entry_did_not_develop");
  return [...tags];
}

export function summarizeUserFacingGateReason(gate = {}) {
  return gate.userExplanation || publicExplanation({ status: gate.status, reasonCode: gate.reasonCode });
}

function validateStrategyIdentity(signal) {
  const strategy = normalize(signal.setupType || signal.strategy);
  if (!strategy || strategy === "unknown-strategy" || strategy === "qualified-setup") {
    return fail("strategy_validity", "weak_strategy_match", "missing_strategy", "Strategy is missing or too generic for ready promotion.", "high");
  }

  if (strategy.includes("breakout-retest")) {
    const hasRetest = Boolean(signal.indicators?.retestConfirmed || signal.marketStructure?.retestConfirmed || findConfirmation(signal, /retest|held.*level|broken level/i));
    if (!hasRetest) return fail("strategy_validity", "weak_strategy_match", "breakout_without_retest", "Breakout retest rejected because price has not actually retested and held the broken level.", "high");
    if (!hasVolume(signal)) return fail("strategy_validity", "weak_strategy_match", "weak_breakout_volume", "Breakout retest rejected because volume confirmation is missing.", "medium");
  }

  if (strategy.includes("momentum-breakout")) {
    if (!hasVolume(signal)) return fail("strategy_validity", "weak_strategy_match", "weak_breakout_volume", "Momentum breakout rejected because volume expansion is missing.", "high");
    if (!findConfirmation(signal, /breakout|structure|momentum/i)) return fail("strategy_validity", "weak_strategy_match", "weak_momentum_structure", "Momentum breakout rejected because structure expansion is not clear.", "high");
  }

  return pass("strategy_validity", "Strategy has a specific enough setup definition.");
}

function validateMarketRegime(signal, marketData) {
  const strategy = normalize(signal.setupType || signal.strategy);
  const regime = readRegime(signal, marketData);
  if (/momentum-breakout/.test(strategy) && /range|chop|sideways|unclear/.test(regime)) {
    return fail("market_regime", "bad_market_regime", "momentum_breakout_in_range", "Momentum breakout rejected because the market is range-bound or choppy.", "high");
  }
  if (/trend-continuation|multi-timeframe-continuation/.test(strategy) && hasHigherTimeframeConflict(signal)) {
    return fail("market_regime", "bad_market_regime", "higher_timeframe_conflict", "Trend continuation rejected because higher timeframe context conflicts with the trade direction.", "high");
  }
  if (/range-bounce|mean-reversion/.test(strategy) && !/range|chop|sideways/.test(regime)) {
    return fail("market_regime", "bad_market_regime", "range_strategy_outside_range", "Range strategy rejected because the market is not clearly range-bound.", "medium");
  }
  return pass("market_regime", "Market regime is compatible with the attempted strategy.");
}

function validateEntryQuality(signal, marketData, readings) {
  const readiness = Number(signal.readinessScore ?? signal.entryReadinessScore ?? signal.indicators?.readinessScore ?? 0);
  const rawQuality = normalize(signal.entryQuality || signal.indicators?.entryQuality || "");
  const label = entryLabel(rawQuality, readings, signal, marketData);
  const result = readyEntryLabels.has(label)
    ? pass("entry_quality", "Entry quality is acceptable for ready promotion.")
    : fail("entry_quality", label === "late_entry" ? "poor_entry_quality" : label === "chasing_entry" ? "poor_entry_quality" : "poor_entry_quality", label, entryReason(label), label === "noisy_entry" ? "medium" : "high");
  result.entryQualityLabel = label;
  if (readiness > 0 && readiness < 70 && result.passed) {
    return fail("entry_quality", "poor_entry_quality", "readiness_below_ready_threshold", "Entry readiness is too low for ready promotion.", "high", { entryQualityLabel: "late_entry" });
  }
  return result;
}

function validateStopLossQuality(signal, marketData, readings) {
  const { entry, stop, atr, direction, stopDistance } = readings;
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || stopDistance <= 0) {
    return fail("stop_loss_quality", "invalid_stop_loss", "zero_or_missing_stop_distance", "Stop loss is missing or creates zero stop distance.", "critical");
  }
  if (direction === "long" && stop >= entry) return fail("stop_loss_quality", "invalid_stop_loss", "long_stop_not_below_entry", "Long signal stop loss must be below entry.", "critical");
  if (direction === "short" && stop <= entry) return fail("stop_loss_quality", "invalid_stop_loss", "short_stop_not_above_entry", "Short signal stop loss must be above entry.", "critical");
  if (Number.isFinite(atr) && atr > 0) {
    if (stopDistance < atr * 0.35) return fail("stop_loss_quality", "invalid_stop_loss", "stop_too_tight", "Stop loss is too tight compared with current ATR and normal candle noise.", "high");
    if (stopDistance > atr * 3.5) return fail("stop_loss_quality", "invalid_stop_loss", "stop_too_wide", "Stop loss is too wide for the timeframe and may distort position sizing.", "medium");
  }
  if (isStopNotStructural(signal, marketData, readings)) {
    return fail("stop_loss_quality", "invalid_stop_loss", "stop_not_structural", "Stop loss is not protected by recent structure, support/resistance, or an ATR buffer.", "high");
  }
  return pass("stop_loss_quality", "Stop loss is directionally valid and structurally reasonable.");
}

function validateTakeProfitRealism(signal, marketData, readings) {
  const { entry, takeProfit, direction, atr, rewardDistance } = readings;
  if (!Number.isFinite(entry) || !Number.isFinite(takeProfit) || rewardDistance <= 0) {
    return fail("take_profit_realism", "unrealistic_take_profit", "missing_take_profit", "Take profit is missing or not directionally usable.", "critical");
  }
  if (direction === "long" && takeProfit <= entry) return fail("take_profit_realism", "unrealistic_take_profit", "long_tp_not_above_entry", "Long signal take profit must be above entry.", "critical");
  if (direction === "short" && takeProfit >= entry) return fail("take_profit_realism", "unrealistic_take_profit", "short_tp_not_below_entry", "Short signal take profit must be below entry.", "critical");
  if (Number.isFinite(atr) && atr > 0 && rewardDistance > atr * timeframeTargetAtrLimit(signal.timeframe)) {
    return fail("take_profit_realism", "unrealistic_take_profit", "tp_too_far_for_timeframe", "Take profit requires a move that is too large for current timeframe volatility.", "high");
  }
  if (isTargetBlocked(signal, marketData, readings)) {
    return fail("take_profit_realism", "unrealistic_take_profit", direction === "long" ? "tp_blocked_by_resistance" : "tp_blocked_by_support", "Take profit is blocked by nearby opposing structure before enough reward is available.", "high");
  }
  return pass("take_profit_realism", "Take profit has realistic room for the timeframe.");
}

function validateRiskReward(signal, readings) {
  const rr = Number(signal.riskRewardRatio ?? signal.riskReward ?? readings.rewardDistance / readings.stopDistance);
  if (!Number.isFinite(rr) || rr < minimumRiskReward) {
    return fail("risk_reward", "weak_risk_reward", "weak_risk_reward", `Risk/reward is below the minimum ${minimumRiskReward}R.`, "high");
  }
  if (rr >= minimumRiskReward && readings.fakeGoodRiskReward) {
    return fail("risk_reward", "weak_risk_reward", "fake_good_rr", "Risk/reward looked good mathematically, but target or stop placement was not realistic.", "high");
  }
  return pass("risk_reward", "Risk/reward clears the final gate.");
}

function validateVolumeConfirmation(signal, marketData) {
  if (marketData?.volumeAvailable === false || marketData?.pair?.category === "Commodities") return pass("volume_confirmation", "Volume is not required for this market/provider.");
  if (hasVolume(signal)) return pass("volume_confirmation", "Volume confirmation is present.");
  return fail("volume_confirmation", "weak_strategy_match", "missing_volume_confirmation", "Volume confirmation is missing, so the setup should be watched instead of promoted.", "medium");
}

function validateHigherTimeframe(signal) {
  if (hasHigherTimeframeConflict(signal)) {
    return fail("higher_timeframe_alignment", "bad_market_regime", "higher_timeframe_conflict", "Higher timeframe alignment conflicts with this setup.", "high");
  }
  return pass("higher_timeframe_alignment", "Higher timeframe context does not conflict.");
}

function validateHistoricalContext(signal, context) {
  const historical = context.historicalStrategy || signal.indicators?.historicalStrategyCalibration || signal.confidenceCalibration?.historicalStrategy || {};
  const stats = historical.stat || historical.stats || {};
  const expectancy = Number(historical.expectancy ?? historical.validationExpectancy ?? stats.expectancy);
  const setups = Number(
    historical.totalSetups ??
    historical.validSetupCount ??
    historical.evidenceSampleSize ??
    stats.totalSetups ??
    stats.validSetupCount ??
    stats.totalTested ??
    0
  );
  const status = normalize(historical.status || historical.walkForwardStatus || "");
  const action = normalize(historical.action || "");
  const layer = normalize(historical.evidenceLayer || "");
  const hardBlock = historical.hardBlockEligible === true || action === "block";
  const exactEvidence = layer === "exact_strategy_pair_timeframe_regime" || historical.evidenceSpecificity === "specific";
  if (hardBlock && exactEvidence && setups >= 30 && Number.isFinite(expectancy) && expectancy < 0) {
    return fail("historical_strategy_performance", "historical_underperformer", "negative_historical_expectancy", "Exact historical strategy evidence is very negative for this setup context.", "medium");
  }
  if (/quarantine|disabled/.test(status) && exactEvidence && setups >= 30) {
    return fail("historical_strategy_performance", "historical_underperformer", "historical_group_quarantined", "Exact historical strategy group is quarantined or disabled with enough evidence.", "medium");
  }
  if (["cap", "watching", "warning"].includes(action) || (setups >= 10 && Number.isFinite(expectancy) && expectancy < 0)) {
    return pass("historical_strategy_performance", "Historical performance reduced or capped confidence, but it does not hard-block this setup.");
  }
  return pass("historical_strategy_performance", setups >= 20 ? "Historical performance is not blocking this setup." : "Historical sample is still limited, so it cannot override validation.");
}

function validateSimilarityContext(signal, context) {
  const losers = getSimilarity(signal, context, "losers");
  const winners = getSimilarity(signal, context, "winners");
  if (Number.isFinite(losers) && Number.isFinite(winners) && losers >= winners + 0.12 && losers >= 0.65) {
    return fail("historical_similarity", "similar_to_past_losers", "similar_to_past_losers", "This setup looks more similar to past failed setups than past winners.", "medium");
  }
  return pass("historical_similarity", "Historical similarity does not block this setup.");
}

function validateRepeatedMistakes(signal, context) {
  const mistakes = context.repeatedMistakes || signal.indicators?.repeatedMistakes || {};
  const worstCount = Math.max(0, ...Object.values(mistakes).map((value) => Number(value || 0)));
  if (worstCount >= 3) {
    return fail("post_trade_mistakes", "historical_underperformer", "repeated_mistake_pattern", "Repeated post-trade mistake labels were found for this strategy context.", "medium");
  }
  return pass("post_trade_mistakes", "No repeated mistake pattern is blocking this setup.");
}

function entryLabel(rawQuality, readings, signal, marketData) {
  if (["excellent", "excellent-entry", "excellent_entry"].includes(rawQuality)) return "excellent_entry";
  if (["good", "acceptable", "acceptable-entry", "acceptable_entry"].includes(rawQuality)) return "acceptable_entry";
  if (["poor", "invalid", "invalid-entry", "invalid_entry"].includes(rawQuality)) return "invalid_entry";
  if (["fair", "late", "late-entry", "late_entry"].includes(rawQuality)) return "late_entry";
  if (priceMovedTowardTargetTooFar(readings)) return "late_entry";
  if (isChasingMove(signal, marketData, readings)) return "chasing_entry";
  if (isInsideNoisyRange(signal, marketData, readings)) return "noisy_entry";
  return "acceptable_entry";
}

function readSignalNumbers(signal, marketData) {
  const entry = Number(signal.entryPrice ?? signal.entry);
  const stop = Number(signal.stopLoss ?? signal.stop_loss);
  const takeProfit = Number(signal.takeProfit ?? signal.take_profit);
  const current = Number(signal.currentPrice ?? signal.indicators?.currentPrice ?? marketData?.currentPrice ?? latestClose(marketData));
  const atr = Number(signal.indicators?.atr14 ?? signal.fullAnalysis?.indicators?.atr14 ?? marketData?.regime?.metrics?.atr14 ?? marketData?.indicators?.atr14);
  const direction = String(signal.direction || "").toLowerCase();
  const stopDistance = Math.abs(entry - stop);
  const rewardDistance = Math.abs(takeProfit - entry);
  return {
    entry,
    stop,
    takeProfit,
    current,
    atr,
    direction,
    stopDistance,
    rewardDistance,
    fakeGoodRiskReward: Boolean(!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(takeProfit) || stopDistance <= 0 || rewardDistance <= 0)
  };
}

function priceMovedTowardTargetTooFar({ entry, takeProfit, current, direction }) {
  if (![entry, takeProfit, current].every(Number.isFinite)) return false;
  const total = Math.abs(takeProfit - entry);
  if (total <= 0) return false;
  const moved = direction === "long" ? current - entry : entry - current;
  return moved / total > 0.55;
}

function isChasingMove(signal, marketData, { entry, atr }) {
  const candle = latestCandle(marketData);
  if (!candle || !Number.isFinite(atr) || atr <= 0) return false;
  const body = Math.abs(Number(candle.close) - Number(candle.open));
  const distanceFromClose = Math.abs(Number(candle.close) - entry);
  return body > atr * 1.4 || distanceFromClose > atr * 1.25 || Boolean(signal.indicators?.overextended);
}

function isInsideNoisyRange(signal, marketData, { entry, atr }) {
  const candle = latestCandle(marketData);
  if (!candle || !Number.isFinite(entry) || !Number.isFinite(atr) || atr <= 0) return false;
  const mid = (Number(candle.high) + Number(candle.low)) / 2;
  return Math.abs(entry - mid) <= atr * 0.15 && /range|chop|sideways/.test(readRegime(signal, marketData));
}

function isStopNotStructural(signal, marketData, { stop, direction, atr }) {
  if (signal.indicators?.stopStructural || signal.marketStructure?.stopStructural || signal.riskPlan?.invalidation) return false;
  const levels = readLevels(signal, marketData);
  if (!Number.isFinite(stop)) return true;
  if (!levels.support && !levels.resistance && !signal.marketStructure?.swingLow && !signal.marketStructure?.swingHigh) return false;
  const buffer = Number.isFinite(atr) && atr > 0 ? atr * 0.15 : 0;
  if (direction === "long") {
    const structural = Number(levels.support ?? signal.marketStructure?.swingLow);
    return Number.isFinite(structural) && stop > structural + buffer;
  }
  const structural = Number(levels.resistance ?? signal.marketStructure?.swingHigh);
  return Number.isFinite(structural) && stop < structural - buffer;
}

function isTargetBlocked(signal, marketData, { entry, takeProfit, direction }) {
  const levels = readLevels(signal, marketData);
  const blocking = direction === "long" ? Number(levels.resistance) : Number(levels.support);
  if (!Number.isFinite(blocking) || !Number.isFinite(entry) || !Number.isFinite(takeProfit)) return false;
  if (direction === "long") return blocking > entry && blocking < takeProfit;
  return blocking < entry && blocking > takeProfit;
}

function readLevels(signal, marketData) {
  return {
    support: finiteOrNull(signal.indicators?.support ?? signal.patternContext?.keyLevels?.support ?? marketData?.levels?.support ?? marketData?.levels?.nearestSupport?.price),
    resistance: finiteOrNull(signal.indicators?.resistance ?? signal.patternContext?.keyLevels?.resistance ?? marketData?.levels?.resistance ?? marketData?.levels?.nearestResistance?.price)
  };
}

function hasHigherTimeframeConflict(signal) {
  const text = [
    signal.alignmentBadge,
    signal.indicators?.alignmentBadge,
    signal.confluence?.alignmentBadge,
    signal.indicators?.higherTimeframeAlignment,
    ...(signal.confirmations || []).filter((item) => item.passed === false).map((item) => `${item.name} ${item.detail || ""}`)
  ].join(" ");
  return /countertrend|higher timeframe conflict|htf conflict|conflicting higher timeframe/i.test(text);
}

function hasVolume(signal) {
  if (signal.indicators?.volumeConfirmed || signal.indicators?.volumeProfileAligned) return true;
  return Boolean(findConfirmation(signal, /volume|participation|liquidity/i)?.passed);
}

function readRegime(signal, marketData) {
  return normalize(signal.indicators?.regime || signal.marketRegime || marketData?.regime?.label || marketData?.analysis?.regime || "");
}

function latestCandle(marketData) {
  const candles = marketData?.candles || marketData?.primary?.candles || [];
  return candles[candles.length - 1] || null;
}

function latestClose(marketData) {
  return latestCandle(marketData)?.close;
}

function timeframeTargetAtrLimit(timeframe) {
  return { "1m": 3, "5m": 4, "15m": 5, "1h": 7, "4h": 10 }[timeframe] || 5;
}

function getSimilarity(signal, context, side) {
  const similarity = context.historicalSimilarity || signal.indicators?.historicalSimilarity || {};
  return Number(side === "winners"
    ? similarity.similarityToWinners ?? similarity.winners
    : similarity.similarityToLosers ?? similarity.losers);
}

function getNearestExamples(signal, context, side) {
  const similarity = context.historicalSimilarity || signal.indicators?.historicalSimilarity || {};
  return similarity[side === "winning" ? "nearestWinningExamples" : "nearestLosingExamples"] || [];
}

function entryReason(label) {
  return {
    late_entry: "Entry is late because price has already moved too far toward the target.",
    chasing_entry: "Entry is chasing after an extended candle or move.",
    noisy_entry: "Entry is inside a noisy range and needs better confirmation.",
    invalid_entry: "Entry quality is invalid for ready promotion."
  }[label] || "Entry quality is not ready.";
}

function publicExplanation(check) {
  const map = {
    weak_strategy_match: "No clean signal yet. SignalForge is waiting for a better confirmed strategy match.",
    poor_entry_quality: "A setup is forming, but the entry is not clean enough right now.",
    invalid_stop_loss: "No clean signal yet. The stop loss is not structurally valid.",
    unrealistic_take_profit: "No clean signal yet. The target does not have realistic room.",
    weak_risk_reward: "No clean signal yet. Risk/reward is not strong enough.",
    bad_market_regime: "No clean signal yet. The strategy does not fit the current market condition.",
    historical_underperformer: "No clean signal yet. Similar strategy conditions have underperformed.",
    similar_to_past_losers: "No clean signal yet. This setup looks too similar to past failed setups."
  };
  return map[check.status] || "No clean signal yet. SignalForge is filtering out weak setups instead of forcing trades.";
}

function pass(stage, explanation) {
  return { stage, passed: true, explanation, severity: "info" };
}

function fail(stage, status, reasonCode, explanation, severity = "medium", extra = {}) {
  return { stage, passed: false, status, reasonCode, explanation, severity, ...extra };
}

function buildGate(input) {
  return {
    version: "quality_gate_v2",
    checkedAt: new Date().toISOString(),
    ...input,
    finalAction: input.passed ? "ready_signal" : actionForStatus(input.status)
  };
}

function addCheck(checks, check) {
  checks.push(check);
}

function actionForStatus(status) {
  if (status === "passed") return "ready_signal";
  if (status === "poor_entry_quality" || status === "weak_strategy_match") return "watching";
  if (status === "bad_market_regime" || status === "weak_risk_reward") return "avoid_trade";
  return severeStatuses.has(status) ? status : "rejected";
}

function findConfirmation(signal, pattern) {
  return (signal.confirmations || signal.fullAnalysis?.confirmations || []).find((item) =>
    pattern.test(`${item.name || ""} ${item.detail || ""} ${item.reason || ""}`)
  );
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function severityRank(severity) {
  return { critical: 5, high: 4, medium: 3, low: 2, info: 1 }[severity] || 0;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
