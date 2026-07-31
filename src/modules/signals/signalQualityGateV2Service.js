import {
  inspectStopLoss,
  repairInvalidStopLoss
} from "./signalStopRepairService.js";
import {
  inspectTakeProfit,
  repairUnrealisticTakeProfit
} from "./signalTakeProfitRepairService.js";

export { repairUnrealisticTakeProfit };

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

  if (!signal) {
    return buildGate({ passed: false, status: "rejected", reasonCode: "missing_signal", explanation: "No setup was available for final quality review.", checks });
  }

  const initialReadings = readSignalNumbers(signal, marketData);
  const strategyCheck = validateStrategyIdentity(signal);
  const entryCheck = validateEntryQuality(signal, marketData, initialReadings);
  const evaluatedSignal = strategyCheck.passed && entryCheck.passed
    ? repairInvalidStopLoss(signal, marketData, { minimumRiskReward })
    : signal;
  const attemptedStrategy = evaluatedSignal.setupType || evaluatedSignal.strategy || "Unknown strategy";
  const readings = readSignalNumbers(evaluatedSignal, marketData);
  addCheck(checks, strategyCheck);
  addCheck(checks, validateMarketRegime(evaluatedSignal, marketData));
  addCheck(checks, entryCheck);
  addCheck(checks, validateStopLossQuality(evaluatedSignal, marketData, readings));
  addCheck(checks, validateTakeProfitRealism(evaluatedSignal, marketData, readings));
  addCheck(checks, validateRiskReward(evaluatedSignal, readings));
  addCheck(checks, validateVolumeConfirmation(evaluatedSignal, marketData));
  addCheck(checks, validateHigherTimeframe(evaluatedSignal));
  addCheck(checks, validateHistoricalContext(evaluatedSignal, context));
  addCheck(checks, validateSimilarityContext(evaluatedSignal, context));
  addCheck(checks, validateRepeatedMistakes(evaluatedSignal, context));

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
      attemptedStrategy,
      adjustedSignal: evaluatedSignal
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
    similarityToWinners: getSimilarity(evaluatedSignal, context, "winners"),
    similarityToLosers: getSimilarity(evaluatedSignal, context, "losers"),
    nearestWinningExamples: getNearestExamples(evaluatedSignal, context, "winning"),
    nearestLosingExamples: getNearestExamples(evaluatedSignal, context, "losing"),
    adjustedSignal: evaluatedSignal
  });
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
  const inspection = inspectStopLoss(signal, marketData);
  const diagnostics = signal.stopRepairDiagnostics || signal.indicators?.stopRepairDiagnostics || null;
  if (inspection.valid) {
    return {
      ...pass("stop_loss_quality", diagnostics?.repairSucceeded
        ? "Stop loss was repaired using structural invalidation and remains within ATR distance limits."
        : "Stop loss is directionally valid and structurally reasonable."),
      stopRepair: diagnostics
    };
  }

  const reasonCode = diagnostics?.repairFailureReason || inspection.reasonCode;
  const explanations = {
    zero_or_missing_stop_distance: "Stop loss is missing or creates zero stop distance.",
    stop_wrong_side_of_entry: readings.direction === "long"
      ? "Long signal stop loss must be below entry."
      : "Short signal stop loss must be above entry.",
    stop_inside_noise: "Stop loss remains inside normal candle noise.",
    stop_too_tight: "Stop loss is too tight compared with current ATR and normal candle noise.",
    stop_too_wide: "No structurally valid stop exists within the maximum ATR distance.",
    no_structural_stop_available: "No structural invalidation level is available for a safe stop repair.",
    repaired_stop_breaks_rr_requirement: `The repaired structural stop reduces risk/reward below the existing ${minimumRiskReward}R minimum.`,
    missing_candle_data: "Stop repair requires enough recent candles to confirm market structure.",
    stale_candle_data: "Stop repair was not attempted because the available candle data is stale.",
    atr_unavailable: "Stop repair requires a valid ATR value.",
    invalid_entry: "Stop repair cannot rescue an invalid entry.",
    invalid_trade_direction: "Stop repair cannot proceed because the entry and target direction are invalid.",
    stop_not_structural: "Stop loss is not protected by recent structure, support/resistance, or an ATR buffer."
  };
  return fail(
    "stop_loss_quality",
    "invalid_stop_loss",
    reasonCode,
    explanations[reasonCode] || "Stop loss is not structurally valid and could not be repaired safely.",
    ["zero_or_missing_stop_distance", "stop_wrong_side_of_entry"].includes(inspection.reasonCode) ? "critical" : "high",
    { stopRepair: diagnostics }
  );
}

function validateTakeProfitRealism(signal, marketData, readings) {
  const inspection = inspectTakeProfit(signal, marketData, { minimumRiskReward });
  const diagnostics = signal.takeProfitRepairDiagnostics || signal.indicators?.takeProfitRepairDiagnostics || null;
  if (inspection.valid) {
    return {
      ...pass(
        "take_profit_realism",
        diagnostics?.repairSucceeded
          ? "Take profit was repaired to a reachable structural target and still meets the existing risk/reward minimum."
          : "Take profit has realistic room for the timeframe."
      ),
      takeProfitRepair: diagnostics
    };
  }

  const reasonCode = diagnostics?.repairFailureReason || inspection.reasonCode;
  const explanations = {
    invalid_entry: "Take-profit repair cannot rescue an invalid entry.",
    invalid_stop_loss: "Take-profit validation requires a final valid stop loss.",
    missing_take_profit: "Take profit is missing or not directionally usable.",
    target_wrong_side_of_entry: readings.direction === "long"
      ? "Long signal take profit must be above entry."
      : "Short signal take profit must be below entry.",
    price_already_near_target: "Price has already moved too close to the available target.",
    tp_too_far_for_timeframe: "Take profit requires a move that is too large for current timeframe volatility.",
    tp_blocked_by_resistance: "Take profit is blocked by nearby resistance before enough reward is available.",
    tp_blocked_by_support: "Take profit is blocked by nearby support before enough reward is available.",
    atr_unavailable: "Take-profit repair requires a valid ATR value.",
    missing_candle_data: "Take-profit repair requires enough recent candles to confirm a realistic target.",
    stale_candle_data: "Take-profit repair was not attempted because the available candle data is stale.",
    no_realistic_target_available: "No reachable structural or volatility-supported take-profit target is available.",
    repaired_take_profit_breaks_rr_requirement: `The nearest realistic target produces risk/reward below the existing ${minimumRiskReward}R minimum.`
  };
  return fail(
    "take_profit_realism",
    "unrealistic_take_profit",
    reasonCode,
    explanations[reasonCode] || "Take profit is not realistic and could not be repaired safely.",
    ["missing_take_profit", "target_wrong_side_of_entry", "invalid_entry"].includes(inspection.reasonCode) ? "critical" : "high",
    { takeProfitRepair: diagnostics }
  );
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
  const exactEvidence = layer === "exact_strategy_pair_timeframe_direction_regime" ||
    (layer === "exact_strategy_pair_timeframe_regime" && Boolean(historical.direction || stats.direction));
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
