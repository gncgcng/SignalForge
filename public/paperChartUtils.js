export function getPaperChartWindow(total, visibleCount = 120, requestedEnd = null) {
  const count = Math.max(1, Math.min(Number(total || 0), Math.round(Number(visibleCount || 120))));
  const end = Math.max(count, Math.min(Number(total || 0), requestedEnd == null ? Number(total || 0) : Math.round(requestedEnd)));
  return { start: Math.max(0, end - count), end, count };
}

export function priceAtPaperChartCoordinate(y, dimensions) {
  const plotHeight = dimensions.height - dimensions.top - dimensions.bottom;
  const ratio = Math.max(0, Math.min(1, (Number(y) - dimensions.top) / plotHeight));
  return dimensions.max - ratio * (dimensions.max - dimensions.min);
}

export function candleAtPaperChartCoordinate(x, candles, dimensions) {
  if (!candles.length) return null;
  const plotWidth = dimensions.width - dimensions.left - dimensions.right;
  const ratio = Math.max(0, Math.min(0.999999, (Number(x) - dimensions.left) / plotWidth));
  const index = Math.max(0, Math.min(candles.length - 1, Math.floor(ratio * candles.length)));
  return { candle: candles[index], index };
}

export function getSignalReviewLevels(review) {
  if (!review) return [];
  return [
    { type: "entry", label: "ENTRY", price: Number(review.entry) },
    { type: "stop", label: "STOP LOSS", price: Number(review.stopLoss) },
    { type: "target", label: "TAKE PROFIT", price: Number(review.takeProfit) }
  ].filter((level) => Number.isFinite(level.price));
}

export function addPaperDrawingPoint(drawings, input) {
  const list = Array.isArray(drawings) ? drawings : [];
  if (input.tool === "horizontal") {
    const drawing = {
      id: input.id,
      type: "horizontal",
      symbol: input.symbol,
      timeframe: input.timeframe,
      price: Number(input.price)
    };
    return { drawings: [...list, drawing], pending: null, selectedId: drawing.id };
  }
  if (input.tool !== "trend") return { drawings: list, pending: null, selectedId: null };
  if (!input.pending) {
    return {
      drawings: list,
      pending: { time: Number(input.time), price: Number(input.price) },
      selectedId: null
    };
  }
  const drawing = {
    id: input.id,
    type: "trend",
    symbol: input.symbol,
    timeframe: input.timeframe,
    start: input.pending,
    end: { time: Number(input.time), price: Number(input.price) }
  };
  return { drawings: [...list, drawing], pending: null, selectedId: drawing.id };
}

export function deletePaperDrawing(drawings, selectedId) {
  return (drawings || []).filter((drawing) => drawing.id !== selectedId);
}

export function getSignalReviewFrame(candles, review, outcomeCandleTime, padding = 12) {
  if (!candles.length || !review) return { visibleCount: 120, endIndex: candles.length };
  const createdSeconds = new Date(review.createdAt || 0).getTime() / 1000;
  const createdIndex = nearestCandleIndex(candles, createdSeconds);
  const outcomeIndex = outcomeCandleTime == null
    ? candles.length - 1
    : nearestCandleIndex(candles, Number(outcomeCandleTime));
  const start = Math.max(0, Math.min(createdIndex, outcomeIndex) - padding);
  const end = Math.min(candles.length, Math.max(createdIndex, outcomeIndex) + padding + 1);
  return { visibleCount: Math.max(30, end - start), endIndex: end };
}

function nearestCandleIndex(candles, target) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  candles.forEach((candle, index) => {
    const distance = Math.abs(Number(candle.time) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

