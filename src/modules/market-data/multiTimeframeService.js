import { getOhlcv } from "./marketDataService.js";

const timeframeOrder = ["5m", "15m", "1h", "4h"];

export async function getMultiTimeframeMarketData(symbol, timeframe) {
  const marketData = await getOhlcv(symbol, timeframe);
  const higherTimeframes = timeframeOrder.slice(timeframeOrder.indexOf(timeframe) + 1);
  const results = await Promise.allSettled(
    higherTimeframes.map((higherTimeframe) => getOhlcv(symbol, higherTimeframe))
  );
  const higher = results.map((result, index) => {
    if (result.status === "fulfilled") {
      return {
        timeframe: higherTimeframes[index],
        available: true,
        regime: result.value.regime
      };
    }

    return {
      timeframe: higherTimeframes[index],
      available: false,
      error: result.reason?.message || "Higher-timeframe data unavailable."
    };
  });
  const context = {
    symbol,
    lowerTimeframe: timeframe,
    lowerTimeframeRegime: marketData.regime,
    higherTimeframes: higher
  };
  const displayDirection = inferDirection(marketData.regime);

  return {
    ...marketData,
    confluence: {
      ...context,
      display: scoreMultiTimeframeConfluence(context, displayDirection)
    }
  };
}

export function scoreMultiTimeframeConfluence(context, direction) {
  const available = (context?.higherTimeframes || []).filter((item) => item.available);

  if (!available.length) {
    return {
      score: 60,
      badge: "Partial Alignment",
      direction,
      confidenceAdjustment: 0,
      qualityAdjustment: 0,
      explanation: "No higher timeframe is available above this setup, so confidence remains unchanged.",
      higherTimeframes: context?.higherTimeframes || []
    };
  }

  const scored = available.map((item) => ({
    ...item,
    trend: inferDirection(item.regime),
    score: scoreTimeframe(item.regime, direction)
  }));
  const score = Math.round(scored.reduce((sum, item) => sum + item.score, 0) / scored.length);
  const badge = score >= 75
    ? "Full Alignment"
    : score >= 45
      ? "Partial Alignment"
      : "Countertrend";
  const confidenceAdjustment = badge === "Full Alignment"
    ? Math.min(8, Math.round((score - 70) / 4))
    : badge === "Countertrend"
      ? -Math.min(16, Math.round((50 - score) / 2) + 8)
      : Math.round((score - 55) / 5);
  const qualityAdjustment = badge === "Full Alignment"
    ? 6
    : badge === "Countertrend"
      ? -12
      : 0;
  const alignedFrames = scored
    .filter((item) => item.trend === direction)
    .map((item) => item.timeframe);
  const opposingFrames = scored
    .filter((item) => item.trend !== "neutral" && item.trend !== direction)
    .map((item) => item.timeframe);
  const missing = (context?.higherTimeframes || [])
    .filter((item) => !item.available)
    .map((item) => item.timeframe);
  const details = [
    alignedFrames.length ? `${alignedFrames.join(" and ")} support the ${direction} setup` : "",
    opposingFrames.length ? `${opposingFrames.join(" and ")} oppose it` : "",
    missing.length ? `${missing.join(" and ")} were unavailable` : ""
  ].filter(Boolean);

  return {
    score,
    badge,
    direction,
    confidenceAdjustment,
    qualityAdjustment,
    explanation: `${badge}: ${details.join("; ")}. Confluence ${confidenceAdjustment >= 0 ? "increased" : "reduced"} confidence by ${Math.abs(confidenceAdjustment)} points.`,
    higherTimeframes: scored.concat((context?.higherTimeframes || []).filter((item) => !item.available))
  };
}

function scoreTimeframe(regime, direction) {
  const metrics = regime?.metrics || {};
  const trend = inferDirection(regime);
  let score = trend === direction ? 30 : trend === "neutral" ? 15 : 0;

  const emaDirection = metrics.ema20 > metrics.ema50 ? "long" : metrics.ema20 < metrics.ema50 ? "short" : "neutral";
  score += emaDirection === direction ? 25 : emaDirection === "neutral" ? 12 : 0;

  const rsiDirection = metrics.rsi14 >= 52 ? "long" : metrics.rsi14 <= 48 ? "short" : "neutral";
  score += rsiDirection === direction ? 15 : rsiDirection === "neutral" ? 8 : 0;

  const adxStrong = Number(metrics.adx14) >= 22;
  score += adxStrong ? (trend === direction ? 15 : 0) : 7;

  const structureDirection = String(metrics.structure || "").startsWith("Higher")
    ? "long"
    : String(metrics.structure || "").startsWith("Lower")
      ? "short"
      : "neutral";
  score += structureDirection === direction ? 10 : structureDirection === "neutral" ? 5 : 0;

  const price = Number(metrics.latestPrice);
  const support = Number(metrics.support);
  const resistance = Number(metrics.resistance);
  const hasLevelRoom = direction === "long"
    ? Number.isFinite(resistance) && Number.isFinite(price) && resistance > price
    : Number.isFinite(support) && Number.isFinite(price) && support < price;
  score += hasLevelRoom ? 5 : 0;

  return Math.max(0, Math.min(100, score));
}

function inferDirection(regime) {
  if (regime?.preferredDirection === "long" || regime?.label === "Trend Up") return "long";
  if (regime?.preferredDirection === "short" || regime?.label === "Trend Down") return "short";
  const metrics = regime?.metrics || {};
  if (metrics.ema20 > metrics.ema50 && metrics.rsi14 >= 50) return "long";
  if (metrics.ema20 < metrics.ema50 && metrics.rsi14 <= 50) return "short";
  return "neutral";
}
