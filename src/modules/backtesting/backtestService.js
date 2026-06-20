import { analyzeMarketRegime } from "../market-data/marketRegimeService.js";
import { getOhlcv } from "../market-data/marketDataService.js";
import { scoreMultiTimeframeConfluence } from "../market-data/multiTimeframeService.js";
import {
  analyzeSmartMoneyConcepts,
  evaluateSmcConfluence
} from "../market-data/smartMoneyConceptsService.js";
import {
  analyzeAdvancedMarketStructure,
  evaluateAdvancedStructure
} from "../market-data/advancedMarketStructureService.js";
import {
  buildCorrelationContext,
  buildCorrelationSnapshot,
  correlationSymbols,
  evaluateCorrelationContext
} from "../market-data/correlationService.js";
import { getTradingSession, tradingSessions } from "../intelligence/sessionIntelligenceService.js";

export const backtestSymbols = [
  "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "ADA-USD", "DOGE-USD",
  "LINK-USD", "AVAX-USD", "LTC-USD", "XAU/USD", "XAG/USD", "WTI", "BRENT"
];
export const backtestTimeframes = ["15m", "1h", "4h"];
export const strategyComponentNames = [
  "marketRegime",
  "multiTimeframe",
  "ema",
  "rsi",
  "adx",
  "atr",
  "supportResistance",
  "liquiditySweeps",
  "fairValueGaps",
  "orderBlocks",
  "structure",
  "vwap",
  "volumeProfile",
  "correlation"
];

const warmupCandles = 60;
const maximumHoldingBars = 20;
const timeframeOrder = ["15m", "1h", "4h"];

export async function runHistoricalBacktest(_user, input) {
  const symbols = normalizeSelections(input.symbols || input.symbol, backtestSymbols, "market");
  const timeframes = normalizeSelections(input.timeframes || input.timeframe, backtestTimeframes, "timeframe");
  const components = normalizeComponents(input.components);
  const sessionFilters = normalizeSessionFilters(input.sessions);
  const reports = [];
  const withoutSmcReports = [];
  const fixedStopReports = [];
  const fixedTargetReports = [];
  const withoutVwapReports = [];
  const withoutProfileReports = [];
  const withoutCorrelationReports = [];
  const errors = [];

  for (const symbol of symbols) {
    for (const timeframe of timeframes) {
      try {
        const bundle = await loadHistoricalBundle(symbol, timeframe);
        const options = {
          components,
          sessionFilters,
          higherTimeframeData: bundle.higherTimeframeData,
          correlationData: bundle.correlationData
        };
        reports.push(backtestMarketData(bundle.marketData, timeframe, options));
        fixedStopReports.push(backtestMarketData(bundle.marketData, timeframe, {
          ...options,
          stopMode: "fixed"
        }));
        fixedTargetReports.push(backtestMarketData(bundle.marketData, timeframe, {
          ...options,
          targetMode: "fixed"
        }));
        withoutVwapReports.push(backtestMarketData(bundle.marketData, timeframe, {
          ...options,
          components: { ...components, vwap: false }
        }));
        withoutProfileReports.push(backtestMarketData(bundle.marketData, timeframe, {
          ...options,
          components: { ...components, volumeProfile: false }
        }));
        withoutCorrelationReports.push(backtestMarketData(bundle.marketData, timeframe, {
          ...options,
          components: { ...components, correlation: false }
        }));
        if (hasEnabledSmc(components)) {
          withoutSmcReports.push(backtestMarketData(bundle.marketData, timeframe, {
            ...options,
            components: disableSmcComponents(components)
          }));
        }
      } catch (error) {
        errors.push({ symbol, timeframe, message: error.message });
      }
    }
  }

  if (!reports.length) {
    const error = new Error(errors[0]?.message || "No historical market data was available.");
    error.statusCode = 422;
    throw error;
  }

  return aggregateBacktestReports(
    reports,
    errors,
    components,
    withoutSmcReports,
    fixedStopReports,
    fixedTargetReports,
    withoutVwapReports,
    withoutProfileReports,
    withoutCorrelationReports
  );
}

export function backtestMarketData(marketData, timeframe, options = {}) {
  const candles = marketData.candles || [];
  const components = normalizeComponents(options.components);
  const higherTimeframeData = options.higherTimeframeData || {};
  const sessionFilters = options.sessionFilters || tradingSessions;
  const stopMode = options.stopMode || "atr";
  const targetMode = options.targetMode || "dynamic";
  const correlationData = options.correlationData || {};
  const trades = [];
  let index = warmupCandles - 1;

  while (index < candles.length - 1) {
    const historicalCandles = candles.slice(0, index + 1);
    const setup = evaluateHistoricalSetup({
      marketData,
      timeframe,
      candles: historicalCandles,
      higherTimeframeData,
      components
      ,
      sessionFilters,
      stopMode,
      targetMode,
      correlationData
    });

    if (!setup) {
      index += 1;
      continue;
    }

    const finalIndex = Math.min(candles.length - 1, index + maximumHoldingBars);
    const outcome = evaluateTradeOutcome(
      setup,
      candles.slice(index + 1, finalIndex + 1),
      index + 1
    );

    trades.push({
      symbol: marketData.pair.symbol,
      timeframe,
      direction: setup.direction,
      setupType: setup.setupType,
      regime: setup.regime,
      confluenceScore: setup.confluenceScore,
      smc: setup.smc,
      session: setup.session,
      qualityScore: setup.qualityScore,
      confidenceScore: setup.confidenceScore,
      entryPrice: setup.entryPrice,
      stopLoss: setup.stopLoss,
      takeProfit: setup.takeProfit,
      riskRewardRatio: setup.riskRewardRatio,
      stopStyle: setup.stopStyle,
      targetStyle: setup.targetStyle,
      advancedStructure: setup.advancedStructure,
      correlation: setup.correlation,
      openedAt: toIso(candles[index].time),
      closedAt: toIso(candles[outcome.exitIndex]?.time),
      outcome: outcome.status,
      realizedR: outcome.realizedR
    });

    index = Math.max(index + 1, outcome.exitIndex);
  }

  const metrics = calculateBacktestMetrics(trades);
  return {
    symbol: marketData.pair.symbol,
    timeframe,
    provider: marketData.source,
    candleCount: candles.length,
    period: {
      from: candles.length ? toIso(candles[0].time) : null,
      to: candles.length ? toIso(candles[candles.length - 1].time) : null
    },
    metrics,
    curves: buildCurves(trades),
    trades,
    components
  };
}

export function evaluateTradeOutcome(signal, forwardCandles, firstIndex = 0) {
  for (let offset = 0; offset < forwardCandles.length; offset += 1) {
    const candle = forwardCandles[offset];
    const hitStop = signal.direction === "long"
      ? candle.low <= signal.stopLoss
      : candle.high >= signal.stopLoss;
    const hitTarget = signal.direction === "long"
      ? candle.high >= signal.takeProfit
      : candle.low <= signal.takeProfit;

    if (hitStop) {
      return { status: "Hit SL", realizedR: -1, exitIndex: firstIndex + offset };
    }
    if (hitTarget) {
      return {
        status: "Hit TP",
        realizedR: Number(signal.riskRewardRatio),
        exitIndex: firstIndex + offset
      };
    }
  }

  return {
    status: "Expired",
    realizedR: 0,
    exitIndex: firstIndex + Math.max(0, forwardCandles.length - 1)
  };
}

export function calculateBacktestMetrics(trades) {
  const wins = trades.filter((trade) => trade.outcome === "Hit TP");
  const losses = trades.filter((trade) => trade.outcome === "Hit SL");
  const expired = trades.filter((trade) => trade.outcome === "Expired").length;
  const resolved = wins.length + losses.length;
  const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.realizedR || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.realizedR || 0), 0));
  const totalR = trades.reduce((sum, trade) => sum + Number(trade.realizedR || 0), 0);
  const streaks = calculateStreaks(trades);
  const curves = buildCurves(trades);

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    expired,
    winRate: resolved ? round((wins.length / resolved) * 100) : 0,
    profitFactor: grossLoss ? round(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    averageR: trades.length ? round(totalR / trades.length) : 0,
    expectancy: trades.length ? round(totalR / trades.length) : 0,
    netR: round(totalR),
    maxDrawdownR: round(Math.max(0, ...curves.drawdown.map((point) => point.value))),
    consecutiveWins: streaks.wins,
    consecutiveLosses: streaks.losses,
    averageQualityScore: trades.length
      ? round(trades.reduce((sum, trade) => sum + Number(trade.qualityScore || 0), 0) / trades.length)
      : 0
  };
}

function evaluateHistoricalSetup({
  marketData,
  timeframe,
  candles,
  higherTimeframeData,
  components,
  sessionFilters,
  stopMode,
  targetMode
  ,
  correlationData
}) {
  const regime = analyzeMarketRegime(candles);
  const metrics = regime.metrics || {};
  const latest = candles[candles.length - 1];
  const session = getTradingSession(new Date(latest.time * 1000));
  if (!sessionFilters.includes(session.name)) return null;
  const votes = [];

  if (components.ema) votes.push(metrics.ema20 > metrics.ema50 ? 1 : metrics.ema20 < metrics.ema50 ? -1 : 0);
  if (components.rsi) votes.push(metrics.rsi14 >= 52 ? 1 : metrics.rsi14 <= 48 ? -1 : 0);
  if (components.marketRegime) {
    votes.push(regime.preferredDirection === "long" ? 1 : regime.preferredDirection === "short" ? -1 : 0);
  }
  if (components.adx && Number(metrics.adx14) < 18) return null;
  if (components.atr && (regime.volatilityLevel === "Low" || !Number.isFinite(Number(metrics.atr14)))) return null;

  const voteTotal = votes.reduce((sum, vote) => sum + vote, 0);
  if (Math.abs(voteTotal) < Math.max(1, Math.ceil(votes.length * 0.4))) return null;
  const direction = voteTotal > 0 ? "long" : "short";

  if (
    components.marketRegime &&
    ((regime.label === "Trend Up" && direction !== "long") ||
      (regime.label === "Trend Down" && direction !== "short") ||
      regime.label === "Low Volatility")
  ) return null;

  const setupType = classifyHistoricalSetup(candles, regime, direction);
  if (!setupType) return null;
  if (components.marketRegime && regime.label === "Breakout" && setupType !== "Breakout retest") return null;
  if (components.marketRegime && regime.label === "Range" && setupType !== "Reversal") return null;

  const confluenceContext = buildHistoricalConfluenceContext({
    symbol: marketData.pair.symbol,
    timeframe,
    decisionTime: latest.time,
    lowerRegime: regime,
    higherTimeframeData
  });
  const confluence = components.multiTimeframe
    ? scoreMultiTimeframeConfluence(confluenceContext, direction)
    : neutralConfluence(direction);
  if (components.multiTimeframe && confluence.badge === "Countertrend" && confluence.score < 35) return null;
  const smcState = analyzeSmartMoneyConcepts(candles);
  const smc = evaluateBacktestSmc(smcState, direction, regime, components);
  const advancedState = analyzeAdvancedMarketStructure(candles, {
    volumeAvailable: marketData.volumeAvailable !== false
  });
  const advancedStructure = evaluateAdvancedStructure(advancedState, direction, latest.close, regime);
  const historicalSeries = {
    [marketData.pair.symbol]: candles
  };
  for (const [peer, peerData] of Object.entries(correlationData)) {
    const historical = peerData.candles.filter((candle) => candle.time <= latest.time);
    if (historical.length >= 20) historicalSeries[peer] = historical;
  }
  const correlationContext = buildCorrelationContext(
    buildCorrelationSnapshot(historicalSeries, timeframe),
    marketData.pair.symbol
  );
  const correlation = evaluateCorrelationContext(correlationContext, direction);

  const enabledCount = Object.values(components).filter(Boolean).length;
  const agreement = votes.filter((vote) => direction === "long" ? vote > 0 : vote < 0).length;
  let qualityScore = 48 + Math.round((agreement / Math.max(1, votes.length)) * 32);
  qualityScore += confluence.qualityAdjustment;
  qualityScore += smc.qualityAdjustment;
  if (components.vwap) {
    qualityScore += advancedStructure.conflict ? -5 : advancedStructure.vwapAligned ? 2 : 0;
  }
  if (components.volumeProfile && advancedStructure.volumeProfileAligned) qualityScore += 2;
  if (components.correlation) qualityScore += correlation.qualityAdjustment;
  if (components.adx && metrics.adx14 >= 25) qualityScore += 5;
  if (components.supportResistance && !hasRoomToTarget(metrics, latest.close, direction, metrics.atr14)) return null;
  qualityScore = Math.max(0, Math.min(100, qualityScore));
  if (enabledCount >= 4 && qualityScore < 74) return null;

  const atrValue = Number(metrics.atr14);
  const stopMultiple = components.atr
    ? regime.volatilityLevel === "High" ? 1.8 : 1.4
    : 1.2;
  const risk = stopMode === "fixed"
    ? latest.close * 0.01
    : Math.max(atrValue * stopMultiple, latest.close * 0.001);
  const dynamicTarget = regime.label === "Range"
    ? 1.8
    : regime.trendStrength >= 0.8
      ? 2.6
      : regime.trendStrength >= 0.65
        ? 2.3
        : qualityScore >= 80
          ? 2.1
          : 1.8;
  const riskRewardRatio = targetMode === "fixed" ? 2 : dynamicTarget;
  const stopLoss = direction === "long" ? latest.close - risk : latest.close + risk;
  const takeProfit = direction === "long"
    ? latest.close + risk * riskRewardRatio
    : latest.close - risk * riskRewardRatio;

  return {
    direction,
    setupType,
    regime: regime.label,
    confluenceScore: confluence.score,
    smc,
    session: session.name,
    qualityScore,
    confidenceScore: Math.max(
      0,
      Math.min(
        100,
        qualityScore +
          confluence.confidenceAdjustment +
          smc.confidenceAdjustment +
          (components.vwap ? (advancedStructure.vwapAligned ? 3 : advancedStructure.conflict ? -7 : 0) : 0) +
          (components.volumeProfile && advancedStructure.volumeProfileAligned ? 3 : 0) +
          (components.correlation ? correlation.confidenceAdjustment : 0)
      )
    ),
    entryPrice: latest.close,
    stopLoss,
    takeProfit,
    riskRewardRatio
    ,
    stopStyle: stopMode === "fixed" ? "Fixed 1%" : "ATR regime",
    targetStyle: targetMode === "fixed" ? "Fixed 2R" : "Regime dynamic"
    ,
    advancedStructure: {
      vwapAligned: components.vwap && advancedStructure.vwapAligned,
      volumeProfileAligned: components.volumeProfile && advancedStructure.volumeProfileAligned
    },
    correlation: {
      aligned: components.correlation && correlation.aligned,
      conflict: components.correlation && correlation.conflict,
      breakdown: components.correlation && correlation.breakdown
    }
  };
}

function buildHistoricalConfluenceContext({
  symbol,
  timeframe,
  decisionTime,
  lowerRegime,
  higherTimeframeData
}) {
  const higherTimeframes = timeframeOrder.slice(timeframeOrder.indexOf(timeframe) + 1);
  return {
    symbol,
    lowerTimeframe: timeframe,
    lowerTimeframeRegime: lowerRegime,
    higherTimeframes: higherTimeframes.map((higherTimeframe) => {
      const source = higherTimeframeData[higherTimeframe];
      const historical = source?.candles?.filter((candle) => candle.time <= decisionTime) || [];
      return historical.length >= warmupCandles
        ? {
            timeframe: higherTimeframe,
            available: true,
            regime: analyzeMarketRegime(historical)
          }
        : {
            timeframe: higherTimeframe,
            available: false,
            error: "Not enough higher-timeframe candles existed at this decision point."
          };
    })
  };
}

function classifyHistoricalSetup(candles, regime, direction) {
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const prior = candles.slice(-24, -3);
  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const priorLow = Math.min(...prior.map((candle) => candle.low));
  const atrValue = Number(regime.metrics.atr14);
  const breakoutRetest = direction === "long"
    ? previous.close > priorHigh && latest.low <= priorHigh + atrValue * 0.35 && latest.close > priorHigh
    : previous.close < priorLow && latest.high >= priorLow - atrValue * 0.35 && latest.close < priorLow;
  if (breakoutRetest) return "Breakout retest";
  if (regime.label === "Range") {
    const nearLevel = direction === "long"
      ? latest.close - regime.metrics.support <= atrValue * 1.2
      : regime.metrics.resistance - latest.close <= atrValue * 1.2;
    return nearLevel ? "Reversal" : null;
  }
  const nearEma20 = Math.abs(latest.close - regime.metrics.ema20) <= atrValue * 0.8;
  if (nearEma20) return "Pullback bounce";
  if (["Trend Up", "Trend Down", "High Volatility"].includes(regime.label)) return "Trend continuation";
  return null;
}

function hasRoomToTarget(metrics, price, direction, atrValue) {
  const minimumRoom = Number(atrValue) * 1.8;
  return direction === "long"
    ? Number(metrics.resistance) <= price || Number(metrics.resistance) - price >= minimumRoom
    : Number(metrics.support) >= price || price - Number(metrics.support) >= minimumRoom;
}

async function loadHistoricalBundle(symbol, timeframe) {
  const marketData = await getOhlcv(symbol, timeframe);
  const higherTimeframes = timeframeOrder.slice(timeframeOrder.indexOf(timeframe) + 1);
  const settled = await Promise.allSettled(
    higherTimeframes.map((higherTimeframe) => getOhlcv(symbol, higherTimeframe))
  );
  const higherTimeframeData = {};
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      higherTimeframeData[higherTimeframes[index]] = result.value;
    }
  });
  const correlationSettled = await Promise.allSettled(
    correlationSymbols
      .filter((peer) => peer !== symbol)
      .map((peer) => getOhlcv(peer, timeframe))
  );
  const correlationData = {};
  correlationSettled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      const peer = correlationSymbols.filter((item) => item !== symbol)[index];
      correlationData[peer] = result.value;
    }
  });
  return { marketData, higherTimeframeData, correlationData };
}

function aggregateBacktestReports(
  reports,
  errors,
  components,
  withoutSmcReports = [],
  fixedStopReports = [],
  fixedTargetReports = [],
  withoutVwapReports = [],
  withoutProfileReports = [],
  withoutCorrelationReports = []
) {
  const trades = reports.flatMap((report) => report.trades)
    .sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
  const metrics = calculateBacktestMetrics(trades);
  const curves = buildCurves(trades);
  const breakdowns = {
    markets: aggregateWinRate(trades, (trade) => trade.symbol),
    timeframes: aggregateWinRate(trades, (trade) => trade.timeframe),
    regimes: aggregateWinRate(trades, (trade) => trade.regime || "Unknown"),
    confluence: aggregateWinRate(trades, (trade) => confluenceRange(trade.confluenceScore))
    ,
    sessions: aggregateWinRate(trades, (trade) => trade.session || "Unknown")
    ,
    smc: aggregateSmcPerformance(trades)
  };
  const noEdge = metrics.totalTrades < 8 ||
    metrics.expectancy <= 0 ||
    (metrics.profitFactor !== null && metrics.profitFactor < 1.1) ||
    metrics.maxDrawdownR > 8;

  const singleReport = reports.length === 1 ? reports[0] : null;
  return {
    symbol: singleReport?.symbol || null,
    timeframe: singleReport?.timeframe || null,
    provider: singleReport?.provider || "multiple",
    candleCount: singleReport?.candleCount || reports.reduce((sum, report) => sum + report.candleCount, 0),
    period: singleReport?.period || null,
    reports: reports.map((report) => ({
      symbol: report.symbol,
      timeframe: report.timeframe,
      candleCount: report.candleCount,
      period: report.period,
      metrics: report.metrics
    })),
    metrics,
    curves,
    breakdowns,
    components,
    smcComparison: buildSmcComparison(metrics, withoutSmcReports),
    riskComparison: {
      stops: buildVariantComparison(
        "ATR stops",
        metrics,
        "Fixed 1% stops",
        fixedStopReports
      ),
      targets: buildVariantComparison(
        "Dynamic targets",
        metrics,
        "Fixed 2R targets",
        fixedTargetReports
      )
    },
    advancedStructureComparison: {
      vwap: components.vwap
        ? buildComponentComparison("VWAP enabled", metrics, "VWAP disabled", withoutVwapReports)
        : null,
      volumeProfile: components.volumeProfile ? buildComponentComparison(
        "Volume Profile enabled",
        metrics,
        "Volume Profile disabled",
        withoutProfileReports
      ) : null,
      correlation: components.correlation ? buildComponentComparison(
        "Correlation enabled",
        metrics,
        "Correlation disabled",
        withoutCorrelationReports
      ) : null
    },
    sessionFilters: reports[0]?.sessionFilters || null,
    errors,
    evaluation: {
      status: noEdge ? "no-edge" : "edge-detected",
      message: noEdge
        ? "No edge found"
        : "Positive historical edge detected. Validate on more data before changing production rules."
    },
    ruleSetEvaluation: {
      status: noEdge ? "failed" : "passed",
      eligibleForEnablement: false,
      message: noEdge
        ? "No edge found. Production rules remain unchanged."
        : "Historical edge detected. Lab results never enable production rules automatically."
    },
    trades: trades.slice(-100).reverse(),
    generatedAt: new Date().toISOString()
  };
}

function buildComponentComparison(primaryLabel, primaryMetrics, variantLabel, reports) {
  const variantMetrics = calculateBacktestMetrics(reports.flatMap((report) => report.trades));
  return {
    primary: { label: primaryLabel, metrics: primaryMetrics },
    variant: { label: variantLabel, metrics: variantMetrics },
    expectancyDelta: round(primaryMetrics.expectancy - variantMetrics.expectancy),
    winRateDelta: round(primaryMetrics.winRate - variantMetrics.winRate)
  };
}

function buildVariantComparison(primaryLabel, primaryMetrics, variantLabel, variantReports) {
  const variantMetrics = calculateBacktestMetrics(
    variantReports.flatMap((report) => report.trades)
  );
  return {
    primary: { label: primaryLabel, metrics: primaryMetrics },
    variant: { label: variantLabel, metrics: variantMetrics },
    expectancyDelta: round(primaryMetrics.expectancy - variantMetrics.expectancy),
    drawdownDelta: round(primaryMetrics.maxDrawdownR - variantMetrics.maxDrawdownR)
  };
}

function evaluateBacktestSmc(smcState, direction, regime, components) {
  const full = evaluateSmcConfluence(smcState, direction, regime);
  const enabledNames = new Set();
  if (components.liquiditySweeps) enabledNames.add("Liquidity sweep");
  if (components.fairValueGaps) enabledNames.add("Fair value gap");
  if (components.orderBlocks) enabledNames.add("Order block");
  if (components.structure) enabledNames.add("BOS / CHoCH");

  const factors = full.factors.filter((factor) => enabledNames.has(factor.name));
  if (!factors.length) {
    return {
      score: 0,
      conflict: false,
      confidenceAdjustment: 0,
      qualityAdjustment: 0,
      factors: [],
      explanation: "SMC components were disabled for this lab run."
    };
  }

  const passed = factors.filter((factor) => factor.passed).length;
  const scale = factors.length / full.factors.length;
  return {
    ...full,
    score: passed,
    factors,
    confidenceAdjustment: Math.round(full.confidenceAdjustment * scale),
    qualityAdjustment: Math.round(full.qualityAdjustment * scale)
  };
}

function aggregateSmcPerformance(trades) {
  const names = ["Liquidity sweep", "Fair value gap", "Order block", "BOS / CHoCH"];
  return names.map((name) => {
    const matching = trades.filter((trade) => trade.smc?.factors?.some(
      (factor) => factor.name === name && factor.passed
    ));
    return aggregateWinRate(matching, () => name)[0] || {
      label: name,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      netR: 0,
      winRate: 0
    };
  });
}

function buildSmcComparison(withSmcMetrics, withoutSmcReports) {
  if (!withoutSmcReports.length) return null;
  const withoutSmcTrades = withoutSmcReports.flatMap((report) => report.trades);
  const withoutSmc = calculateBacktestMetrics(withoutSmcTrades);
  return {
    withSmc: withSmcMetrics,
    withoutSmc,
    delta: {
      winRate: round(withSmcMetrics.winRate - withoutSmc.winRate),
      expectancy: round(withSmcMetrics.expectancy - withoutSmc.expectancy),
      totalTrades: withSmcMetrics.totalTrades - withoutSmc.totalTrades,
      maxDrawdownR: round(withSmcMetrics.maxDrawdownR - withoutSmc.maxDrawdownR)
    }
  };
}

function hasEnabledSmc(components) {
  return ["liquiditySweeps", "fairValueGaps", "orderBlocks", "structure"]
    .some((name) => components[name]);
}

function disableSmcComponents(components) {
  return {
    ...components,
    liquiditySweeps: false,
    fairValueGaps: false,
    orderBlocks: false,
    structure: false
  };
}

function aggregateWinRate(trades, keyFn) {
  const groups = new Map();
  for (const trade of trades) {
    const key = keyFn(trade);
    const group = groups.get(key) || { label: key, totalTrades: 0, wins: 0, losses: 0, netR: 0 };
    group.totalTrades += 1;
    if (trade.outcome === "Hit TP") group.wins += 1;
    if (trade.outcome === "Hit SL") group.losses += 1;
    group.netR += Number(trade.realizedR || 0);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    netR: round(group.netR),
    winRate: group.wins + group.losses
      ? Math.round((group.wins / (group.wins + group.losses)) * 100)
      : 0
  })).sort((a, b) => b.winRate - a.winRate || b.netR - a.netR);
}

function buildCurves(trades) {
  let equity = 0;
  let peak = 0;
  const equityCurve = [{ index: 0, value: 0, label: "Start" }];
  const drawdown = [{ index: 0, value: 0, label: "Start" }];
  trades.forEach((trade, index) => {
    equity += Number(trade.realizedR || 0);
    peak = Math.max(peak, equity);
    equityCurve.push({ index: index + 1, value: round(equity), label: trade.closedAt });
    drawdown.push({ index: index + 1, value: round(peak - equity), label: trade.closedAt });
  });
  return { equity: equityCurve, drawdown };
}

function calculateStreaks(trades) {
  let wins = 0;
  let losses = 0;
  let currentWins = 0;
  let currentLosses = 0;
  for (const trade of trades) {
    if (trade.outcome === "Hit TP") {
      currentWins += 1;
      currentLosses = 0;
    } else if (trade.outcome === "Hit SL") {
      currentLosses += 1;
      currentWins = 0;
    } else {
      currentWins = 0;
      currentLosses = 0;
    }
    wins = Math.max(wins, currentWins);
    losses = Math.max(losses, currentLosses);
  }
  return { wins, losses };
}

function normalizeSelections(value, supported, label) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  if (!values.length || values.some((item) => !supported.includes(item))) {
    const error = new Error(`Choose at least one supported backtesting ${label}.`);
    error.statusCode = 400;
    throw error;
  }
  return [...new Set(values)];
}

function normalizeComponents(input = {}) {
  const components = {};
  for (const name of strategyComponentNames) {
    components[name] = input[name] !== false;
  }
  if (!Object.values(components).some(Boolean)) {
    const error = new Error("Enable at least one strategy component.");
    error.statusCode = 400;
    throw error;
  }
  if (!components.marketRegime && !components.ema && !components.rsi) {
    const error = new Error("Enable Market regime, EMA, or RSI to provide directional bias.");
    error.statusCode = 400;
    throw error;
  }
  return components;
}

function normalizeSessionFilters(input) {
  const values = Array.isArray(input) && input.length ? input : tradingSessions;
  if (values.some((session) => !tradingSessions.includes(session))) {
    const error = new Error("Choose only supported trading sessions.");
    error.statusCode = 400;
    throw error;
  }
  return [...new Set(values)];
}

function neutralConfluence(direction) {
  return {
    score: 60,
    badge: "Partial Alignment",
    direction,
    confidenceAdjustment: 0,
    qualityAdjustment: 0,
    explanation: "Multi-timeframe confluence was disabled for this lab run.",
    higherTimeframes: []
  };
}

function confluenceRange(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return "Unknown";
  if (value < 40) return "0-39";
  if (value < 60) return "40-59";
  if (value < 80) return "60-79";
  return "80-100";
}

function toIso(unixSeconds) {
  return Number.isFinite(Number(unixSeconds))
    ? new Date(Number(unixSeconds) * 1000).toISOString()
    : null;
}

function round(value) {
  return Number(Number(value).toFixed(2));
}
