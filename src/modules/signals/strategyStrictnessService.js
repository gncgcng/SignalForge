const minimumRiskReward = 1.5;
const maximumEntryDistanceAtr = 0.75;
const maximumOverextensionAtr = 2.8;

export function validateStrategyStrictness(signal, marketData = {}) {
  if (!signal) return passStrictness();
  const strategy = normalizeStrategy(signal.setupType || signal.strategy);
  const direction = signal.direction;
  const atr = readAtr(signal, marketData);
  const rr = Number(signal.riskRewardRatio ?? signal.riskReward ?? 0);

  if (!strategy) {
    return rejectStrictness("strategy_misread_rejected", "Strategy is missing, so the setup cannot be promoted.", "missing_strategy");
  }
  if (!Number.isFinite(rr) || rr < minimumRiskReward) {
    return rejectStrictness("strategy_misread_rejected", `Rejected because risk/reward is below ${minimumRiskReward}R.`, "poor_rr");
  }
  if (Number(signal.readinessScore ?? signal.entryReadinessScore ?? signal.indicators?.readinessScore ?? 0) <= 0) {
    return rejectStrictness("strategy_misread_rejected", "Rejected because entry readiness is 0.", "readiness_zero");
  }
  if (signal.entryQuality === "poor") {
    return rejectStrictness("strategy_misread_rejected", "Rejected because entry quality is poor.", "poor_entry_quality");
  }
  if (isOverextended(signal, atr)) {
    return rejectStrictness("weak_pattern_match", "Rejected because price is overextended from the intended structure.", "overextended");
  }

  if (strategy.includes("breakout") && strategy.includes("retest")) {
    return validateBreakoutRetest(signal, marketData, atr);
  }
  if (strategy.includes("momentum") && strategy.includes("breakout")) {
    return validateMomentumBreakout(signal, marketData);
  }
  if (strategy.includes("range") || strategy.includes("mean-reversion")) {
    return validateRangeStrategy(signal, marketData);
  }
  if (strategy.includes("pullback")) {
    return validatePullbackBounce(signal, marketData);
  }

  if (!hasMinimumStructure(signal)) {
    return rejectStrictness("weak_pattern_match", "Rejected because market structure quality is too weak for the named strategy.", "weak_structure");
  }

  return passStrictness();
}

export function applyStrategyStrictnessRejection(signal, strictness) {
  if (!signal || strictness?.passed !== false) return signal;
  return {
    ...signal,
    status: titleCase(strictness.status),
    resultReason: strictness.reason,
    validationPassed: true,
    strategyValidationStatus: strictness.status,
    strategyValidationReason: strictness.reason,
    rejectedReasons: [
      ...(signal.rejectedReasons || []),
      {
        stage: "strategy_strictness",
        reason: strictness.reason,
        code: strictness.code,
        timestamp: new Date().toISOString(),
        market: signal.symbol,
        strategy: signal.setupType || signal.strategy
      }
    ],
    indicators: {
      ...(signal.indicators || {}),
      strategyStrictness: strictness,
      strategyValidationStatus: strictness.status,
      strategyValidationReason: strictness.reason
    }
  };
}

function validateBreakoutRetest(signal, marketData, atr) {
  const level = readBreakoutLevel(signal, marketData);
  const entry = Number(signal.entryPrice ?? signal.entry);
  const actualRetest = Boolean(
    signal.indicators?.retestConfirmed ||
    signal.marketStructure?.retestConfirmed ||
    signal.patternContext?.keyLevels?.breakoutLevel ||
    findConfirmation(signal, /retest|hold.*level|broken level/i)
  );

  if (!actualRetest) {
    return rejectStrictness(
      "strategy_misread_rejected",
      "Rejected because breakout retest did not actually retest the broken level.",
      "missing_retest"
    );
  }
  if (Number.isFinite(level) && Number.isFinite(entry) && Number.isFinite(atr) && Math.abs(entry - level) > atr * maximumEntryDistanceAtr) {
    return rejectStrictness(
      "strategy_misread_rejected",
      "Rejected because the entry is too far from the retested breakout level.",
      "entry_far_from_retest"
    );
  }
  if (!hasVolumeConfirmation(signal, marketData)) {
    return rejectStrictness(
      "weak_pattern_match",
      "Rejected because breakout retest volume confirmation is missing.",
      "missing_volume_confirmation"
    );
  }
  if (!hasMinimumStructure(signal)) {
    return rejectStrictness(
      "weak_pattern_match",
      "Rejected because the breakout level is not structurally clear enough.",
      "weak_breakout_structure"
    );
  }
  return passStrictness();
}

function validateMomentumBreakout(signal, marketData) {
  if (!hasVolumeConfirmation(signal, marketData)) {
    return rejectStrictness("weak_pattern_match", "Rejected because momentum breakout volume confirmation is missing.", "missing_volume_confirmation");
  }
  if (isChoppy(signal, marketData)) {
    return rejectStrictness("strategy_misread_rejected", "Rejected because momentum breakout is being read inside choppy conditions.", "choppy_breakout");
  }
  return passStrictness();
}

function validateRangeStrategy(signal, marketData) {
  const regime = readRegime(signal, marketData);
  if (!/range|chop|sideways/i.test(regime)) {
    return rejectStrictness("strategy_misread_rejected", "Rejected because range strategy was detected outside a range-bound regime.", "regime_incompatible");
  }
  return passStrictness();
}

function validatePullbackBounce(signal, marketData) {
  const regime = readRegime(signal, marketData);
  if (/chop|sideways|low volatility/i.test(regime)) {
    return rejectStrictness("weak_pattern_match", "Rejected because pullback bounce lacks a clean trending regime.", "regime_incompatible");
  }
  if (!hasMinimumStructure(signal)) {
    return rejectStrictness("weak_pattern_match", "Rejected because pullback bounce lacks support/resistance structure.", "weak_structure");
  }
  return passStrictness();
}

function hasMinimumStructure(signal) {
  if (signal.marketStructure?.score >= 60 || signal.indicators?.structureScore >= 60) return true;
  if (findConfirmation(signal, /support|resistance|structure|level|order block|liquidity/i)) return true;
  return Boolean(signal.riskPlan?.invalidation || signal.patternContext?.keyLevels?.support || signal.patternContext?.keyLevels?.resistance);
}

function hasVolumeConfirmation(signal, marketData) {
  if (marketData?.volumeAvailable === false || marketData?.pair?.category === "Commodities") return true;
  if (signal.indicators?.volumeConfirmed || signal.indicators?.volumeProfileAligned) return true;
  return Boolean(findConfirmation(signal, /volume/i)?.passed);
}

function isOverextended(signal, atr) {
  const entry = Number(signal.entryPrice ?? signal.entry);
  const ema20 = Number(signal.indicators?.ema20 ?? signal.fullAnalysis?.indicators?.ema20);
  if (!Number.isFinite(entry) || !Number.isFinite(ema20) || !Number.isFinite(atr) || atr <= 0) return false;
  return Math.abs(entry - ema20) > atr * maximumOverextensionAtr;
}

function readBreakoutLevel(signal, marketData) {
  return finiteOrNull(
    signal.indicators?.breakoutLevel ??
    signal.marketStructure?.breakoutLevel ??
    signal.patternContext?.keyLevels?.breakoutLevel ??
    marketData?.levels?.breakoutLevel
  );
}

function readAtr(signal, marketData) {
  return finiteOrNull(
    signal.indicators?.atr14 ??
    signal.fullAnalysis?.indicators?.atr14 ??
    marketData?.regime?.metrics?.atr14 ??
    marketData?.indicators?.atr14
  );
}

function readRegime(signal, marketData) {
  return String(
    signal.indicators?.regime ||
    signal.marketRegime ||
    marketData?.regime?.label ||
    marketData?.analysis?.regime ||
    ""
  );
}

function isChoppy(signal, marketData) {
  return /chop|range|sideways|unclear/i.test(readRegime(signal, marketData));
}

function findConfirmation(signal, pattern) {
  return (signal.confirmations || signal.fullAnalysis?.confirmations || []).find((item) =>
    pattern.test(`${item.name || ""} ${item.detail || ""} ${item.reason || ""}`)
  );
}

function normalizeStrategy(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function passStrictness() {
  return { passed: true, status: "passed", reason: "Strategy strictness checks passed." };
}

function rejectStrictness(status, reason, code) {
  return {
    passed: false,
    status,
    reason,
    code,
    checkedAt: new Date().toISOString()
  };
}

function titleCase(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
