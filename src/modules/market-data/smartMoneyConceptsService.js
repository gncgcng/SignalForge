const pivotWidth = 2;
const analysisWindow = 120;

export function analyzeSmartMoneyConcepts(candles) {
  const closedCandles = candles.slice(-analysisWindow);
  if (closedCandles.length < 12) return emptySmc();

  const swings = detectConfirmedSwings(closedCandles);
  const structure = detectStructure(closedCandles, swings);
  const liquiditySweep = detectLiquiditySweep(closedCandles, swings);
  const fairValueGaps = detectFairValueGaps(closedCandles);
  const orderBlocks = detectOrderBlocks(closedCandles, structure);

  return {
    liquiditySweep,
    fairValueGaps,
    orderBlocks,
    structure,
    bullishScore: scoreDirection("long", { liquiditySweep, fairValueGaps, orderBlocks, structure }),
    bearishScore: scoreDirection("short", { liquiditySweep, fairValueGaps, orderBlocks, structure }),
    explanation: buildExplanation({ liquiditySweep, fairValueGaps, orderBlocks, structure })
  };
}

export function evaluateSmcConfluence(smc, direction, regime) {
  const directionalScore = direction === "long" ? smc.bullishScore : smc.bearishScore;
  const opposingScore = direction === "long" ? smc.bearishScore : smc.bullishScore;
  const regimeDirection = regime?.preferredDirection || null;
  const conflictsWithRegime = Boolean(
    regimeDirection &&
    regimeDirection !== direction &&
    !["Range", "Breakout"].includes(regime?.label)
  );
  const factors = buildFactors(smc, direction);
  const contributed = factors.filter((factor) => factor.passed);
  const conflict = opposingScore > directionalScore || conflictsWithRegime;
  const confidenceAdjustment = conflict
    ? -Math.min(10, 4 + opposingScore * 2)
    : Math.min(9, directionalScore * 2);

  return {
    direction,
    score: directionalScore,
    opposingScore,
    active: contributed.length > 0,
    conflict,
    confidenceAdjustment,
    qualityAdjustment: conflict ? -6 : Math.min(6, directionalScore),
    factors,
    explanation: conflict
      ? "Smart Money Concepts conflict with the selected direction or market regime, reducing confidence."
      : contributed.length
        ? `SMC confluence supports the setup through ${contributed.map((item) => item.name).join(", ")}.`
        : "No objective Smart Money Concepts confirmation is active; SMC is neutral."
  };
}

function detectConfirmedSwings(candles) {
  const highs = [];
  const lows = [];

  for (let index = pivotWidth; index < candles.length - pivotWidth; index += 1) {
    const candle = candles[index];
    const left = candles.slice(index - pivotWidth, index);
    const right = candles.slice(index + 1, index + pivotWidth + 1);

    if (
      left.every((item) => candle.high > item.high) &&
      right.every((item) => candle.high > item.high)
    ) {
      highs.push({ index, time: candle.time, price: candle.high });
    }
    if (
      left.every((item) => candle.low < item.low) &&
      right.every((item) => candle.low < item.low)
    ) {
      lows.push({ index, time: candle.time, price: candle.low });
    }
  }

  return { highs, lows };
}

function detectLiquiditySweep(candles, swings) {
  const start = Math.max(0, candles.length - 6);
  let latestSweep = null;

  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index];
    const priorHigh = findLatestBefore(swings.highs, index);
    const priorLow = findLatestBefore(swings.lows, index);

    if (priorHigh && candle.high > priorHigh.price && candle.close < priorHigh.price) {
      latestSweep = {
        type: "buy-side",
        direction: "short",
        level: priorHigh.price,
        time: candle.time,
        confirmed: true
      };
    }
    if (priorLow && candle.low < priorLow.price && candle.close > priorLow.price) {
      latestSweep = {
        type: "sell-side",
        direction: "long",
        level: priorLow.price,
        time: candle.time,
        confirmed: true
      };
    }
  }

  return latestSweep;
}

function detectFairValueGaps(candles) {
  const gaps = [];

  for (let index = 2; index < candles.length; index += 1) {
    const first = candles[index - 2];
    const third = candles[index];

    if (third.low > first.high) {
      gaps.push(createGap("bullish", index, first.high, third.low, third.time, candles));
    }
    if (third.high < first.low) {
      gaps.push(createGap("bearish", index, third.high, first.low, third.time, candles));
    }
  }

  const recent = gaps.slice(-8);
  return {
    active: recent.filter((gap) => gap.fillPercent < 100),
    recent
  };
}

function createGap(type, index, lower, upper, time, candles) {
  let fillPercent = 0;
  const size = upper - lower;

  for (const candle of candles.slice(index + 1)) {
    if (type === "bullish") {
      fillPercent = Math.max(fillPercent, ((upper - Math.max(lower, candle.low)) / size) * 100);
    } else {
      fillPercent = Math.max(fillPercent, ((Math.min(upper, candle.high) - lower) / size) * 100);
    }
  }

  return {
    type,
    direction: type === "bullish" ? "long" : "short",
    lower,
    upper,
    time,
    fillPercent: round(Math.max(0, Math.min(100, fillPercent))),
    status: fillPercent >= 100 ? "Filled" : fillPercent > 0 ? "Partially filled" : "Unfilled"
  };
}

function detectStructure(candles, swings) {
  const events = [];
  let priorBias = inferSwingBias(swings);

  for (let index = 3; index < candles.length; index += 1) {
    const priorHigh = findLatestBefore(swings.highs, index);
    const priorLow = findLatestBefore(swings.lows, index);
    const previousClose = candles[index - 1].close;
    const close = candles[index].close;

    if (priorHigh && previousClose <= priorHigh.price && close > priorHigh.price) {
      const type = priorBias === "short" ? "CHoCH" : "BOS";
      events.push({ type, direction: "long", level: priorHigh.price, index, time: candles[index].time });
      priorBias = "long";
    }
    if (priorLow && previousClose >= priorLow.price && close < priorLow.price) {
      const type = priorBias === "long" ? "CHoCH" : "BOS";
      events.push({ type, direction: "short", level: priorLow.price, index, time: candles[index].time });
      priorBias = "short";
    }
  }

  return {
    bias: priorBias || "neutral",
    latest: events.at(-1) || null,
    events: events.slice(-6)
  };
}

function detectOrderBlocks(candles, structure) {
  const blocks = [];

  for (const event of structure.events) {
    const searchStart = Math.max(0, event.index - 6);
    const candidates = candles.slice(searchStart, event.index);
    const oppositeIndex = findLastIndex(candidates, (candle) => {
      return event.direction === "long" ? candle.close < candle.open : candle.close > candle.open;
    });
    if (oppositeIndex < 0) continue;

    const index = searchStart + oppositeIndex;
    const candle = candles[index];
    const lower = candle.low;
    const upper = candle.high;
    const later = candles.slice(event.index + 1);
    const invalidated = event.direction === "long"
      ? later.some((item) => item.close < lower)
      : later.some((item) => item.close > upper);

    blocks.push({
      type: event.direction === "long" ? "bullish" : "bearish",
      direction: event.direction,
      lower,
      upper,
      time: candle.time,
      structureType: event.type,
      confirmedAt: event.time,
      active: !invalidated
    });
  }

  return {
    active: blocks.filter((block) => block.active).slice(-4),
    recent: blocks.slice(-6)
  };
}

function buildFactors(smc, direction) {
  const matchingFvg = smc.fairValueGaps.active.find((gap) => gap.direction === direction);
  const matchingBlock = smc.orderBlocks.active.find((block) => block.direction === direction);
  const matchingStructure = smc.structure.latest?.direction === direction ? smc.structure.latest : null;
  const matchingSweep = smc.liquiditySweep?.direction === direction ? smc.liquiditySweep : null;

  return [
    factor("Liquidity sweep", Boolean(matchingSweep), matchingSweep
      ? `${matchingSweep.type} liquidity was swept at ${formatPrice(matchingSweep.level)} and price closed back through the level.`
      : "No confirmed liquidity sweep supports this direction."),
    factor("Fair value gap", Boolean(matchingFvg), matchingFvg
      ? `${matchingFvg.type} FVG is ${matchingFvg.status.toLowerCase()} (${matchingFvg.fillPercent}% filled).`
      : "No active fair value gap supports this direction."),
    factor("Order block", Boolean(matchingBlock), matchingBlock
      ? `${matchingBlock.type} order block remains active after ${matchingBlock.structureType} confirmation.`
      : "No structure-confirmed active order block supports this direction."),
    factor("BOS / CHoCH", Boolean(matchingStructure), matchingStructure
      ? `${matchingStructure.type} confirmed at ${formatPrice(matchingStructure.level)}.`
      : "The latest confirmed structure event does not support this direction.")
  ];
}

function scoreDirection(direction, smc) {
  let score = 0;
  if (smc.liquiditySweep?.direction === direction) score += 2;
  if (smc.fairValueGaps.active.some((gap) => gap.direction === direction)) score += 1;
  if (smc.orderBlocks.active.some((block) => block.direction === direction)) score += 2;
  if (smc.structure.latest?.direction === direction) score += smc.structure.latest.type === "CHoCH" ? 2 : 1;
  return score;
}

function inferSwingBias(swings) {
  const highs = swings.highs.slice(-2);
  const lows = swings.lows.slice(-2);
  if (highs.length < 2 || lows.length < 2) return null;
  if (highs[1].price > highs[0].price && lows[1].price > lows[0].price) return "long";
  if (highs[1].price < highs[0].price && lows[1].price < lows[0].price) return "short";
  return null;
}

function findLatestBefore(items, index) {
  return items.findLast((item) => item.index <= index - pivotWidth - 1) || null;
}

function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function factor(name, passed, detail) {
  return { name, passed, detail };
}

function buildExplanation(smc) {
  const parts = [];
  if (smc.liquiditySweep) parts.push(`${smc.liquiditySweep.type} sweep`);
  if (smc.structure.latest) parts.push(`${smc.structure.latest.type} ${smc.structure.latest.direction}`);
  if (smc.fairValueGaps.active.length) parts.push(`${smc.fairValueGaps.active.length} active FVG`);
  if (smc.orderBlocks.active.length) parts.push(`${smc.orderBlocks.active.length} active order block`);
  return parts.length ? `Objective SMC state: ${parts.join(", ")}.` : "No active objective SMC factors.";
}

function emptySmc() {
  return {
    liquiditySweep: null,
    fairValueGaps: { active: [], recent: [] },
    orderBlocks: { active: [], recent: [] },
    structure: { bias: "neutral", latest: null, events: [] },
    bullishScore: 0,
    bearishScore: 0,
    explanation: "Not enough closed candles for Smart Money Concepts analysis."
  };
}

function round(value) {
  return Number(value.toFixed(1));
}

function formatPrice(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 });
}
