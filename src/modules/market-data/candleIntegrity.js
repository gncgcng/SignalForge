export const timeframeDurationSeconds = Object.freeze({
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400
});

const oneHourSeconds = timeframeDurationSeconds["1h"];
const fourHourSeconds = timeframeDurationSeconds["4h"];

export function normalizeCanonicalCandles(candles = []) {
  const byStart = new Map();
  for (const source of candles) {
    const candle = {
      time: Number(source?.time),
      open: Number(source?.open),
      high: Number(source?.high),
      low: Number(source?.low),
      close: Number(source?.close),
      volume: Number(source?.volume)
    };
    if (!isValidCandle(candle)) continue;
    byStart.set(candle.time, candle);
  }
  return [...byStart.values()].sort((left, right) => left.time - right.time);
}

export function selectCompletedCandles(candles, timeframe, input = {}) {
  const duration = timeframeDurationSeconds[timeframe];
  if (!duration) return [];
  const nowSeconds = Math.floor(Number(input.nowMs ?? Date.now()) / 1000);
  const limit = positiveInteger(input.limit, Number.POSITIVE_INFINITY);
  return normalizeCanonicalCandles(candles)
    .filter((candle) => candle.time + duration <= nowSeconds)
    .slice(-limit);
}

export function aggregateHourlyCandlesToFourHours(candles, input = {}) {
  const nowSeconds = Math.floor(Number(input.nowMs ?? Date.now()) / 1000);
  const completedOnly = input.completedOnly !== false;
  const limit = positiveInteger(input.limit, Number.POSITIVE_INFINITY);
  const groups = new Map();

  for (const candle of normalizeCanonicalCandles(candles)) {
    if (candle.time > nowSeconds) continue;
    if (candle.time % oneHourSeconds !== 0) continue;
    const bucketStart = Math.floor(candle.time / fourHourSeconds) * fourHourSeconds;
    const componentIndex = (candle.time - bucketStart) / oneHourSeconds;
    if (!Number.isInteger(componentIndex) || componentIndex < 0 || componentIndex > 3) continue;
    if (!groups.has(bucketStart)) groups.set(bucketStart, new Map());
    groups.get(bucketStart).set(componentIndex, candle);
  }

  const aggregated = [];
  for (const [bucketStart, componentsByIndex] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const bucketCompleted = bucketStart + fourHourSeconds <= nowSeconds;
    if (completedOnly && !bucketCompleted) continue;

    const components = [];
    for (let index = 0; index < 4; index += 1) {
      const component = componentsByIndex.get(index);
      if (!component) {
        components.length = 0;
        break;
      }
      components.push(component);
    }
    if (components.length !== 4) continue;

    aggregated.push({
      time: bucketStart,
      open: components[0].open,
      high: Math.max(...components.map((candle) => candle.high)),
      low: Math.min(...components.map((candle) => candle.low)),
      close: components.at(-1).close,
      volume: components.reduce((sum, candle) => sum + candle.volume, 0)
    });
  }

  return aggregated.slice(-limit);
}

export function inspectCandleIntervals(candles, timeframe) {
  const duration = timeframeDurationSeconds[timeframe];
  const canonical = normalizeCanonicalCandles(candles);
  const missingIntervals = [];
  if (duration) {
    for (let index = 1; index < canonical.length; index += 1) {
      const difference = canonical[index].time - canonical[index - 1].time;
      if (difference > duration) {
        missingIntervals.push({
          after: canonical[index - 1].time,
          before: canonical[index].time,
          missing: Math.max(0, Math.round(difference / duration) - 1)
        });
      }
    }
  }
  return {
    chronological: canonical.every((candle, index) => index === 0 || candle.time > canonical[index - 1].time),
    duplicateCount: Math.max(0, (candles?.length || 0) - canonical.length),
    missingIntervalCount: missingIntervals.reduce((sum, gap) => sum + gap.missing, 0),
    missingIntervals
  };
}

function isValidCandle(candle) {
  return Number.isInteger(candle.time) && candle.time >= 0 &&
    [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0) &&
    Number.isFinite(candle.volume) && candle.volume >= 0 &&
    candle.high >= Math.max(candle.open, candle.close, candle.low) &&
    candle.low <= Math.min(candle.open, candle.close, candle.high);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

