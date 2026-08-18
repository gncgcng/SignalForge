export function getPaperChartWindow(total, visibleCount = 120, requestedEnd = null) {
  const safeTotal = Math.max(0, Math.round(Number(total || 0)));
  if (!safeTotal) return { start: 0, end: 0, count: 0 };
  const count = Math.max(1, Math.min(safeTotal, Math.round(Number(visibleCount || 120))));
  const end = Math.max(count, Math.min(safeTotal, requestedEnd == null ? safeTotal : Math.round(requestedEnd)));
  return { start: Math.max(0, end - count), end, count };
}

export function getPaperTimelineWindow(totalCandles, visibleCount = 120, requestedEnd = null, options = {}) {
  const total = Math.max(0, Math.round(Number(totalCandles || 0)));
  const count = Math.max(1, Math.round(Number(visibleCount || 120)));
  const rightOffsetRatio = Math.max(0, Math.min(0.45, Number(options.rightOffsetRatio ?? 0.2)));
  const maxFutureRatio = Math.max(rightOffsetRatio, Math.min(0.9, Number(options.maxFutureRatio ?? 0.8)));
  const futureSlots = Math.max(1, Math.round(count * rightOffsetRatio));
  const maxFutureSlots = Math.max(futureSlots, Math.round(count * maxFutureRatio));
  const latestEnd = Math.max(count, total + futureSlots);
  const maxEnd = Math.max(latestEnd, total + maxFutureSlots);
  const end = requestedEnd == null
    ? latestEnd
    : Math.max(count, Math.min(maxEnd, Math.round(Number(requestedEnd))));
  const start = Math.max(0, end - count);
  return {
    start,
    end,
    count,
    totalCandles: total,
    candleStart: Math.max(0, Math.min(total, start)),
    candleEnd: Math.max(0, Math.min(total, end)),
    futureSlots,
    maxFutureSlots,
    latestEnd,
    maxEnd,
    atLatest: requestedEnd == null
  };
}

export function getPaperTimeframeSeconds(timeframe) {
  return ({ "5m": 300, "15m": 900, "1h": 3600, "4h": 14400 })[timeframe] || 900;
}

export function getPaperTimelineTime(candles, timeframe, absoluteIndex) {
  const list = Array.isArray(candles) ? candles : [];
  const index = Number(absoluteIndex);
  if (!list.length || !Number.isFinite(index)) return null;
  const exact = list[Math.round(index)];
  if (Number.isInteger(index) && Number.isFinite(Number(exact?.time))) return Number(exact.time);
  const interval = getPaperTimeframeSeconds(timeframe);
  if (index >= list.length - 1) return Number(list.at(-1).time) + (index - (list.length - 1)) * interval;
  if (index <= 0) return Number(list[0].time) + index * interval;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.min(list.length - 1, Math.ceil(index));
  const lowerTime = Number(list[lowerIndex]?.time);
  const upperTime = Number(list[upperIndex]?.time);
  if (!(Number.isFinite(lowerTime) && Number.isFinite(upperTime))) return null;
  return lowerTime + (upperTime - lowerTime) * (index - lowerIndex);
}

export function getPaperTimelinePosition(candles, timeframe, time) {
  const list = Array.isArray(candles) ? candles : [];
  const target = Number(time);
  if (!list.length || !Number.isFinite(target)) return null;
  const interval = getPaperTimeframeSeconds(timeframe);
  const firstTime = Number(list[0].time);
  const lastTime = Number(list.at(-1).time);
  if (target <= firstTime) return (target - firstTime) / interval;
  if (target >= lastTime) return list.length - 1 + (target - lastTime) / interval;
  let low = 0;
  let high = list.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(list[middle].time) <= target) low = middle;
    else high = middle;
  }
  const lowTime = Number(list[low].time);
  const highTime = Number(list[high].time);
  const ratio = highTime > lowTime ? (target - lowTime) / (highTime - lowTime) : 0;
  return low + ratio;
}

export function getPaperTimelinePointAtCoordinate(x, candles, timeframe, timeline, dimensions) {
  if (!timeline?.count || !candles?.length) return null;
  const plotWidth = dimensions.width - dimensions.left - dimensions.right;
  const ratio = Math.max(0, Math.min(0.999999, (Number(x) - dimensions.left) / plotWidth));
  const absoluteIndex = timeline.start + Math.floor(ratio * timeline.count);
  const candle = absoluteIndex >= 0 && absoluteIndex < candles.length ? candles[absoluteIndex] : null;
  return {
    candle,
    index: candle ? absoluteIndex - timeline.candleStart : null,
    absoluteIndex,
    time: getPaperTimelineTime(candles, timeframe, absoluteIndex),
    isFuture: absoluteIndex >= candles.length
  };
}

export function getPaperChartDimensions(stageWidth, stageHeight, options = {}) {
  const measuredWidth = Number(stageWidth);
  const measuredHeight = Number(stageHeight);
  if (!(Number.isFinite(measuredWidth) && measuredWidth > 0 && Number.isFinite(measuredHeight) && measuredHeight > 0)) {
    return null;
  }
  const width = Math.max(320, Math.round(measuredWidth));
  const height = Math.max(260, Math.round(measuredHeight));
  const mobile = Boolean(options.mobile);
  const labelLength = Math.max(7, ...(options.priceLabels || []).map((label) => String(label).length));
  const right = Math.max(mobile ? 68 : 72, Math.min(112, labelLength * 6.4 + 20));
  const left = mobile ? 6 : 10;
  const top = mobile ? 10 : 14;
  const timeAxisHeight = mobile ? 30 : 28;
  const volumeHeight = options.volume
    ? Math.max(42, Math.min(88, Math.round(height * 0.15)))
    : 0;
  const bottom = timeAxisHeight + volumeHeight;
  const dimensions = {
    width,
    height,
    left,
    right,
    top,
    bottom,
    timeAxisHeight,
    volumeHeight,
    timeAxisTop: height - timeAxisHeight,
    priceAxisHitWidth: mobile ? Math.max(92, right) : right,
    timeAxisHitHeight: mobile ? 44 : timeAxisHeight,
    plotWidth: width - left - right,
    plotHeight: height - top - bottom
  };
  return dimensions.plotWidth > 0 && dimensions.plotHeight > 0 ? dimensions : null;
}

export function calculatePaperCandleGeometry(candles, timeline, priceRange, dimensions) {
  const list = Array.isArray(candles) ? candles : [];
  const min = Number(priceRange?.min);
  const max = Number(priceRange?.max);
  const range = Number(priceRange?.range);
  if (
    !dimensions || !timeline?.count || !list.length ||
    !(Number.isFinite(dimensions.plotWidth) && dimensions.plotWidth > 0) ||
    !(Number.isFinite(dimensions.plotHeight) && dimensions.plotHeight > 0) ||
    !(Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(range) && min < max && range > 0)
  ) {
    return { valid: false, reason: "invalid_chart_geometry", items: [] };
  }

  const slot = dimensions.plotWidth / timeline.count;
  const candleWidth = Math.max(2.5, Math.min(14, slot * 0.58));
  const xForAbsoluteIndex = (absoluteIndex) => dimensions.left + (Number(absoluteIndex) - timeline.start) * slot + slot / 2;
  const yForPrice = (price) => dimensions.top + ((max - Number(price)) / range) * dimensions.plotHeight;
  const visible = list.slice(timeline.candleStart, timeline.candleEnd);
  const items = visible.map((candle, index) => {
    const absoluteIndex = timeline.candleStart + index;
    return {
      candle,
      absoluteIndex,
      x: xForAbsoluteIndex(absoluteIndex),
      openY: yForPrice(candle.open),
      highY: yForPrice(candle.high),
      lowY: yForPrice(candle.low),
      closeY: yForPrice(candle.close),
      width: candleWidth
    };
  });
  const coordinatesValid = items.length > 0 && items.every((item) =>
    Number.isFinite(item.x) && Number.isFinite(item.openY) && Number.isFinite(item.highY) &&
    Number.isFinite(item.lowY) && Number.isFinite(item.closeY) && Number.isFinite(item.width) && item.width > 0
  );
  const plotRight = dimensions.width - dimensions.right;
  const hasVisibleCandle = items.some((item) => item.x >= dimensions.left && item.x <= plotRight);
  if (!coordinatesValid || !hasVisibleCandle) {
    return { valid: false, reason: coordinatesValid ? "candles_outside_plot" : "invalid_candle_coordinates", items };
  }
  return {
    valid: true,
    reason: null,
    items,
    visible,
    slot,
    candleWidth,
    plotLeft: dimensions.left,
    plotRight,
    newestRealCandleX: xForAbsoluteIndex(list.length - 1),
    xForAbsoluteIndex,
    xForVisibleIndex: (visibleIndex) => xForAbsoluteIndex(timeline.candleStart + Number(visibleIndex)),
    yForPrice
  };
}

export function calculatePaperWorkspaceHeight(viewportWidth, viewportHeight, layoutTop = 0) {
  const width = Math.max(0, Number(viewportWidth || 0));
  const height = Math.max(0, Number(viewportHeight || 0));
  if (!(width > 0 && height > 0)) return 0;
  const top = Math.max(0, Number(layoutTop || 0));
  const landscapeMobile = width <= 900 && width > height;
  const minimum = width <= 900 ? (landscapeMobile ? 280 : 440) : 500;
  return Math.round(Math.max(minimum, Math.min(height - 8, height - top - 8)));
}

export function getPaperTimeAxisTicks(timeline, candles, timeframe, plotWidth, minimumSpacing = 110) {
  if (!timeline?.count || !candles?.length) return [];
  const tickCount = Math.max(3, Math.min(10, Math.floor(Number(plotWidth || 0) / Math.max(70, Number(minimumSpacing || 110))) + 1));
  return Array.from({ length: tickCount }, (_, tick) => {
    const ratio = tickCount === 1 ? 0 : tick / (tickCount - 1);
    const absoluteIndex = timeline.start + ratio * Math.max(0, timeline.count - 1);
    return { ratio, absoluteIndex, time: getPaperTimelineTime(candles, timeframe, absoluteIndex) };
  }).filter((tick) => Number.isFinite(tick.time));
}

export function calculatePaperPriceRange(candles, levels = [], manualRange = null, paddingRatio = 0.08) {
  if (isValidPriceRange(manualRange)) return { ...manualRange, auto: false };
  const candlePrices = (candles || []).flatMap((candle) => [Number(candle.low), Number(candle.high)]);
  const prices = [...candlePrices, ...(levels || []).map(Number)].filter(Number.isFinite);
  if (!prices.length) return { min: 0, max: 1, range: 1, auto: true };

  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const magnitude = Math.max(Math.abs(low), Math.abs(high), Number.MIN_VALUE);
  const numericEpsilon = Math.max(magnitude * 1e-8, Number.EPSILON * magnitude * 128, Number.MIN_VALUE);
  const visibleRange = Math.max(high - low, numericEpsilon);
  const padding = Math.max(visibleRange * Math.max(0, Number(paddingRatio) || 0), numericEpsilon);
  const min = low - padding;
  const max = high + padding;
  return { min, max, range: max - min, auto: true };
}

export function formatPaperChartPrice(value, visibleRange = null, options = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  const absolute = Math.abs(numeric);
  const range = Math.abs(Number(visibleRange));
  const magnitudeDecimals = absolute >= 1000 ? 2
    : absolute >= 100 ? 3
      : absolute >= 1 ? 4
        : absolute >= 0.1 ? 5
          : absolute >= 0.01 ? 6
            : absolute >= 0.001 ? 7
              : absolute >= 0.0001 ? 8
                : 10;
  const rangeDecimals = Number.isFinite(range) && range > 0
    ? Math.max(0, Math.ceil(-Math.log10(range / 6)) + 1)
    : 0;
  let decimals = Math.min(12, Math.max(magnitudeDecimals, rangeDecimals));
  let formatted = numeric.toFixed(decimals);
  while (numeric !== 0 && Number(formatted) === 0 && decimals < 14) {
    decimals += 1;
    formatted = numeric.toFixed(decimals);
  }
  formatted = formatted.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  return options.currency ? `$${formatted}` : formatted;
}

export function getPaperChartRegion(x, y, dimensions) {
  const numericX = Number(x);
  const numericY = Number(y);
  const priceAxisHitWidth = Math.max(dimensions.right, Number(dimensions.priceAxisHitWidth || dimensions.right));
  if (numericX >= dimensions.width - priceAxisHitWidth && numericX <= dimensions.width) return "price-axis";
  const timeAxisTop = dimensions.timeAxisTop ?? dimensions.height - 28;
  const timeAxisHitTop = Math.min(timeAxisTop, dimensions.height - Number(dimensions.timeAxisHitHeight || dimensions.height - timeAxisTop));
  if (numericY >= timeAxisHitTop && numericY <= dimensions.height && numericX >= dimensions.left) return "time-axis";
  if (
    numericX >= dimensions.left && numericX < dimensions.width - dimensions.right &&
    numericY >= dimensions.top && numericY < timeAxisTop
  ) return "plot";
  return "outside";
}

export function zoomPaperTimeWindow(total, window, factor, cursorRatio, limits = {}) {
  const safeTotal = Math.max(0, Math.round(Number(total || 0)));
  if (!safeTotal) return { visibleCount: 0, endIndex: null };
  const maxVisible = Math.min(safeTotal, Math.max(1, Number(limits.max || 300)));
  const minVisible = Math.min(maxVisible, Math.max(1, Number(limits.min || 30)));
  const count = Math.max(1, Number(window?.count || Math.min(120, safeTotal)));
  const nextCount = Math.max(minVisible, Math.min(maxVisible, Math.round(count * Number(factor || 1))));
  const ratio = Math.max(0, Math.min(1, Number(cursorRatio || 0)));
  const anchor = Number(window?.start || 0) + ratio * Math.max(0, count - 1);
  const maxStart = Math.max(0, safeTotal - nextCount);
  const start = Math.max(0, Math.min(maxStart, Math.round(anchor - ratio * Math.max(0, nextCount - 1))));
  const end = start + nextCount;
  return { visibleCount: nextCount, endIndex: end === safeTotal ? null : end };
}

export function panPaperTimeWindow(total, window, dragDistance, plotWidth) {
  const safeTotal = Math.max(0, Math.round(Number(total || 0)));
  if (!safeTotal || !window?.count) return { visibleCount: 0, endIndex: null };
  const slot = Math.max(Number(plotWidth || 0) / window.count, Number.EPSILON);
  const deltaCandles = Math.round(Number(dragDistance || 0) / slot);
  const nextEnd = Math.max(window.count, Math.min(safeTotal, window.end - deltaCandles));
  return { visibleCount: window.count, endIndex: nextEnd === safeTotal ? null : nextEnd };
}

export function zoomPaperPriceRange(currentRange, factor, anchorPrice) {
  if (!isValidPriceRange(currentRange)) return null;
  const scaleFactor = Math.max(0.05, Math.min(20, Number(factor || 1)));
  const anchor = Math.max(currentRange.min, Math.min(currentRange.max, Number(anchorPrice)));
  const anchorRatio = (anchor - currentRange.min) / currentRange.range;
  const range = Math.max(currentRange.range * scaleFactor, Number.EPSILON * Math.max(Math.abs(anchor), 1) * 128);
  const min = anchor - anchorRatio * range;
  return { min, max: min + range, range };
}

export function translatePaperPriceRange(currentRange, dragDistance, plotHeight) {
  if (!isValidPriceRange(currentRange)) return null;
  const height = Math.max(Number(plotHeight || 0), Number.EPSILON);
  const offset = currentRange.range * (Number(dragDistance || 0) / height);
  const min = currentRange.min + offset;
  return { min, max: currentRange.max + offset, range: currentRange.range };
}

export function getPaperPinchTransform(startPoints, currentPoints, threshold = 12) {
  if (!Array.isArray(startPoints) || !Array.isArray(currentPoints) || startPoints.length !== 2 || currentPoints.length !== 2) {
    return null;
  }
  const startDx = Math.abs(Number(startPoints[1].x) - Number(startPoints[0].x));
  const startDy = Math.abs(Number(startPoints[1].y) - Number(startPoints[0].y));
  const currentDx = Math.abs(Number(currentPoints[1].x) - Number(currentPoints[0].x));
  const currentDy = Math.abs(Number(currentPoints[1].y) - Number(currentPoints[0].y));
  const minimum = Math.max(1, Number(threshold || 12));
  const midpoint = (points) => ({
    x: (Number(points[0].x) + Number(points[1].x)) / 2,
    y: (Number(points[0].y) + Number(points[1].y)) / 2
  });
  const startMidpoint = midpoint(startPoints);
  const currentMidpoint = midpoint(currentPoints);
  return {
    timeFactor: startDx >= minimum && currentDx > 0 ? startDx / currentDx : 1,
    priceFactor: startDy >= minimum && currentDy > 0 ? startDy / currentDy : 1,
    startMidpoint,
    currentMidpoint,
    deltaX: currentMidpoint.x - startMidpoint.x,
    deltaY: currentMidpoint.y - startMidpoint.y
  };
}

export function calculatePaperWorkspaceLayout(containerWidth, options = {}) {
  const width = Math.max(0, Number(containerWidth || 0));
  if (options.mobile) return { chartWidth: width, marketsWidth: 0, orderWidth: 0 };
  const gap = Math.max(0, Number(options.gap ?? 8));
  const rail = Math.max(0, Number(options.railWidth ?? 36));
  const marketsWidth = options.marketsCollapsed ? rail : Math.max(0, Number(options.marketsWidth ?? 230));
  const orderWidth = options.orderCollapsed ? rail : Math.max(0, Number(options.orderWidth ?? 330));
  return {
    chartWidth: Math.max(0, width - marketsWidth - orderWidth - gap * 2),
    marketsWidth,
    orderWidth
  };
}

export function mergePaperChartCandles(existingCandles, incomingCandles, endIndex = null) {
  const existing = normalizeCandles(existingCandles);
  const incoming = normalizeCandles(incomingCandles);
  const oldFirstTime = existing[0]?.time;
  const candleMap = new Map(incoming.map((candle) => [candle.time, candle]));
  for (const candle of existing) candleMap.set(candle.time, candle);
  const candles = [...candleMap.values()].sort((a, b) => a.time - b.time);
  const prepended = oldFirstTime == null ? 0 : Math.max(0, candles.findIndex((candle) => candle.time === oldFirstTime));
  return {
    candles,
    added: Math.max(0, candles.length - existing.length),
    prepended,
    endIndex: endIndex == null ? null : Number(endIndex) + prepended
  };
}

export async function loadOlderPaperChartHistory(historyState, fetchPage) {
  if (historyState.loadingOlder) return { loaded: false, reason: "already_loading" };
  if (historyState.noMoreOlder) return { loaded: false, reason: "no_more_history" };
  const before = Number(historyState.candles?.[0]?.time);
  if (!Number.isFinite(before)) return { loaded: false, reason: "no_candles" };

  historyState.loadingOlder = true;
  try {
    const payload = await fetchPage(before);
    const merged = mergePaperChartCandles(historyState.candles, payload?.candles || [], historyState.endIndex);
    historyState.candles = merged.candles;
    historyState.endIndex = merged.endIndex;
    historyState.oldestLoadedTime = merged.candles[0]?.time ?? before;
    historyState.noMoreOlder = payload?.hasMore === false || merged.added === 0;
    return { loaded: merged.added > 0, ...merged };
  } finally {
    historyState.loadingOlder = false;
  }
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
  if (input.tool === "trend") {
    if (!input.pending || input.pending.type !== "trend") {
      return {
        drawings: list,
        pending: { type: "trend", time: Number(input.time), price: Number(input.price) },
        selectedId: null
      };
    }
    const drawing = {
      id: input.id,
      type: "trend",
      symbol: input.symbol,
      timeframe: input.timeframe,
      start: { time: input.pending.time, price: input.pending.price },
      end: { time: Number(input.time), price: Number(input.price) }
    };
    return { drawings: [...list, drawing], pending: null, selectedId: drawing.id };
  }
  if (!["forecast-long", "forecast-short"].includes(input.tool)) {
    return { drawings: list, pending: null, selectedId: null };
  }
  const direction = input.tool === "forecast-long" ? "long" : "short";
  if (!input.pending || input.pending.type !== "forecast" || input.pending.direction !== direction) {
    return {
      drawings: list,
      pending: {
        type: "forecast",
        direction,
        entry: { time: Number(input.time), price: Number(input.price) }
      },
      selectedId: null
    };
  }
  if (!input.pending.target) {
    return {
      drawings: list,
      pending: { ...input.pending, target: { time: Number(input.time), price: Number(input.price) } },
      selectedId: null
    };
  }
  const created = createPaperForecastDrawing({
    id: input.id,
    symbol: input.symbol,
    timeframe: input.timeframe,
    direction,
    entry: input.pending.entry.price,
    target: input.pending.target.price,
    stop: Number(input.price),
    startTime: input.pending.entry.time,
    endTime: Number(input.defaultEndTime ?? input.time)
  });
  if (!created.valid) {
    return { drawings: list, pending: input.pending, selectedId: null, error: created.error };
  }
  return { drawings: [...list, created.drawing], pending: null, selectedId: created.drawing.id };
}

export function createPaperForecastDrawing(input) {
  const direction = input.direction === "short" ? "short" : "long";
  const entry = Number(input.entry);
  const target = Number(input.target);
  const stop = Number(input.stop);
  const startTime = Number(input.startTime);
  const endTime = Number(input.endTime);
  if (![entry, target, stop, startTime, endTime].every(Number.isFinite)) {
    return { valid: false, error: "Forecast points must use valid chart coordinates." };
  }
  const validGeometry = direction === "long" ? target > entry && entry > stop : stop > entry && entry > target;
  if (!validGeometry) {
    return {
      valid: false,
      error: direction === "long" ? "Long forecast requires target above entry and stop below entry." : "Short forecast requires stop above entry and target below entry."
    };
  }
  const drawing = {
    id: input.id,
    type: "forecast",
    symbol: input.symbol,
    timeframe: input.timeframe,
    direction,
    startTime,
    endTime: Math.max(startTime + 1, endTime),
    entry,
    target,
    stop
  };
  return { valid: true, drawing, metrics: calculatePaperForecastMetrics(drawing) };
}

export function calculatePaperForecastMetrics(drawing) {
  const entry = Number(drawing?.entry);
  const target = Number(drawing?.target);
  const stop = Number(drawing?.stop);
  const direction = drawing?.direction === "short" ? "short" : "long";
  if (![entry, target, stop].every(Number.isFinite) || entry === 0) return null;
  const rewardDistance = direction === "long" ? target - entry : entry - target;
  const riskDistance = direction === "long" ? entry - stop : stop - entry;
  if (!(rewardDistance > 0 && riskDistance > 0)) return null;
  return {
    rewardDistance,
    riskDistance,
    riskRewardRatio: rewardDistance / riskDistance,
    targetPercent: ((target - entry) / entry) * 100,
    stopPercent: ((stop - entry) / entry) * 100
  };
}

export function updatePaperForecastDrawing(drawing, handle, update) {
  if (drawing?.type !== "forecast") return drawing;
  const next = { ...drawing };
  const value = Number(update?.price);
  if (["entry", "target", "stop"].includes(handle) && Number.isFinite(value)) next[handle] = value;
  if (handle === "extent" && Number.isFinite(Number(update?.time))) {
    next.endTime = Math.max(Number(next.startTime) + 1, Number(update.time));
  }
  if (handle === "body" && Number.isFinite(Number(update?.priceDelta))) {
    next.entry += Number(update.priceDelta);
    next.target += Number(update.priceDelta);
    next.stop += Number(update.priceDelta);
  }
  return calculatePaperForecastMetrics(next) ? next : drawing;
}

export function deletePaperDrawing(drawings, selectedId) {
  return (drawings || []).filter((drawing) => drawing.id !== selectedId);
}

export function getSignalReviewFrame(candles, review, outcomeCandleTime, padding = 12) {
  if (!candles.length || !review) return { visibleCount: 120, endIndex: candles.length };
  if (review.status === "Active" && outcomeCandleTime == null) {
    return { visibleCount: Math.max(30, Math.min(120, candles.length)), endIndex: null };
  }
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

function isValidPriceRange(range) {
  return Boolean(range) && Number.isFinite(range.min) && Number.isFinite(range.max) &&
    Number.isFinite(range.range) && range.range > 0 && range.max > range.min;
}

function normalizeCandles(candles) {
  return (candles || [])
    .map((candle) => ({
      ...candle,
      time: Number(candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume || 0)
    }))
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
    .sort((a, b) => a.time - b.time)
    .filter((candle, index, list) => index === 0 || candle.time !== list[index - 1].time);
}
