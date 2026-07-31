import { appConfig } from "../../config/appConfig.js";
import { inspectStopLoss } from "./signalStopRepairService.js";

const defaultMinimumRiskReward = 1.5;
const pivotWidth = 2;
const targetBufferAtrMultiplier = 0.1;
const targetProgressLimit = 0.7;

export function repairUnrealisticTakeProfit(signal, marketData = {}, options = {}) {
  if (!signal) return signal;

  const existing = readDiagnostics(signal);
  if (existing?.repairSucceeded || existing?.repairAttempted || existing?.repairFailureReason ||
    existing?.targetValidationReason === "original_take_profit_valid") {
    return signal;
  }

  const limits = resolveLimits(signal, marketData, options);
  const original = inspectTakeProfit(signal, marketData, limits);
  if (original.valid) {
    return withDiagnostics(signal, {
      originalTakeProfit: finiteOrNull(signal.takeProfit ?? signal.take_profit),
      originalFailureReason: null,
      repairAttempted: false,
      repairSucceeded: false,
      repairSource: null,
      repairedTakeProfit: null,
      originalRewardDistance: original.rewardDistance,
      repairedRewardDistance: null,
      originalRiskReward: original.riskReward,
      repairedRiskReward: original.riskReward,
      targetValidationReason: "original_take_profit_valid",
      atrMoveRequired: original.atrMoveRequired,
      nearestOpposingStructure: original.nearestOpposingStructure,
      timeframeAtrLimit: limits.maxAtrMultiplier,
      finalResult: "passed",
      repairFailureReason: null
    });
  }

  const baseDiagnostics = {
    originalTakeProfit: finiteOrNull(signal.takeProfit ?? signal.take_profit),
    originalFailureReason: original.reasonCode,
    repairAttempted: false,
    repairSucceeded: false,
    repairSource: null,
    repairedTakeProfit: null,
    originalRewardDistance: original.rewardDistance,
    repairedRewardDistance: null,
    originalRiskReward: original.riskReward,
    repairedRiskReward: null,
    targetValidationReason: original.reasonCode,
    atrMoveRequired: original.atrMoveRequired,
    nearestOpposingStructure: original.nearestOpposingStructure,
    timeframeAtrLimit: limits.maxAtrMultiplier,
    finalResult: "failed",
    repairFailureReason: null
  };

  const prerequisiteFailure = getRepairPrerequisiteFailure(signal, marketData, limits, original);
  if (prerequisiteFailure) {
    return withDiagnostics(signal, {
      ...baseDiagnostics,
      repairFailureReason: prerequisiteFailure,
      targetValidationReason: prerequisiteFailure
    });
  }

  const direction = normalizeDirection(signal.direction);
  const entry = Number(signal.entryPrice ?? signal.entry);
  const stop = Number(signal.stopLoss ?? signal.stop_loss);
  const stopDistance = Math.abs(entry - stop);
  const candles = readCandles(marketData);
  const candidates = collectTargetCandidates(signal, marketData, candles, {
    direction,
    entry,
    stopDistance,
    ...limits
  });
  const reachable = candidates
    .map((candidate) => normalizeTargetCandidate(candidate, {
      direction,
      entry,
      stopDistance,
      marketData,
      ...limits
    }))
    .filter(Boolean)
    .sort((left, right) => left.priority - right.priority || left.rewardDistance - right.rewardDistance);
  const validCandidate = reachable.find((candidate) => candidate.riskReward >= limits.minimumRiskReward);

  if (!validCandidate) {
    const bestReachable = [...reachable].sort((left, right) => right.riskReward - left.riskReward)[0] || null;
    const failureReason = bestReachable
      ? "repaired_take_profit_breaks_rr_requirement"
      : "no_realistic_target_available";
    return withDiagnostics(signal, {
      ...baseDiagnostics,
      repairAttempted: true,
      repairSource: bestReachable?.source || null,
      repairedTakeProfit: bestReachable?.takeProfit ?? null,
      repairedRewardDistance: bestReachable?.rewardDistance ?? null,
      repairedRiskReward: bestReachable?.riskReward ?? null,
      targetValidationReason: failureReason,
      repairFailureReason: failureReason
    });
  }

  const repairedRiskReward = Number(validCandidate.riskReward.toFixed(2));
  const diagnostics = {
    ...baseDiagnostics,
    repairAttempted: true,
    repairSucceeded: true,
    repairSource: validCandidate.source,
    repairedTakeProfit: validCandidate.takeProfit,
    repairedRewardDistance: validCandidate.rewardDistance,
    repairedRiskReward,
    targetValidationReason: "repaired_take_profit_valid",
    finalResult: "passed",
    repairFailureReason: null
  };

  return withDiagnostics({
    ...signal,
    takeProfit: validCandidate.takeProfit,
    take_profit: validCandidate.takeProfit,
    riskRewardRatio: repairedRiskReward,
    riskReward: repairedRiskReward,
    riskPlan: {
      ...(signal.riskPlan || {}),
      takeProfit: validCandidate.takeProfit,
      rewardDistance: validCandidate.rewardDistance,
      riskRewardRatio: repairedRiskReward,
      availableR: repairedRiskReward,
      tradeAllowed: (signal.riskPlan?.tradeAllowed ?? true) && repairedRiskReward >= limits.minimumRiskReward
    },
    indicators: {
      ...(signal.indicators || {}),
      takeProfitRecalculated: true,
      originalTakeProfit: baseDiagnostics.originalTakeProfit,
      takeProfitRecalculationReason: targetReason(validCandidate.source)
    }
  }, diagnostics);
}

export function inspectTakeProfit(signal, marketData = {}, options = {}) {
  const limits = options.maxAtrMultiplier
    ? options
    : resolveLimits(signal, marketData, options);
  const direction = normalizeDirection(signal?.direction);
  const entry = Number(signal?.entryPrice ?? signal?.entry);
  const stop = Number(signal?.stopLoss ?? signal?.stop_loss);
  const takeProfit = Number(signal?.takeProfit ?? signal?.take_profit);
  const current = Number(
    signal?.currentPrice ??
    signal?.indicators?.currentPrice ??
    marketData?.currentPrice ??
    readCandles(marketData).at(-1)?.close
  );
  const stopDistance = Math.abs(entry - stop);
  const rewardDistance = Math.abs(takeProfit - entry);
  const riskReward = stopDistance > 0 ? rewardDistance / stopDistance : null;
  const atrMoveRequired = Number.isFinite(limits.atr) && limits.atr > 0
    ? rewardDistance / limits.atr
    : null;
  const nearestOpposingStructure = findNearestOpposingStructure(
    signal,
    marketData,
    readCandles(marketData),
    direction,
    entry
  );
  const details = {
    rewardDistance: finiteOrNull(rewardDistance),
    riskReward: finiteOrNull(riskReward),
    atrMoveRequired: finiteOrNull(atrMoveRequired),
    nearestOpposingStructure: finiteOrNull(nearestOpposingStructure)
  };

  if (!Number.isFinite(entry) || entry <= 0) return invalidTarget("invalid_entry", details);
  if (!Number.isFinite(takeProfit) || takeProfit <= 0 || rewardDistance <= 0) {
    return invalidTarget("missing_take_profit", details);
  }
  if (!["long", "short"].includes(direction) ||
    (direction === "long" && takeProfit <= entry) ||
    (direction === "short" && takeProfit >= entry)) {
    return invalidTarget("target_wrong_side_of_entry", details);
  }
  if (hasPriceReachedTargetArea(entry, takeProfit, current, direction)) {
    return invalidTarget("price_already_near_target", details);
  }
  if (Number.isFinite(limits.atr) && limits.atr > 0 &&
    rewardDistance > limits.atr * limits.maxAtrMultiplier) {
    return invalidTarget("tp_too_far_for_timeframe", details);
  }
  if (crossesOpposingStructure(takeProfit, nearestOpposingStructure, entry, direction)) {
    return invalidTarget(direction === "long" ? "tp_blocked_by_resistance" : "tp_blocked_by_support", details);
  }
  return { valid: true, reasonCode: null, ...details };
}

export function getTakeProfitAtrLimit(timeframe) {
  const configured = appConfig.signals.takeProfitMaxAtrMultipliers || {};
  return Number(configured[timeframe] ?? ({ "1m": 3, "5m": 4, "15m": 5, "1h": 7, "4h": 10 }[timeframe] || 5));
}

function getRepairPrerequisiteFailure(signal, marketData, limits, original) {
  const direction = normalizeDirection(signal.direction);
  const entry = Number(signal.entryPrice ?? signal.entry);
  const stop = Number(signal.stopLoss ?? signal.stop_loss);
  const entryQuality = normalizeText(signal.entryQuality || signal.indicators?.entryQuality);

  if (!Number.isFinite(entry) || entry <= 0 || !["long", "short"].includes(direction)) return "invalid_entry";
  if (["poor", "invalid", "invalid-entry"].includes(entryQuality)) return "invalid_entry";
  if (!Number.isFinite(stop) || stop <= 0 ||
    (direction === "long" && stop >= entry) ||
    (direction === "short" && stop <= entry)) {
    return "invalid_stop_loss";
  }
  if (!inspectStopLoss(signal, marketData).valid) return "invalid_stop_loss";
  if (["missing_take_profit", "target_wrong_side_of_entry"].includes(original.reasonCode)) {
    return original.reasonCode;
  }
  if (original.reasonCode === "price_already_near_target") return original.reasonCode;
  if (!Number.isFinite(limits.atr) || limits.atr <= 0) return "atr_unavailable";
  const candles = readCandles(marketData);
  if (candles.length < 5) return "missing_candle_data";
  if (!hasFreshCandles(candles, signal.timeframe, marketData)) return "stale_candle_data";
  return null;
}

function collectTargetCandidates(signal, marketData, candles, context) {
  const { direction, entry, atr, maxAtrMultiplier } = context;
  const strategy = normalizeText(signal.setupType || signal.strategy);
  const pattern = signal.patternContext?.keyLevels ||
    signal.indicators?.patternContext?.keyLevels ||
    {};
  const structure = signal.marketStructure || {};
  const riskPlan = signal.riskPlan || {};
  const levels = readLevels(signal, marketData);
  const range = readRange(candles);
  const candidates = [];
  const add = (value, source, priority, structureTarget = false) => {
    const price = readLevelPrice(value);
    if (!Number.isFinite(price) || price <= 0) return;
    if (direction === "long" ? price <= entry : price >= entry) return;
    if (candidates.some((item) => item.source === source && nearlyEqual(item.price, price))) return;
    candidates.push({ price, source, priority, structureTarget });
  };
  const opposing = (longValues, shortValues, source, priority, structureTarget = true) => {
    for (const value of direction === "long" ? longValues : shortValues) {
      add(value, source, priority, structureTarget);
    }
  };

  if (/breakout-retest|support-resistance-retest/.test(strategy)) {
    opposing(
      [structure.nextResistance, riskPlan.nextResistance, pattern.resistance, levels.resistance],
      [structure.nextSupport, riskPlan.nextSupport, pattern.support, levels.support],
      direction === "long" ? "nearest_resistance" : "nearest_support",
      1
    );
    add(measuredPatternTarget(signal, direction, entry), "pattern_measured_move", 2);
  }
  if (/double-bottom|double-top|head-and-shoulders|inverse-head-and-shoulders/.test(strategy)) {
    add(measuredPatternTarget(signal, direction, entry), "pattern_measured_move", 1);
    opposing([pattern.neckline, pattern.resistance], [pattern.neckline, pattern.support], "pattern_measured_move", 2, true);
  }
  if (/liquidity-sweep/.test(strategy)) {
    opposing([range.high, pattern.resistance], [range.low, pattern.support], "liquidity_target", 1);
  }
  if (/momentum-breakout/.test(strategy)) {
    opposing([levels.resistance, pattern.resistance], [levels.support, pattern.support], direction === "long" ? "nearest_resistance" : "nearest_support", 1);
    add(direction === "long" ? entry + atr * maxAtrMultiplier : entry - atr * maxAtrMultiplier, "atr_projection", 3);
  }

  opposing(
    [structure.nextResistance, riskPlan.nextResistance, levels.resistance, pattern.resistance],
    [structure.nextSupport, riskPlan.nextSupport, levels.support, pattern.support],
    direction === "long" ? "nearest_resistance" : "nearest_support",
    4
  );
  for (const swing of detectRecentConfirmedTargets(candles, direction, entry)) {
    add(swing.price, "recent_swing", 5, true);
  }
  opposing([range.high], [range.low], "range_boundary", 6);
  add(readLiquidityTarget(signal, marketData, direction, entry), "liquidity_target", 7, true);
  add(measuredPatternTarget(signal, direction, entry), "pattern_measured_move", 8);

  const historicalDistance = historicalTimeframeMove(candles, atr, maxAtrMultiplier, signal.timeframe);
  if (Number.isFinite(historicalDistance)) {
    add(direction === "long" ? entry + historicalDistance : entry - historicalDistance, "historical_timeframe_move", 9);
  }
  add(direction === "long" ? entry + atr * maxAtrMultiplier : entry - atr * maxAtrMultiplier, "atr_projection", 10);
  return candidates;
}

function normalizeTargetCandidate(candidate, context) {
  const {
    direction,
    entry,
    stopDistance,
    atr,
    maxAtrMultiplier,
    marketData,
    nearestOpposingStructure
  } = context;
  const opposingStructure = Number.isFinite(nearestOpposingStructure)
    ? nearestOpposingStructure
    : findNearestOpposingStructure(null, marketData, readCandles(marketData), direction, entry);
  const buffer = atr * targetBufferAtrMultiplier;
  let target = candidate.structureTarget
    ? direction === "long" ? candidate.price - buffer : candidate.price + buffer
    : candidate.price;

  if (crossesOpposingStructure(target, opposingStructure, entry, direction)) {
    return null;
  }
  target = roundTargetInward(target, direction, marketData, entry);
  const rewardDistance = Math.abs(target - entry);
  if (!Number.isFinite(target) || target <= 0 || rewardDistance <= 0) return null;
  if (direction === "long" ? target <= entry : target >= entry) return null;
  if (rewardDistance > atr * maxAtrMultiplier + priceTolerance(entry)) return null;

  const current = Number(marketData?.currentPrice ?? readCandles(marketData).at(-1)?.close);
  if (hasPriceReachedTargetArea(entry, target, current, direction)) return null;
  const riskReward = rewardDistance / stopDistance;
  if (!Number.isFinite(riskReward)) return null;
  return {
    ...candidate,
    takeProfit: target,
    rewardDistance,
    riskReward
  };
}

function findNearestOpposingStructure(signal, marketData, candles, direction, entry) {
  const pattern = signal?.patternContext?.keyLevels ||
    signal?.indicators?.patternContext?.keyLevels ||
    {};
  const structure = signal?.marketStructure || {};
  const riskPlan = signal?.riskPlan || {};
  const levels = readLevels(signal, marketData);
  const strategy = normalizeText(signal?.setupType || signal?.strategy);
  const includeRangeBoundary = /range|liquidity-sweep/.test(strategy);
  const range = includeRangeBoundary ? readRange(candles) : { high: null, low: null };
  const values = direction === "long"
    ? [structure.nextResistance, riskPlan.nextResistance, levels.resistance, pattern.resistance, range.high]
    : [structure.nextSupport, riskPlan.nextSupport, levels.support, pattern.support, range.low];
  const prices = values
    .map(readLevelPrice)
    .filter((price) => Number.isFinite(price) && (direction === "long" ? price > entry : price < entry));
  if (!prices.length) return null;
  return direction === "long" ? Math.min(...prices) : Math.max(...prices);
}

function measuredPatternTarget(signal, direction, entry) {
  const pattern = signal.patternContext?.keyLevels ||
    signal.indicators?.patternContext?.keyLevels ||
    {};
  const support = readLevelPrice(pattern.support);
  const resistance = readLevelPrice(pattern.resistance);
  const neckline = readLevelPrice(pattern.neckline);
  const breakout = readLevelPrice(pattern.breakoutLevel);
  const setup = normalizeText(signal.setupType || signal.strategy || signal.patternContext?.pattern);

  if (/double-bottom|inverse-head-and-shoulders/.test(setup) &&
    Number.isFinite(neckline) && Number.isFinite(support)) {
    return neckline + Math.abs(neckline - support);
  }
  if (/double-top|head-and-shoulders/.test(setup) &&
    Number.isFinite(neckline) && Number.isFinite(resistance)) {
    return neckline - Math.abs(resistance - neckline);
  }
  if (Number.isFinite(support) && Number.isFinite(resistance)) {
    const base = Number.isFinite(breakout) ? breakout : entry;
    const height = Math.abs(resistance - support);
    return direction === "long" ? base + height : base - height;
  }
  return null;
}

function detectRecentConfirmedTargets(candles, direction, entry) {
  const targets = [];
  const recent = candles.slice(-48);
  for (let index = pivotWidth; index < recent.length - pivotWidth; index += 1) {
    const candle = recent[index];
    const left = recent.slice(index - pivotWidth, index);
    const right = recent.slice(index + 1, index + pivotWidth + 1);
    if (direction === "long" &&
      Number(candle.high) > entry &&
      left.every((item) => Number(candle.high) > Number(item.high)) &&
      right.every((item) => Number(candle.high) > Number(item.high))) {
      targets.push({ price: Number(candle.high), index });
    }
    if (direction === "short" &&
      Number(candle.low) < entry &&
      left.every((item) => Number(candle.low) < Number(item.low)) &&
      right.every((item) => Number(candle.low) < Number(item.low))) {
      targets.push({ price: Number(candle.low), index });
    }
  }
  return targets.sort((left, right) => right.index - left.index).slice(0, 4);
}

function readLiquidityTarget(signal, marketData, direction, entry) {
  const values = [
    signal.smc?.liquidityTarget,
    signal.indicators?.smc?.liquidityTarget,
    marketData?.smc?.liquidityTarget,
    ...(marketData?.volumeProfile?.highVolumeNodes || [])
  ];
  const prices = values
    .map(readLevelPrice)
    .filter((price) => Number.isFinite(price) && (direction === "long" ? price > entry : price < entry));
  if (!prices.length) return null;
  return direction === "long" ? Math.min(...prices) : Math.max(...prices);
}

function historicalTimeframeMove(candles, atr, maxAtrMultiplier, timeframe) {
  const ranges = candles.slice(-48).map((candle) => Number(candle.high) - Number(candle.low)).filter((value) => value > 0);
  if (!ranges.length || !Number.isFinite(atr) || atr <= 0) return null;
  const averageRange = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  const projection = { "5m": 2.5, "15m": 3, "1h": 4, "4h": 5 }[timeframe] || 3;
  return Math.min(averageRange * projection, atr * maxAtrMultiplier);
}

function resolveLimits(signal, marketData, options = {}) {
  const atr = Number(
    options.atr ??
    signal?.indicators?.atr14 ??
    signal?.fullAnalysis?.indicators?.atr14 ??
    marketData?.regime?.metrics?.atr14 ??
    marketData?.indicators?.atr14
  );
  const maxAtrMultiplier = Number(options.maxAtrMultiplier ?? getTakeProfitAtrLimit(signal?.timeframe));
  const minimumRiskReward = Number(options.minimumRiskReward ?? defaultMinimumRiskReward);
  return {
    atr,
    maxAtrMultiplier,
    minimumRiskReward,
    nearestOpposingStructure: findNearestOpposingStructure(
      signal,
      marketData,
      readCandles(marketData),
      normalizeDirection(signal?.direction),
      Number(signal?.entryPrice ?? signal?.entry)
    )
  };
}

function withDiagnostics(signal, diagnostics) {
  const normalized = {
    ...diagnostics,
    originalRewardDistance: roundDiagnostic(diagnostics.originalRewardDistance),
    repairedRewardDistance: roundDiagnostic(diagnostics.repairedRewardDistance),
    originalRiskReward: roundDiagnostic(diagnostics.originalRiskReward),
    repairedRiskReward: roundDiagnostic(diagnostics.repairedRiskReward),
    atrMoveRequired: roundDiagnostic(diagnostics.atrMoveRequired)
  };
  Object.assign(normalized, {
    original_take_profit: normalized.originalTakeProfit,
    repaired_take_profit: normalized.repairedTakeProfit,
    take_profit_repair_attempted: normalized.repairAttempted,
    take_profit_repair_succeeded: normalized.repairSucceeded,
    take_profit_repair_source: normalized.repairSource,
    original_reward_distance: normalized.originalRewardDistance,
    repaired_reward_distance: normalized.repairedRewardDistance,
    original_rr: normalized.originalRiskReward,
    repaired_rr: normalized.repairedRiskReward,
    target_validation_reason: normalized.targetValidationReason
  });
  return {
    ...signal,
    originalTakeProfit: normalized.originalTakeProfit,
    repairedTakeProfit: normalized.repairedTakeProfit,
    takeProfitRepairAttempted: normalized.repairAttempted,
    takeProfitRepairSucceeded: normalized.repairSucceeded,
    takeProfitRepairSource: normalized.repairSource,
    originalRewardDistance: normalized.originalRewardDistance,
    repairedRewardDistance: normalized.repairedRewardDistance,
    targetValidationReason: normalized.targetValidationReason,
    takeProfitRepairDiagnostics: normalized,
    indicators: {
      ...(signal.indicators || {}),
      takeProfitRepairDiagnostics: normalized
    }
  };
}

function readDiagnostics(signal) {
  return signal?.takeProfitRepairDiagnostics || signal?.indicators?.takeProfitRepairDiagnostics || null;
}

function readLevels(signal, marketData) {
  return {
    support: signal?.indicators?.support ??
      signal?.patternContext?.keyLevels?.support ??
      marketData?.levels?.support ??
      marketData?.levels?.nearestSupport,
    resistance: signal?.indicators?.resistance ??
      signal?.patternContext?.keyLevels?.resistance ??
      marketData?.levels?.resistance ??
      marketData?.levels?.nearestResistance
  };
}

function readRange(candles) {
  const recent = candles.slice(-32);
  if (!recent.length) return { high: null, low: null };
  return {
    high: Math.max(...recent.map((candle) => Number(candle.high))),
    low: Math.min(...recent.map((candle) => Number(candle.low)))
  };
}

function readCandles(marketData) {
  const candles = marketData?.candles || marketData?.primary?.candles || [];
  return candles.filter((candle) =>
    [candle?.open, candle?.high, candle?.low, candle?.close].every((value) => Number.isFinite(Number(value)))
  );
}

function hasFreshCandles(candles, timeframe, marketData) {
  if (marketData?.marketStatus?.stale === true || marketData?.marketStatus?.code === "DELAYED") return false;
  if (marketData?.marketStatus?.stale === false) return true;
  const latestTime = toEpochMs(candles.at(-1)?.time);
  if (!Number.isFinite(latestTime)) return false;
  const timeframeMs = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000
  }[timeframe] || 900_000;
  return Date.now() - latestTime <= timeframeMs * 2.5;
}

function hasPriceReachedTargetArea(entry, target, current, direction) {
  if (![entry, target, current].every(Number.isFinite)) return false;
  const total = Math.abs(target - entry);
  if (total <= 0) return false;
  const moved = direction === "long" ? current - entry : entry - current;
  return moved > 0 && moved / total >= targetProgressLimit;
}

function crossesOpposingStructure(target, structure, entry, direction) {
  if (![target, structure, entry].every(Number.isFinite)) return false;
  return direction === "long"
    ? structure > entry && target > structure
    : structure < entry && target < structure;
}

function roundTargetInward(value, direction, marketData, entry) {
  const tickSize = Number(
    marketData?.pair?.priceIncrement ??
    marketData?.pair?.tickSize ??
    marketData?.priceIncrement
  );
  if (Number.isFinite(tickSize) && tickSize > 0) {
    const ticks = direction === "long"
      ? Math.floor(value / tickSize)
      : Math.ceil(value / tickSize);
    return Number((ticks * tickSize).toFixed(decimalPlaces(tickSize)));
  }
  const decimals = priceDecimals(entry);
  const factor = 10 ** decimals;
  const rounded = direction === "long"
    ? Math.floor(value * factor) / factor
    : Math.ceil(value * factor) / factor;
  return Number(rounded.toFixed(decimals));
}

function targetReason(source) {
  const labels = {
    nearest_support: "Target moved before nearby support.",
    nearest_resistance: "Target moved before nearby resistance.",
    recent_swing: "Target moved to a recent confirmed swing.",
    range_boundary: "Target moved to the reachable range boundary.",
    pattern_measured_move: "Target moved to the strategy pattern objective.",
    atr_projection: "Target reduced to the timeframe ATR limit.",
    liquidity_target: "Target moved to the next liquidity area.",
    historical_timeframe_move: "Target reduced to the historical timeframe move."
  };
  return labels[source] || "Target moved to a structurally realistic level.";
}

function invalidTarget(reasonCode, details) {
  return { valid: false, reasonCode, ...details };
}

function readLevelPrice(value) {
  if (value && typeof value === "object") return finiteOrNull(value.price ?? value.level ?? value.value);
  return finiteOrNull(value);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundDiagnostic(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(8)) : null;
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) <= Math.max(Math.abs(left), Math.abs(right), 1) * 1e-9;
}

function priceTolerance(value) {
  return Math.max(Math.abs(Number(value)) * 1e-10, Number.EPSILON);
}

function priceDecimals(value) {
  const price = Math.abs(Number(value));
  if (price >= 1000) return 2;
  if (price >= 1) return 4;
  if (price >= 0.01) return 6;
  return 8;
}

function decimalPlaces(value) {
  const text = String(value);
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.split(".")[1].length : 0;
}

function toEpochMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDirection(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
