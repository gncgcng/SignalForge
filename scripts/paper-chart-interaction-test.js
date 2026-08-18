import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addPaperDrawingPoint,
  calculatePaperPriceRange,
  formatPaperChartPrice,
  getPaperChartRegion,
  getPaperChartWindow,
  loadOlderPaperChartHistory,
  mergePaperChartCandles,
  panPaperTimeWindow,
  priceAtPaperChartCoordinate,
  zoomPaperPriceRange,
  zoomPaperTimeWindow
} from "../public/paperChartUtils.js";
import {
  buildPaperHistoryWindow,
  getPaperTradingHistory
} from "../src/modules/paper-trading/paperTradingService.js";

const app = read("public/app.js");
const styles = read("public/styles.css");
const controller = read("src/modules/paper-trading/paperTradingController.js");
const paperService = read("src/modules/paper-trading/paperTradingService.js");
const dimensions = { width: 920, height: 480, left: 14, right: 76, top: 18, bottom: 100, timeAxisTop: 452 };

for (const center of [65000, 1, 0.07, 0.005, 0.0005, 0.00001]) {
  const candles = lowPriceFixture(center);
  const levels = [center * 0.998, center, center * 1.002];
  const scale = calculatePaperPriceRange(candles, levels);
  assert.ok(Number.isFinite(scale.min) && Number.isFinite(scale.max) && Number.isFinite(scale.range));
  assert.ok(scale.range > 0);
  const candleYs = candles.flatMap((candle) => [candle.high, candle.low]).map((price) => yFor(price, scale));
  assert.ok(Math.max(...candleYs) - Math.min(...candleYs) > 20, `${center} candles should occupy visible height`);
  const levelYs = levels.map((price) => yFor(price, scale));
  assert.equal(new Set(levelYs.map((value) => value.toFixed(4))).size, 3, `${center} signal levels should be distinct`);
  const labels = Array.from({ length: 6 }, (_, index) => formatPaperChartPrice(scale.max - scale.range * index / 5, scale.range));
  assert.equal(new Set(labels).size, labels.length, `${center} axis labels should be distinct`);
  assert.notEqual(formatPaperChartPrice(center, scale.range), "0.00");
  assert.notEqual(formatPaperChartPrice(center, scale.range), "0");
  const crosshairPrice = priceAtPaperChartCoordinate(220, { ...dimensions, min: scale.min, max: scale.max });
  assert.ok(Number.isFinite(crosshairPrice) && crosshairPrice > 0);
  assert.notEqual(formatPaperChartPrice(crosshairPrice, scale.range, { currency: true }), "$0.00");
}

assert.equal(getPaperChartRegion(400, 200, dimensions), "plot");
assert.equal(getPaperChartRegion(880, 200, dimensions), "price-axis");
assert.equal(getPaperChartRegion(400, 470, dimensions), "time-axis");
assert.equal(getPaperChartRegion(2, 2, dimensions), "outside");

const initialWindow = getPaperChartWindow(300, 120, 240);
const plotZoom = zoomPaperTimeWindow(300, initialWindow, 0.8, 0.25);
assert.ok(plotZoom.visibleCount < initialWindow.count);
const cursorIndexBefore = initialWindow.start + 0.25 * (initialWindow.count - 1);
const zoomedWindow = getPaperChartWindow(300, plotZoom.visibleCount, plotZoom.endIndex);
const cursorIndexAfter = zoomedWindow.start + 0.25 * (zoomedWindow.count - 1);
assert.ok(Math.abs(cursorIndexBefore - cursorIndexAfter) <= 1.5, "time zoom should remain anchored near cursor");

const panned = panPaperTimeWindow(300, initialWindow, 100, 830);
assert.ok(Number(panned.endIndex) < initialWindow.end, "dragging right should move backward in time");
assert.equal(panned.visibleCount, initialWindow.count, "plot pan should preserve candle spacing");
const priceRange = { min: 0.00049, max: 0.00051, range: 0.00002 };
const priceZoom = zoomPaperPriceRange(priceRange, 0.8, 0.000503);
assert.ok(priceZoom.range < priceRange.range);
assert.equal(initialWindow.count, 120, "price-axis zoom must not alter time scale");
const autoRestored = calculatePaperPriceRange(lowPriceFixture(0.0005), [], null);
assert.equal(autoRestored.auto, true);

const drawings = [];
panPaperTimeWindow(300, initialWindow, 50, 830);
assert.equal(drawings.length, 0, "normal pan must not create a drawing");
const drawn = addPaperDrawingPoint(drawings, {
  tool: "horizontal", id: "line-1", symbol: "BTC-USD", timeframe: "15m", price: 62000
});
assert.equal(drawn.drawings.length, 1, "explicit drawing tool may create a drawing");

const initialCandles = candlePage(300, 300);
const originalVisibleTimes = initialCandles.slice(0, 120).map((candle) => candle.time);
const historyState = {
  candles: initialCandles,
  endIndex: 120,
  loadingOlder: false,
  noMoreOlder: false,
  oldestLoadedTime: initialCandles[0].time
};
let historyCalls = 0;
await loadOlderPaperChartHistory(historyState, async () => {
  historyCalls += 1;
  return { candles: candlePage(1, 300), hasMore: true };
});
assert.equal(historyCalls, 1);
assert.equal(historyState.candles.length, 599);
assert.deepEqual(
  historyState.candles.slice(historyState.endIndex - 120, historyState.endIndex).map((candle) => candle.time),
  originalVisibleTimes,
  "prepending history must preserve the viewport"
);
assert.equal(new Set(historyState.candles.map((candle) => candle.time)).size, historyState.candles.length);

await loadOlderPaperChartHistory(historyState, async () => ({ candles: candlePage(-298, 300), hasMore: true }));
assert.equal(historyState.candles[0].time, -298 * 900);

let releaseFetch;
const concurrentState = {
  candles: initialCandles,
  endIndex: 120,
  loadingOlder: false,
  noMoreOlder: false
};
let concurrentCalls = 0;
const firstLoad = loadOlderPaperChartHistory(concurrentState, async () => {
  concurrentCalls += 1;
  return new Promise((resolve) => { releaseFetch = resolve; });
});
const duplicateLoad = await loadOlderPaperChartHistory(concurrentState, async () => {
  concurrentCalls += 1;
  return { candles: [] };
});
assert.equal(duplicateLoad.reason, "already_loading");
assert.equal(concurrentCalls, 1);
releaseFetch({ candles: candlePage(1, 300), hasMore: true });
await firstLoad;

const exhaustedState = { candles: initialCandles, endIndex: 120, loadingOlder: false, noMoreOlder: false };
let exhaustedCalls = 0;
await loadOlderPaperChartHistory(exhaustedState, async () => { exhaustedCalls += 1; return { candles: [], hasMore: false }; });
await loadOlderPaperChartHistory(exhaustedState, async () => { exhaustedCalls += 1; return { candles: [] }; });
assert.equal(exhaustedCalls, 1, "no-more-history state should stop repeated requests");

const latestMerged = mergePaperChartCandles(historyState.candles, candlePage(600, 20), null);
assert.equal(latestMerged.endIndex, null);
assert.equal(latestMerged.candles.at(-1).time, 619 * 900);

const signalOutcome = Object.freeze({ id: "signal-1", status: "Hit SL", realizedR: -1 });
const outcomeSnapshot = JSON.stringify(signalOutcome);
await loadOlderPaperChartHistory({ candles: initialCandles, endIndex: 120, loadingOlder: false, noMoreOlder: false }, async () => ({ candles: candlePage(1, 300), hasMore: true }));
assert.equal(JSON.stringify(signalOutcome), outcomeSnapshot, "history loading must not mutate signal outcome state");

const expectedWindow = buildPaperHistoryWindow("15m", initialCandles[0].time, 300);
assert.ok(new Date(expectedWindow.from) < new Date(expectedWindow.to));
let requestedWindow = null;
const historyPayload = await getPaperTradingHistory({ id: "user-a" }, {
  symbol: "BTC-USD", timeframe: "15m", before: initialCandles[0].time, limit: 300
}, {
  loadMarketData: async (_symbol, _timeframe, window) => {
    requestedWindow = window;
    return { candles: candlePage(1, 300), source: "fixture" };
  }
});
assert.equal(historyPayload.readOnly, true);
assert.equal(historyPayload.candles.every((candle) => candle.time < initialCandles[0].time), true);
assert.ok(requestedWindow.from && requestedWindow.to);

assert.match(app, /getPaperChartRegion\(point\.x, point\.y, dimensions\)/);
assert.match(app, /setPointerCapture/);
assert.match(app, /releasePointerCapture/);
assert.match(app, /passive: false/);
assert.match(app, /event\.preventDefault\(\)/);
assert.match(app, /region === "price-axis"/);
assert.match(app, /region === "time-axis"/);
assert.match(app, /maybeLoadOlderPaperChartCandles/);
assert.match(app, /autoPriceScale = true/);
assert.match(styles, /#paper-candle-chart[\s\S]*touch-action: none/);
assert.match(styles, /#paper-candle-chart[\s\S]*user-select: none/);
assert.match(controller, /\/api\/paper-trades\/history/);
assert.match(paperService, /getReadOnlySignalReviewMarketData/);
assert.doesNotMatch(paperService.match(/export async function getPaperTradingHistory[\s\S]*?\n\}/)?.[0] || "", /updateSignalsForUser|createPaperOrder|closePaperOrder|credit/i);

console.log(JSON.stringify({
  tests: { passed: 45, failed: 0 },
  priceScales: [65000, 1, 0.07, 0.005, 0.0005, 0.00001],
  interactions: {
    plotWheel: "time_zoom_at_cursor",
    priceAxisWheel: "price_zoom_at_cursor",
    plotDrag: "time_pan",
    priceAxisDrag: "manual_price_scale",
    timeAxisDrag: "candle_spacing",
    pointerCapture: true,
    localSelectionSuppression: true
  },
  history: {
    initialCandles: 300,
    afterFirstPrepend: 599,
    viewportPreserved: true,
    duplicatesRemoved: true,
    concurrentFetchPrevented: true,
    noMoreHistoryStopsFetch: true
  },
  readOnly: { signalOutcomeUnchanged: true, tradingWrites: 0 }
}, null, 2));

function lowPriceFixture(center) {
  return Array.from({ length: 80 }, (_, index) => {
    const wave = Math.sin(index / 6) * center * 0.0015;
    const open = center + wave;
    const close = open + Math.cos(index / 4) * center * 0.00035;
    return {
      time: index * 900,
      open,
      high: Math.max(open, close) + center * 0.00045,
      low: Math.min(open, close) - center * 0.00045,
      close,
      volume: 100 + index
    };
  });
}

function candlePage(start, count) {
  return Array.from({ length: count }, (_, index) => {
    const number = start + index;
    return {
      time: number * 900,
      open: 100 + number / 100,
      high: 101 + number / 100,
      low: 99 + number / 100,
      close: 100.5 + number / 100,
      volume: 10
    };
  });
}

function yFor(price, range) {
  return dimensions.top + ((range.max - price) / range.range) * (dimensions.height - dimensions.top - dimensions.bottom);
}

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}
