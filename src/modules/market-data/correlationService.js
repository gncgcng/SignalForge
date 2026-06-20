import { getCachedOhlcv, getOhlcv, getPair } from "./marketDataService.js";

export const correlationSymbols = [
  "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "XAU/USD", "XAG/USD", "WTI"
];

const cache = new Map();
const cacheTtlMs = 5 * 60 * 1000;

export async function getCorrelationContext(symbol, timeframe) {
  const snapshot = enrichWithCachedCommodities(
    await getCorrelationSnapshot(timeframe),
    timeframe
  );
  return buildCorrelationContext(snapshot, symbol);
}

export async function getCorrelationSnapshot(timeframe) {
  const cached = cache.get(timeframe);
  if (cached?.value && cached.expiresAt > Date.now()) return cached.value;
  if (cached?.promise) return cached.promise;

  const promise = loadSnapshot(timeframe);
  cache.set(timeframe, { promise });
  try {
    const value = await promise;
    cache.set(timeframe, { value, expiresAt: Date.now() + cacheTtlMs });
    return value;
  } catch (error) {
    cache.delete(timeframe);
    throw error;
  }
}

export function buildCorrelationSnapshot(seriesBySymbol, timeframe = "1h") {
  const symbols = Object.keys(seriesBySymbol);
  const matrix = {};

  for (const left of symbols) {
    matrix[left] = {};
    for (const right of symbols) {
      matrix[left][right] = left === right
        ? 1
        : rollingCorrelation(seriesBySymbol[left], seriesBySymbol[right]);
    }
  }

  return {
    timeframe,
    matrix,
    trends: Object.fromEntries(symbols.map((symbol) => [
      symbol,
      inferSeriesDirection(seriesBySymbol[symbol])
    ])),
    seriesBySymbol,
    availableSymbols: symbols,
    generatedAt: new Date().toISOString()
  };
}

function enrichWithCachedCommodities(snapshot, timeframe) {
  const series = { ...(snapshot.seriesBySymbol || {}) };
  let changed = false;
  for (const symbol of correlationSymbols.filter((item) => getPair(item)?.category === "Commodities")) {
    const cached = getCachedOhlcv(symbol, timeframe);
    if (cached?.candles?.length >= 25 && !series[symbol]) {
      series[symbol] = cached.candles;
      changed = true;
    }
  }
  if (!changed) return snapshot;
  const enriched = buildCorrelationSnapshot(series, timeframe);
  cache.set(timeframe, { value: enriched, expiresAt: Date.now() + cacheTtlMs });
  return enriched;
}

export function buildCorrelationContext(snapshot, symbol) {
  if (!snapshot?.matrix?.[symbol]) {
    return unavailableCorrelation("Correlation data is unavailable for this market.");
  }

  const peers = Object.entries(snapshot.matrix[symbol])
    .filter(([peer, value]) => peer !== symbol && Number.isFinite(value?.current))
    .map(([peer, value]) => ({
      symbol: peer,
      correlation: value.current,
      priorCorrelation: value.prior,
      breakdown: value.breakdown,
      trend: snapshot.trends[peer]
    }))
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  return {
    available: peers.length > 0,
    timeframe: snapshot.timeframe,
    peers,
    matrix: snapshot.matrix,
    explanation: peers.length
      ? `Strongest rolling relationship is ${peers[0].symbol} at ${peers[0].correlation.toFixed(2)}.`
      : "No synchronized peer returns were available."
  };
}

export function evaluateCorrelationContext(context, direction) {
  if (!context?.available) {
    return {
      available: false,
      aligned: false,
      conflict: false,
      breakdown: false,
      confidenceAdjustment: 0,
      qualityAdjustment: 0,
      explanation: context?.explanation || "Correlation context unavailable."
    };
  }

  const highlyCorrelated = context.peers.filter((peer) => Math.abs(peer.correlation) >= 0.75);
  const conflicts = highlyCorrelated.filter((peer) => (
    peer.correlation >= 0.75
      ? peer.trend !== "neutral" && peer.trend !== direction
      : peer.trend === direction
  ));
  const aligned = highlyCorrelated.filter((peer) => (
    peer.correlation >= 0.75
      ? peer.trend === direction
      : peer.trend !== "neutral" && peer.trend !== direction
  ));
  const breakdowns = context.peers.filter((peer) => peer.breakdown);

  return {
    available: true,
    peers: context.peers,
    aligned: aligned.length > conflicts.length,
    conflict: conflicts.length > 0,
    breakdown: breakdowns.length > 0,
    confidenceAdjustment: conflicts.length
      ? -Math.min(10, 4 + conflicts.length * 2)
      : aligned.length
        ? Math.min(5, aligned.length * 2)
        : 0,
    qualityAdjustment: conflicts.length ? -6 : aligned.length ? 3 : 0,
    explanation: conflicts.length
      ? `Highly correlated conflict from ${conflicts.map((peer) => peer.symbol).join(", ")} reduced confidence.`
      : breakdowns.length
        ? `Correlation breakdown detected in ${breakdowns.map((peer) => peer.symbol).join(", ")}; cross-market confirmation is less reliable.`
        : aligned.length
          ? `Correlated markets ${aligned.map((peer) => peer.symbol).join(", ")} align with this direction.`
          : "No high-correlation peer materially changes the setup."
  };
}

async function loadSnapshot(timeframe) {
  const series = {};
  const eagerSymbols = correlationSymbols.filter((symbol) => getPair(symbol)?.category === "Crypto");
  const settled = await Promise.allSettled(
    eagerSymbols.map((symbol) => getOhlcv(symbol, timeframe))
  );
  settled.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value.candles.length >= 25) {
      series[eagerSymbols[index]] = result.value.candles;
    }
  });
  for (const symbol of correlationSymbols.filter((item) => getPair(item)?.category === "Commodities")) {
    const cached = getCachedOhlcv(symbol, timeframe);
    if (cached?.candles?.length >= 25) series[symbol] = cached.candles;
  }
  return buildCorrelationSnapshot(series, timeframe);
}

function rollingCorrelation(leftCandles, rightCandles) {
  const aligned = alignReturns(leftCandles, rightCandles);
  if (aligned.left.length < 20) return { current: null, prior: null, breakdown: false };
  const currentLeft = aligned.left.slice(-30);
  const currentRight = aligned.right.slice(-30);
  const priorLeft = aligned.left.slice(-60, -30);
  const priorRight = aligned.right.slice(-60, -30);
  const current = pearson(currentLeft, currentRight);
  const prior = priorLeft.length >= 15 ? pearson(priorLeft, priorRight) : current;
  return {
    current: round(current),
    prior: round(prior),
    breakdown: Number.isFinite(current) && Number.isFinite(prior) &&
      Math.abs(current - prior) >= 0.35
  };
}

function alignReturns(leftCandles, rightCandles) {
  const left = returnMap(leftCandles);
  const right = returnMap(rightCandles);
  const times = [...left.keys()].filter((time) => right.has(time)).sort((a, b) => a - b);
  return {
    left: times.map((time) => left.get(time)),
    right: times.map((time) => right.get(time))
  };
}

function returnMap(candles) {
  const map = new Map();
  for (let index = 1; index < candles.length; index += 1) {
    const previous = Number(candles[index - 1].close);
    const current = Number(candles[index].close);
    if (previous > 0 && current > 0) {
      map.set(Number(candles[index].time), Math.log(current / previous));
    }
  }
  return map;
}

function pearson(left, right) {
  if (left.length !== right.length || !left.length) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator ? numerator / denominator : 0;
}

function inferSeriesDirection(candles) {
  const closes = candles.slice(-20).map((candle) => Number(candle.close));
  if (closes.length < 2) return "neutral";
  const change = (closes.at(-1) - closes[0]) / closes[0];
  if (change > 0.005) return "long";
  if (change < -0.005) return "short";
  return "neutral";
}

function unavailableCorrelation(explanation) {
  return {
    available: false,
    timeframe: null,
    peers: [],
    matrix: {},
    explanation
  };
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}
