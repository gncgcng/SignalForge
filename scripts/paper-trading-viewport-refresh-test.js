import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createPaperForecastDrawing,
  getPaperTimelineWindow,
  mergePaperChartCandles
} from "../public/paperChartUtils.js";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const loaderStart = appSource.indexOf("async function loadPaperTradingTerminal(");
const loaderEnd = appSource.indexOf("function openSignalReview", loaderStart);
assert.ok(loaderStart >= 0 && loaderEnd > loaderStart, "production Paper Trading loader must be extractable");
const loaderSource = appSource.slice(loaderStart, loaderEnd);

const candles = Array.from({ length: 120 }, (_, index) => {
  const open = 64_000 + index * 5;
  const close = open + (index % 2 ? -12 : 16);
  return {
    time: 1_700_000_000 + index * 900,
    open,
    high: Math.max(open, close) + 20,
    low: Math.min(open, close) - 18,
    close,
    volume: 1_000 + index * 4
  };
});

const forecast = createPaperForecastDrawing({
  id: "forecast-1",
  symbol: "BTC-USD",
  timeframe: "15m",
  direction: "long",
  entry: 64_500,
  target: 65_200,
  stop: 64_150,
  startTime: candles[70].time,
  endTime: candles.at(-1).time + 12 * 900
});
assert.equal(forecast.valid, true);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function terminalPayload(nextCandles, options = {}) {
  const symbol = options.symbol || "BTC-USD";
  const timeframe = options.timeframe || "15m";
  return {
    account: { balance: 10_000 },
    orders: [],
    markets: [{ symbol, displaySymbol: symbol.replace("-", "") }],
    marketData: options.marketData === null ? null : {
      pair: { symbol, lastPrice: nextCandles.at(-1)?.close || null },
      candles: nextCandles,
      lastCandleAt: nextCandles.at(-1)?.time || null,
      marketStatus: { label: "Live" },
      timeframe
    },
    marketError: options.marketError || null
  };
}

function createViewport() {
  return {
    visibleCount: 54,
    endIndex: 96,
    autoPriceScale: false,
    manualPriceRange: { min: 63_900, max: 65_450, range: 1_550 },
    loadingOlder: false,
    noMoreOlder: true,
    oldestLoadedTime: candles[0].time,
    historyRequestKey: null,
    drawings: [
      { id: "horizontal-1", type: "horizontal", symbol: "BTC-USD", timeframe: "15m", price: 64_420 },
      { id: "trend-1", type: "trend", symbol: "BTC-USD", timeframe: "15m", startTime: candles[50].time, endTime: candles[80].time, startPrice: 64_100, endPrice: 64_620 },
      forecast.drawing
    ],
    activeTool: null,
    pendingDrawing: null,
    selectedDrawingId: "forecast-1"
  };
}

function makeHarness(request, options = {}) {
  const classNames = new Set(["hidden"]);
  const paperChartLoading = {
    textContent: "Loading live candles...",
    classList: {
      add: (name) => classNames.add(name),
      remove: (name) => classNames.delete(name),
      contains: (name) => classNames.has(name)
    }
  };
  const chartNavigation = options.chartNavigation || createViewport();
  const state = {
    paperTrading: {
      selectedSymbol: options.symbol || "BTC-USD",
      timeframe: options.timeframe || "15m",
      marketData: terminalPayload(options.candles || candles, {
        symbol: options.symbol,
        timeframe: options.timeframe
      }).marketData,
      marketError: null,
      marketLoading: false,
      marketRefreshing: false,
      marketLoadRequestId: 0,
      markets: [],
      orders: [],
      account: null,
      signalReview: options.signalReview || null,
      signalReviewChart: options.signalReviewChart || null,
      panels: { marketsCollapsed: false, orderCollapsed: false },
      chartNavigation
    }
  };
  const requests = [];
  const renders = [];
  let resetCount = 0;
  const routeParams = new URLSearchParams();
  if (options.signalId) routeParams.set("signalId", options.signalId);
  const dependencies = {
    PAPER_MARKET_LOAD_TIMEOUT_MS: 30_000,
    mergePaperChartCandles,
    state,
    paperChartLoading,
    setText: () => {},
    parseAppHash: () => ({ route: "paper-trading", params: routeParams }),
    location: { hash: "#paper-trading" },
    api: {
      request: async (path, requestOptions = {}) => {
        requests.push({ path, options: requestOptions });
        return request(path, requests.length, requestOptions);
      }
    },
    getSignalReviewFrame: () => ({ visibleCount: 120, endIndex: null }),
    resetPaperChartViewport: () => {
      resetCount += 1;
      const chart = state.paperTrading.chartNavigation;
      chart.visibleCount = 120;
      chart.endIndex = null;
      chart.autoPriceScale = true;
      chart.manualPriceRange = null;
      chart.loadingOlder = false;
      chart.noMoreOlder = false;
      chart.oldestLoadedTime = null;
      chart.historyRequestKey = null;
      chart.pendingDrawing = null;
    },
    removeHashParams: () => {},
    renderPaperTradingTerminal: () => renders.push({
      candles: state.paperTrading.marketData?.candles?.length || 0,
      refreshing: state.paperTrading.marketRefreshing
    }),
    renderSignals: () => {},
    renderSignalsHistory: () => {},
    console: { warn: () => {} }
  };
  const dependencyNames = Object.keys(dependencies);
  const load = new Function(...dependencyNames, `"use strict"; ${loaderSource}; return loadPaperTradingTerminal;`)(
    ...dependencyNames.map((name) => dependencies[name])
  );
  return {
    state,
    load,
    requests,
    renders,
    paperChartLoading,
    get resetCount() { return resetCount; }
  };
}

function snapshotViewport(harness) {
  return structuredClone(harness.state.paperTrading.chartNavigation);
}

{
  const response = deferred();
  const updated = candles.map((candle) => ({ ...candle }));
  updated.at(-1).high += 80;
  updated.at(-1).close += 55;
  updated.at(-1).volume += 500;
  const harness = makeHarness(async () => response.promise);
  const before = snapshotViewport(harness);
  const beforeWindow = getPaperTimelineWindow(candles.length, before.visibleCount, before.endIndex, { rightOffsetRatio: 0.2, maxFutureRatio: 0.8 });
  const refresh = harness.load({ background: true });
  assert.equal(harness.state.paperTrading.marketLoading, false);
  assert.equal(harness.state.paperTrading.marketRefreshing, true);
  assert.equal(harness.paperChartLoading.classList.contains("hidden"), true, "background refresh must not show the blocking overlay");
  response.resolve(terminalPayload(updated));
  assert.deepEqual(await refresh, { ok: true, candles: 120, background: true });
  assert.equal(harness.state.paperTrading.marketData.candles.at(-1).close, updated.at(-1).close, "same-timestamp candle must accept refreshed OHLCV");
  assert.deepEqual(snapshotViewport(harness), before, "current-candle update must preserve viewport and drawings exactly");
  const afterWindow = getPaperTimelineWindow(120, before.visibleCount, before.endIndex, { rightOffsetRatio: 0.2, maxFutureRatio: 0.8 });
  assert.deepEqual(afterWindow, beforeWindow, "same-timestamp refresh must cause zero horizontal movement");
}

{
  const appended = [...candles, {
    ...candles.at(-1),
    time: candles.at(-1).time + 900,
    open: candles.at(-1).close,
    high: candles.at(-1).close + 28,
    low: candles.at(-1).close - 16,
    close: candles.at(-1).close + 12
  }];
  const harness = makeHarness(async () => terminalPayload(appended));
  const before = snapshotViewport(harness);
  const beforeWindow = getPaperTimelineWindow(120, before.visibleCount, before.endIndex, { rightOffsetRatio: 0.2, maxFutureRatio: 0.8 });
  await harness.load({ background: true });
  const afterWindow = getPaperTimelineWindow(121, before.visibleCount, before.endIndex, { rightOffsetRatio: 0.2, maxFutureRatio: 0.8 });
  assert.deepEqual(snapshotViewport(harness), before, "historical viewport must remain anchored when a new live candle is appended");
  assert.equal(afterWindow.start, beforeWindow.start);
  assert.equal(afterWindow.end, beforeWindow.end);
  assert.ok(afterWindow.candleEnd < 121, "new candle may remain offscreen while user is away from Latest");
}

{
  const chartNavigation = createViewport();
  chartNavigation.visibleCount = 60;
  chartNavigation.endIndex = null;
  const appended = [...candles, { ...candles.at(-1), time: candles.at(-1).time + 900, close: candles.at(-1).close + 10 }];
  const harness = makeHarness(async () => terminalPayload(appended), { chartNavigation });
  const before = snapshotViewport(harness);
  await harness.load({ background: true });
  assert.deepEqual(snapshotViewport(harness), before, "Latest refresh must preserve spacing, manual price range, and drawings");
  const timeline = getPaperTimelineWindow(121, chartNavigation.visibleCount, chartNavigation.endIndex, { rightOffsetRatio: 0.2, maxFutureRatio: 0.8 });
  const newestSlotRatio = ((120 - timeline.start) + 0.5) / timeline.count;
  assert.ok(newestSlotRatio > 0.78 && newestSlotRatio < 0.82, "Latest anchor must keep newest candle around 80 percent");
  assert.equal(timeline.futureSlots, 12, "Latest must retain 20 percent future space at the current zoom");
}

{
  const harness = makeHarness(async () => { throw new Error("Temporary provider error"); });
  const beforeCandles = structuredClone(harness.state.paperTrading.marketData.candles);
  const beforeViewport = snapshotViewport(harness);
  assert.deepEqual(await harness.load({ background: true }), { ok: false, error: "Temporary provider error" });
  assert.deepEqual(harness.state.paperTrading.marketData.candles, beforeCandles, "refresh error must preserve existing candles");
  assert.deepEqual(snapshotViewport(harness), beforeViewport, "refresh error must preserve viewport");
  assert.equal(harness.paperChartLoading.classList.contains("hidden"), true);
}

{
  const oldResponse = deferred();
  const newer = candles.map((candle) => ({ ...candle }));
  newer.at(-1).close += 25;
  const older = candles.map((candle) => ({ ...candle }));
  older.at(-1).close -= 40;
  const harness = makeHarness(async (_path, call) => call === 1 ? oldResponse.promise : terminalPayload(newer));
  const first = harness.load({ background: true });
  await harness.load({ background: true });
  oldResponse.resolve(terminalPayload(older));
  assert.deepEqual(await first, { stale: true });
  assert.equal(harness.state.paperTrading.marketData.candles.at(-1).close, newer.at(-1).close, "stale refresh must not overwrite newer candle data");
}

{
  const harness = makeHarness(async () => terminalPayload(candles, { symbol: "ETH-USD" }));
  harness.state.paperTrading.selectedSymbol = "ETH-USD";
  await harness.load();
  assert.equal(harness.resetCount, 1, "explicit market load may initialize a viewport");
  assert.equal(harness.state.paperTrading.chartNavigation.visibleCount, 120);
  assert.equal(harness.state.paperTrading.chartNavigation.endIndex, null);
  assert.equal(harness.state.paperTrading.chartNavigation.autoPriceScale, true);
}

{
  const harness = makeHarness(async () => terminalPayload(candles, { timeframe: "1h" }));
  harness.state.paperTrading.timeframe = "1h";
  await harness.load();
  assert.equal(harness.resetCount, 1, "explicit timeframe load may initialize a viewport");
}

{
  const older = Array.from({ length: 20 }, (_, index) => ({
    ...candles[0],
    time: candles[0].time - (20 - index) * 900,
    close: candles[0].close - 20 + index
  }));
  const merged = mergePaperChartCandles(candles, older, 96);
  assert.equal(merged.prepended, 20);
  assert.equal(merged.endIndex, 116, "historical prepend must retain the same logical candles in view");
  assert.equal(merged.candles.length, 140);
}

{
  const response = deferred();
  const harness = makeHarness(async () => response.promise);
  const beforeViewport = snapshotViewport(harness);
  const refresh = harness.load({ background: true });
  harness.state.paperTrading.panels.marketsCollapsed = true;
  harness.state.paperTrading.panels.orderCollapsed = true;
  response.resolve(terminalPayload(candles));
  await refresh;
  assert.deepEqual(snapshotViewport(harness), beforeViewport, "panel/layout changes during refresh must preserve viewport");
  assert.deepEqual(harness.state.paperTrading.panels, { marketsCollapsed: true, orderCollapsed: true });
}

{
  const review = {
    id: "signal-1",
    symbol: "BTC-USD",
    timeframe: "15m",
    direction: "long",
    entry: 64_300,
    stopLoss: 63_900,
    takeProfit: 65_100,
    status: "Active"
  };
  const reviewCandles = [...candles, { ...candles.at(-1), time: candles.at(-1).time + 900, close: candles.at(-1).close + 8 }];
  const harness = makeHarness(async (path) => {
    if (path.includes("signal-review")) {
      return { review, chart: { available: true, candles: reviewCandles, currentPrice: reviewCandles.at(-1).close, source: "coinbase" } };
    }
    return terminalPayload([], { marketData: null });
  }, { signalId: review.id, signalReview: review });
  const before = snapshotViewport(harness);
  await harness.load({ background: true });
  assert.deepEqual(snapshotViewport(harness), before, "active Signal Review refresh must preserve viewport");
  assert.deepEqual(
    [harness.state.paperTrading.signalReview.entry, harness.state.paperTrading.signalReview.stopLoss, harness.state.paperTrading.signalReview.takeProfit],
    [review.entry, review.stopLoss, review.takeProfit],
    "canonical Signal Review levels must remain unchanged"
  );
}

assert.match(appSource, /state\.activeView === "paper-portfolio"[\s\S]*loadPaperTradingTerminal\(\{ background: true \}\)/, "periodic timer must use silent background mode");
assert.match(loaderSource, /backgroundRefresh[\s\S]*preferIncoming: true/, "live refresh must merge incoming OHLCV by timestamp");
assert.match(loaderSource, /chartNavigation,[\s\S]*marketLoadRequestId/, "loader must explicitly retain the chart-navigation object");
assert.match(loaderSource, /renderPaperTradingTerminal\(\{ preserveChartInteraction: backgroundRefresh \}\)/, "background refresh must preserve active chart gestures");
assert.match(appSource, /chartInteractionActive[\s\S]*preserveChartInteraction[\s\S]*renderPaperTradingChart/, "active mobile pinch or drag must defer only the refresh redraw");
assert.doesNotMatch(loaderSource.slice(0, loaderSource.indexOf("if (!backgroundRefresh && reviewPayload")), /paperChartPinch\s*=/, "refresh must not reset mobile pinch state");
assert.match(appSource, /ResizeObserver\(\(\) => schedulePaperChartRender\(\)\)/, "resize must schedule render without resetting viewport");

console.log(JSON.stringify({
  passed: true,
  productionLoaderExecuted: true,
  refresh: {
    currentCandleUpdatedWithoutShift: true,
    appendedAwayFromLatestAnchored: true,
    appendedAtLatestFollowed: true,
    blockingOverlaySuppressed: true,
    staleResponseIgnored: true,
    errorPreservedExistingChart: true
  },
  preserved: {
    manualPriceRange: true,
    candleSpacing: true,
    historicalPrepend: true,
    drawingsAndForecast: true,
    signalReviewLevels: true,
    panelAndResizeState: true
  }
}, null, 2));
