import { appConfig } from "../../config/appConfig.js";

const defaultMinimumRiskReward = 1.5;
const pivotWidth = 2;

export function repairInvalidStopLoss(signal, marketData = {}, options = {}) {
  if (!signal) return signal;

  const existing = readStopDiagnostics(signal);
  if (existing?.repairSucceeded || existing?.repairAttempted || existing?.repairFailureReason ||
    existing?.stopValidationReason === "original_stop_valid") {
    return signal;
  }

  const limits = resolveStopLimits(options, signal, marketData);
  const original = inspectStopLoss(signal, marketData, limits);
  if (original.valid) {
    return withStopDiagnostics(signal, {
      originalStopLoss: finiteOrNull(signal.stopLoss ?? signal.stop_loss),
      originalFailureReason: null,
      repairAttempted: false,
      repairSucceeded: false,
      repairSource: null,
      repairedStopLoss: null,
      atrBufferUsed: limits.atr * limits.bufferAtrMultiplier,
      originalStopDistance: original.stopDistance,
      repairedStopDistance: null,
      repairedRiskReward: original.riskReward,
      stopValidationReason: "original_stop_valid",
      finalResult: "passed",
      repairFailureReason: null
    });
  }

  const baseDiagnostics = {
    originalStopLoss: finiteOrNull(signal.stopLoss ?? signal.stop_loss),
    originalFailureReason: original.reasonCode,
    repairAttempted: false,
    repairSucceeded: false,
    repairSource: null,
    repairedStopLoss: null,
    atrBufferUsed: limits.atr * limits.bufferAtrMultiplier,
    originalStopDistance: original.stopDistance,
    repairedStopDistance: null,
    repairedRiskReward: null,
    stopValidationReason: original.reasonCode,
    finalResult: "failed",
    repairFailureReason: null
  };

  const prerequisiteFailure = getRepairPrerequisiteFailure(signal, marketData, limits);
  if (prerequisiteFailure) {
    return withStopDiagnostics(signal, {
      ...baseDiagnostics,
      repairFailureReason: prerequisiteFailure
    });
  }

  const direction = normalizeDirection(signal.direction);
  const entry = Number(signal.entryPrice ?? signal.entry);
  const takeProfit = Number(signal.takeProfit ?? signal.take_profit);
  const candles = readCandles(marketData);
  const structuralLevels = collectStructuralStopLevels(signal, marketData, candles, direction);

  if (!structuralLevels.length) {
    return withStopDiagnostics(signal, {
      ...baseDiagnostics,
      repairAttempted: true,
      repairFailureReason: "no_structural_stop_available"
    });
  }

  const repairCandidates = structuralLevels
    .map((level) => buildRepairCandidate(level, {
      direction,
      entry,
      candles,
      marketData,
      ...limits
    }))
    .filter(Boolean)
    .sort((left, right) => left.priority - right.priority || left.stopDistance - right.stopDistance);
  const validCandidate = repairCandidates.find((candidate) =>
    candidate.stopDistance >= limits.minimumDistance &&
    candidate.stopDistance <= limits.maximumDistance
  );

  if (!validCandidate) {
    const allTooWide = repairCandidates.length > 0 &&
      repairCandidates.every((candidate) => candidate.stopDistance > limits.maximumDistance);
    return withStopDiagnostics(signal, {
      ...baseDiagnostics,
      repairAttempted: true,
      repairFailureReason: allTooWide ? "stop_too_wide" : "no_structural_stop_available"
    });
  }

  const repairedRiskReward = Math.abs(takeProfit - entry) / validCandidate.stopDistance;
  const minimumRiskReward = Number(options.minimumRiskReward ?? defaultMinimumRiskReward);
  if (!Number.isFinite(repairedRiskReward) || repairedRiskReward < minimumRiskReward) {
    return withStopDiagnostics(signal, {
      ...baseDiagnostics,
      repairAttempted: true,
      repairSource: validCandidate.source,
      repairedStopLoss: validCandidate.stopLoss,
      repairedStopDistance: validCandidate.stopDistance,
      repairedRiskReward: finiteOrNull(repairedRiskReward),
      stopValidationReason: "repaired_stop_breaks_rr_requirement",
      repairFailureReason: "repaired_stop_breaks_rr_requirement"
    });
  }

  const diagnostics = {
    ...baseDiagnostics,
    repairAttempted: true,
    repairSucceeded: true,
    repairSource: validCandidate.source,
    repairedStopLoss: validCandidate.stopLoss,
    repairedStopDistance: validCandidate.stopDistance,
    repairedRiskReward: Number(repairedRiskReward.toFixed(2)),
    stopValidationReason: "repaired_stop_valid",
    finalResult: "passed",
    repairFailureReason: null
  };

  return withStopDiagnostics({
    ...signal,
    stopLoss: validCandidate.stopLoss,
    stop_loss: validCandidate.stopLoss,
    riskRewardRatio: Number(repairedRiskReward.toFixed(2)),
    riskReward: Number(repairedRiskReward.toFixed(2)),
    riskPlan: {
      ...(signal.riskPlan || {}),
      stopLoss: validCandidate.stopLoss,
      stopDistance: validCandidate.stopDistance,
      stopStyle: `Structural repair (${validCandidate.source})`,
      riskRewardRatio: Number(repairedRiskReward.toFixed(2)),
      availableR: Number(repairedRiskReward.toFixed(2)),
      tradeAllowed: (signal.riskPlan?.tradeAllowed ?? true) && repairedRiskReward >= minimumRiskReward
    },
    indicators: {
      ...(signal.indicators || {}),
      stopStructural: true,
      stopStyle: `Structural repair (${validCandidate.source})`
    }
  }, diagnostics);
}

export function inspectStopLoss(signal, marketData = {}, options = {}) {
  const limits = resolveStopLimits(options, signal, marketData);
  const direction = normalizeDirection(signal?.direction);
  const entry = Number(signal?.entryPrice ?? signal?.entry);
  const stop = Number(signal?.stopLoss ?? signal?.stop_loss);
  const takeProfit = Number(signal?.takeProfit ?? signal?.take_profit);
  const stopDistance = Math.abs(entry - stop);
  const rewardDistance = Math.abs(takeProfit - entry);
  const riskReward = stopDistance > 0 ? rewardDistance / stopDistance : null;

  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stop) || stop <= 0 || stopDistance <= 0) {
    return invalidStop("zero_or_missing_stop_distance", stopDistance, riskReward);
  }
  if (direction === "long" && stop >= entry) {
    return invalidStop("stop_wrong_side_of_entry", stopDistance, riskReward);
  }
  if (direction === "short" && stop <= entry) {
    return invalidStop("stop_wrong_side_of_entry", stopDistance, riskReward);
  }
  if (!["long", "short"].includes(direction)) {
    return invalidStop("stop_wrong_side_of_entry", stopDistance, riskReward);
  }

  const candles = readCandles(marketData);
  if (candles.length && isStopInsideCandleNoise(stop, direction, candles, limits.atr)) {
    return invalidStop("stop_inside_noise", stopDistance, riskReward);
  }
  if (stopDistance < limits.minimumDistance) {
    return invalidStop("stop_too_tight", stopDistance, riskReward);
  }
  if (stopDistance > limits.maximumDistance) {
    return invalidStop("stop_too_wide", stopDistance, riskReward);
  }

  if (!signal?.indicators?.stopStructural && !signal?.marketStructure?.stopStructural) {
    const levels = collectStructuralStopLevels(signal, marketData, candles, direction);
    if (levels.length && !levels.some((level) =>
      protectsStructure(stop, level.price, direction, limits.atr * limits.bufferAtrMultiplier)
    )) {
      return invalidStop("stop_not_structural", stopDistance, riskReward);
    }
  }

  return {
    valid: true,
    reasonCode: null,
    stopDistance,
    riskReward: finiteOrNull(riskReward)
  };
}

function getRepairPrerequisiteFailure(signal, marketData, limits) {
  const direction = normalizeDirection(signal.direction);
  const entry = Number(signal.entryPrice ?? signal.entry);
  const takeProfit = Number(signal.takeProfit ?? signal.take_profit);
  const entryQuality = normalizeText(signal.entryQuality || signal.indicators?.entryQuality);
  const strategy = normalizeText(signal.setupType || signal.strategy);

  if (!Number.isFinite(entry) || entry <= 0 || !["long", "short"].includes(direction)) {
    return "invalid_entry";
  }
  if (["poor", "invalid", "invalid-entry"].includes(entryQuality)) {
    return "invalid_entry";
  }
  if (!Number.isFinite(takeProfit) || takeProfit <= 0 ||
    (direction === "long" && takeProfit <= entry) ||
    (direction === "short" && takeProfit >= entry)) {
    return "invalid_trade_direction";
  }
  if (!strategy || strategy === "unknown-strategy" || strategy === "qualified-setup") {
    return "no_structural_stop_available";
  }
  if (!Number.isFinite(limits.atr) || limits.atr <= 0) {
    return "atr_unavailable";
  }
  const candles = readCandles(marketData);
  if (candles.length < 5) return "missing_candle_data";
  if (!hasFreshCandles(candles, signal.timeframe, marketData)) return "stale_candle_data";
  return null;
}

function collectStructuralStopLevels(signal, marketData, candles, direction) {
  const candidates = [];
  const strategy = normalizeText(signal?.setupType || signal?.strategy);
  const pattern = signal?.patternContext?.keyLevels ||
    signal?.indicators?.patternContext?.keyLevels ||
    {};
  const structure = signal?.marketStructure || {};
  const riskPlan = signal?.riskPlan || {};
  const levels = readLevels(signal, marketData);
  const add = (value, source, priority) => {
    const price = readLevelPrice(value);
    const entry = Number(signal?.entryPrice ?? signal?.entry);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(entry)) return;
    if (direction === "long" ? price >= entry : price <= entry) return;
    if (candidates.some((candidate) => candidate.source === source && nearlyEqual(candidate.price, price))) return;
    candidates.push({ price, source, priority });
  };
  const directional = (longValues, shortValues, source, priority) => {
    for (const value of direction === "long" ? longValues : shortValues) add(value, source, priority);
  };

  if (/breakout-retest|support-resistance-retest/.test(strategy)) {
    directional(
      [structure.retestLow, structure.breakoutRetestLow, riskPlan.retestLow, pattern.support, pattern.breakoutLevel],
      [structure.retestHigh, structure.breakoutRetestHigh, riskPlan.retestHigh, pattern.resistance, pattern.breakoutLevel],
      "retest_structure",
      1
    );
  }
  if (/double-bottom|double-top|head-and-shoulders|inverse-head-and-shoulders/.test(strategy)) {
    add(pattern.invalidation ?? structure.patternInvalidation ?? riskPlan.invalidation, "pattern_invalidation", 1);
  }
  if (/liquidity-sweep/.test(strategy)) {
    add(findLiquiditySweepWick(signal, marketData, candles, direction), "liquidity_sweep", 1);
  }
  if (/momentum-breakout/.test(strategy)) {
    directional(
      [structure.breakoutBaseLow, riskPlan.breakoutBaseLow, pattern.support, pattern.breakoutLevel],
      [structure.breakoutBaseHigh, riskPlan.breakoutBaseHigh, pattern.resistance, pattern.breakoutLevel],
      "retest_structure",
      2
    );
  }

  add(pattern.invalidation, "pattern_invalidation", 4);
  directional(
    [structure.swingLow, structure.recentSwingLow, riskPlan.swingLow],
    [structure.swingHigh, structure.recentSwingHigh, riskPlan.swingHigh],
    "recent_swing",
    5
  );
  directional([levels.support], [levels.resistance], "support_resistance", 6);

  for (const swing of detectRecentConfirmedSwings(candles, direction)) {
    add(swing.price, "recent_swing", 7);
  }

  directional(
    [structure.atrStructureBoundaryLow, riskPlan.atrStructureBoundaryLow],
    [structure.atrStructureBoundaryHigh, riskPlan.atrStructureBoundaryHigh],
    "atr_structure_buffer",
    8
  );

  return candidates;
}

function buildRepairCandidate(level, context) {
  const {
    direction,
    entry,
    atr,
    bufferAtrMultiplier,
    minimumDistance,
    candles,
    marketData
  } = context;
  const buffer = atr * bufferAtrMultiplier;
  const noiseBoundary = readNoiseBoundary(candles, direction);
  let stop = direction === "long" ? level.price - buffer : level.price + buffer;

  if (Number.isFinite(noiseBoundary)) {
    stop = direction === "long"
      ? Math.min(stop, noiseBoundary - buffer)
      : Math.max(stop, noiseBoundary + buffer);
  }
  stop = direction === "long"
    ? Math.min(stop, entry - minimumDistance)
    : Math.max(stop, entry + minimumDistance);
  stop = roundStopOutward(stop, direction, marketData, entry);

  const stopDistance = Math.abs(entry - stop);
  if (!Number.isFinite(stop) || stop <= 0 || !Number.isFinite(stopDistance) || stopDistance <= 0) return null;
  if (direction === "long" ? stop >= entry : stop <= entry) return null;
  if (!protectsStructure(stop, level.price, direction, buffer)) return null;
  if (isStopInsideCandleNoise(stop, direction, candles, atr)) return null;

  return {
    ...level,
    stopLoss: stop,
    stopDistance
  };
}

function detectRecentConfirmedSwings(candles, direction) {
  const swings = [];
  const recent = candles.slice(-48);
  for (let index = pivotWidth; index < recent.length - pivotWidth; index += 1) {
    const candle = recent[index];
    const left = recent.slice(index - pivotWidth, index);
    const right = recent.slice(index + 1, index + pivotWidth + 1);
    if (direction === "long" &&
      left.every((item) => candle.low < item.low) &&
      right.every((item) => candle.low < item.low)) {
      swings.push({ price: Number(candle.low), index });
    }
    if (direction === "short" &&
      left.every((item) => candle.high > item.high) &&
      right.every((item) => candle.high > item.high)) {
      swings.push({ price: Number(candle.high), index });
    }
  }
  return swings.sort((left, right) => right.index - left.index).slice(0, 4);
}

function findLiquiditySweepWick(signal, marketData, candles, direction) {
  const sweep = signal?.smc?.liquiditySweep ||
    signal?.indicators?.smc?.liquiditySweep ||
    marketData?.smc?.liquiditySweep;
  if (!sweep) return null;
  const sweepTime = toEpochMs(sweep.time);
  const candle = sweepTime == null
    ? null
    : candles.find((item) => toEpochMs(item.time) === sweepTime);
  if (candle) return direction === "long" ? candle.low : candle.high;
  return sweep.wick ?? sweep.extreme ?? sweep.level;
}

function isStopInsideCandleNoise(stop, direction, candles, atr) {
  const latest = candles.at(-1);
  if (!latest || !Number.isFinite(Number(latest.low)) || !Number.isFinite(Number(latest.high))) return false;
  const noiseBuffer = Number.isFinite(atr) && atr > 0 ? atr * 0.05 : 0;
  return direction === "long"
    ? stop > Number(latest.low) - noiseBuffer
    : stop < Number(latest.high) + noiseBuffer;
}

function readNoiseBoundary(candles, direction) {
  const latest = candles.at(-1);
  if (!latest) return null;
  return finiteOrNull(direction === "long" ? latest.low : latest.high);
}

function protectsStructure(stop, structure, direction, buffer) {
  const tolerance = Math.max(Math.abs(structure) * 1e-10, Number.EPSILON);
  return direction === "long"
    ? stop <= structure - buffer + tolerance
    : stop >= structure + buffer - tolerance;
}

function resolveStopLimits(options = {}, signal = null, marketData = {}) {
  const atr = Number(
    options.atr ??
    signal?.indicators?.atr14 ??
    signal?.fullAnalysis?.indicators?.atr14 ??
    marketData?.regime?.metrics?.atr14 ??
    marketData?.indicators?.atr14
  );
  const minAtrMultiplier = Number(options.minAtrMultiplier ?? appConfig.signals.stopMinAtrMultiplier);
  const configuredMax = Number(options.maxAtrMultiplier ?? appConfig.signals.stopMaxAtrMultiplier);
  const maxAtrMultiplier = Math.max(minAtrMultiplier, configuredMax);
  const bufferAtrMultiplier = Number(options.bufferAtrMultiplier ?? appConfig.signals.stopBufferAtrMultiplier);
  return {
    atr,
    minAtrMultiplier,
    maxAtrMultiplier,
    bufferAtrMultiplier,
    minimumDistance: Number.isFinite(atr) && atr > 0 ? atr * minAtrMultiplier : Infinity,
    maximumDistance: Number.isFinite(atr) && atr > 0 ? atr * maxAtrMultiplier : -Infinity
  };
}

function withStopDiagnostics(signal, diagnostics) {
  const normalized = {
    ...diagnostics,
    atrBufferUsed: roundDiagnostic(diagnostics.atrBufferUsed),
    originalStopDistance: roundDiagnostic(diagnostics.originalStopDistance),
    repairedStopDistance: roundDiagnostic(diagnostics.repairedStopDistance),
    repairedRiskReward: roundDiagnostic(diagnostics.repairedRiskReward)
  };
  Object.assign(normalized, {
    original_stop_loss: normalized.originalStopLoss,
    repaired_stop_loss: normalized.repairedStopLoss,
    stop_repair_attempted: normalized.repairAttempted,
    stop_repair_succeeded: normalized.repairSucceeded,
    stop_repair_source: normalized.repairSource,
    original_stop_distance: normalized.originalStopDistance,
    repaired_stop_distance: normalized.repairedStopDistance,
    stop_validation_reason: normalized.stopValidationReason
  });
  return {
    ...signal,
    originalStopLoss: normalized.originalStopLoss,
    repairedStopLoss: normalized.repairedStopLoss,
    stopRepairAttempted: normalized.repairAttempted,
    stopRepairSucceeded: normalized.repairSucceeded,
    stopRepairSource: normalized.repairSource,
    originalStopDistance: normalized.originalStopDistance,
    repairedStopDistance: normalized.repairedStopDistance,
    stopValidationReason: normalized.stopValidationReason,
    stopRepairDiagnostics: normalized,
    indicators: {
      ...(signal.indicators || {}),
      stopRepairDiagnostics: normalized
    }
  };
}

function readStopDiagnostics(signal) {
  return signal?.stopRepairDiagnostics || signal?.indicators?.stopRepairDiagnostics || null;
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

function roundStopOutward(value, direction, marketData, entry) {
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

function readLevelPrice(value) {
  if (value && typeof value === "object") return finiteOrNull(value.price ?? value.level ?? value.value);
  return finiteOrNull(value);
}

function invalidStop(reasonCode, stopDistance, riskReward) {
  return {
    valid: false,
    reasonCode,
    stopDistance: finiteOrNull(stopDistance),
    riskReward: finiteOrNull(riskReward)
  };
}

function toEpochMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
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

function normalizeDirection(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
