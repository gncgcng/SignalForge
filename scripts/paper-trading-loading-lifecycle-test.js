import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  calculatePaperCandleGeometry,
  calculatePaperPriceRange,
  getPaperChartDimensions,
  getPaperTimelineWindow
} from "../public/paperChartUtils.js";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const loaderStart = appSource.indexOf("async function loadPaperTradingTerminal()");
const loaderEnd = appSource.indexOf("function openSignalReview", loaderStart);
assert.ok(loaderStart >= 0 && loaderEnd > loaderStart, "production Paper Trading loader must be extractable");
const loaderSource = appSource.slice(loaderStart, loaderEnd);

const candles = Array.from({ length: 120 }, (_, index) => {
  const open = 64_000 + index * 4 + Math.sin(index / 4) * 35;
  const close = open + (index % 2 ? -18 : 22);
  return {
    time: 1_700_000_000 + index * 900,
    open,
    high: Math.max(open, close) + 24,
    low: Math.min(open, close) - 21,
    close,
    volume: 1_000 + index * 8
  };
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function terminalPayload(nextCandles = candles, marketError = null, timeframe = "15m") {
  return {
    account: { balance: 10_000 },
    orders: [],
    markets: [{ symbol: "BTC-USD", displaySymbol: "BTCUSD" }],
    marketData: nextCandles == null ? null : {
      pair: { symbol: "BTC-USD", lastPrice: nextCandles.at(-1)?.close || null },
      candles: nextCandles,
      lastCandleAt: nextCandles.at(-1)?.time || null,
      marketStatus: { label: "Live" },
      timeframe
    },
    marketError
  };
}

function makeHarness(request) {
  const classNames = new Set(["hidden"]);
  const paperChartLoading = {
    textContent: "Loading live candles...",
    classList: {
      add: (name) => classNames.add(name),
      remove: (name) => classNames.delete(name),
      contains: (name) => classNames.has(name)
    }
  };
  const status = new Map();
  const requests = [];
  const renders = [];
  const state = {
    paperTrading: {
      selectedSymbol: "BTC-USD",
      timeframe: "15m",
      marketData: null,
      marketError: null,
      marketLoading: false,
      marketLoadRequestId: 0,
      markets: [],
      orders: [],
      account: null,
      chartNavigation: {
        visibleCount: 120,
        endIndex: null,
        autoPriceScale: true,
        manualPriceRange: null,
        loadingOlder: false,
        noMoreOlder: false,
        oldestLoadedTime: null,
        historyRequestKey: null
      }
    }
  };
  const layout = { width: 0, height: 0, hidden: false };

  function renderChartLifecycle() {
    if (state.paperTrading.marketLoading) {
      renders.push({ state: "loading" });
      return;
    }
    const loadedCandles = state.paperTrading.marketData?.candles || [];
    if (!loadedCandles.length) {
      renders.push({ state: state.paperTrading.marketError ? "error" : "empty" });
      return;
    }
    const dimensions = getPaperChartDimensions(layout.width, layout.height, { volume: true, priceLabels: ["65000.00"] });
    if (layout.hidden || !dimensions) {
      renders.push({ state: "deferred", candles: loadedCandles.length });
      return;
    }
    const timeline = getPaperTimelineWindow(loadedCandles.length, 120, null, {
      rightOffsetRatio: 0.2,
      maxFutureRatio: 0.8
    });
    const priceRange = calculatePaperPriceRange(loadedCandles.slice(timeline.candleStart, timeline.candleEnd));
    const geometry = calculatePaperCandleGeometry(loadedCandles, timeline, priceRange, dimensions);
    assert.equal(geometry.valid, true, "resumed render must use valid production chart geometry");
    renders.push({
      state: "rendered",
      candles: loadedCandles.length,
      realCandles: geometry.items.length,
      futureSlots: timeline.futureSlots
    });
  }

  const dependencies = {
    PAPER_MARKET_LOAD_TIMEOUT_MS: 30_000,
    state,
    paperChartLoading,
    setText: (selector, value) => status.set(selector, value),
    parseAppHash: () => ({ route: "paper-trading", params: new URLSearchParams() }),
    location: { hash: "#paper-trading" },
    api: {
      request: async (path, options = {}) => {
        requests.push({ path, options });
        return request(path, requests.length, options);
      }
    },
    getSignalReviewFrame: () => ({ visibleCount: 120, endIndex: null }),
    resetPaperChartViewport: () => {
      state.paperTrading.chartNavigation.visibleCount = 120;
      state.paperTrading.chartNavigation.endIndex = null;
    },
    removeHashParams: () => {},
    renderPaperTradingTerminal: renderChartLifecycle,
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
    layout,
    load,
    requests,
    renders,
    status,
    paperChartLoading,
    reveal(width = 900, height = 500) {
      layout.hidden = false;
      layout.width = width;
      layout.height = height;
      renderChartLifecycle();
    },
    resize(width, height) {
      layout.width = width;
      layout.height = height;
      renderChartLifecycle();
    }
  };
}

{
  const harness = makeHarness(async () => terminalPayload());
  const result = await harness.load();
  assert.deepEqual(result, { ok: true, candles: 120 });
  assert.equal(harness.state.paperTrading.marketData.candles.length, 120);
  assert.equal(harness.state.paperTrading.marketLoading, false);
  assert.equal(harness.paperChartLoading.classList.contains("hidden"), true);
  assert.equal(harness.renders.at(-1).state, "deferred", "zero-size layout must defer rendering only");
  assert.equal(harness.requests.length, 1);
  assert.match(harness.requests[0].path, /\/api\/paper-trades\/terminal\?symbol=BTC-USD&timeframe=15m/);
  assert.equal(harness.requests[0].options.timeoutMs, 30_000, "market request must terminate through the existing timeout path");
  harness.reveal();
  assert.deepEqual(harness.renders.at(-1), { state: "rendered", candles: 120, realCandles: 96, futureSlots: 24 });
  assert.equal(harness.requests.length, 1, "reveal must render stored candles without refetching");
}

{
  const harness = makeHarness(async () => terminalPayload());
  harness.layout.width = 900;
  harness.layout.height = 500;
  await harness.load();
  assert.equal(harness.renders.at(-1).state, "rendered", "valid dimensions before response must render normally");
}

{
  const harness = makeHarness(async () => terminalPayload());
  harness.layout.hidden = true;
  harness.layout.width = 900;
  harness.layout.height = 500;
  await harness.load();
  assert.equal(harness.state.paperTrading.marketLoading, false);
  assert.equal(harness.renders.at(-1).state, "deferred", "hidden tab must not prevent data-state completion");
  harness.reveal();
  assert.equal(harness.renders.at(-1).state, "rendered");
  assert.equal(harness.requests.length, 1);
}

{
  const harness = makeHarness(async () => { throw new Error("Provider temporarily unavailable"); });
  const result = await harness.load();
  assert.deepEqual(result, { ok: false, error: "Provider temporarily unavailable" });
  assert.equal(harness.state.paperTrading.marketLoading, false);
  assert.equal(harness.paperChartLoading.classList.contains("hidden"), true);
  assert.equal(harness.state.paperTrading.marketError, "Provider temporarily unavailable");
  assert.equal(harness.renders.at(-1).state, "error");
}

{
  const harness = makeHarness(async () => terminalPayload([], null));
  const result = await harness.load();
  assert.deepEqual(result, { ok: true, candles: 0 });
  assert.equal(harness.state.paperTrading.marketLoading, false);
  assert.equal(harness.renders.at(-1).state, "empty");
}

{
  const harness = makeHarness(async () => terminalPayload(null, "No candles returned by provider"));
  const result = await harness.load();
  assert.deepEqual(result, { ok: true, candles: 0 });
  assert.equal(harness.state.paperTrading.marketLoading, false);
  assert.equal(harness.state.paperTrading.marketError, "No candles returned by provider");
  assert.equal(harness.renders.at(-1).state, "error", "a handled provider error response must leave a visible terminal state");
}

{
  const first = deferred();
  const harness = makeHarness(async (path) => path.includes("timeframe=15m") ? first.promise : terminalPayload(candles, null, "1h"));
  const oldLoad = harness.load();
  harness.state.paperTrading.timeframe = "1h";
  const newResult = await harness.load();
  assert.equal(newResult.ok, true);
  assert.match(harness.requests[1].path, /timeframe=1h/);
  first.resolve(terminalPayload(candles.slice(0, 60), null, "15m"));
  assert.deepEqual(await oldLoad, { stale: true });
  assert.equal(harness.state.paperTrading.timeframe, "1h");
  assert.equal(harness.state.paperTrading.marketData.candles.length, 120);
  assert.equal(harness.state.paperTrading.marketLoading, false, "authoritative request must clear loading");
}

{
  const response = deferred();
  const harness = makeHarness(async () => response.promise);
  const load = harness.load();
  harness.resize(720, 420);
  harness.resize(980, 520);
  assert.equal(harness.state.paperTrading.marketLoadRequestId, 1, "layout changes must not invalidate market request identity");
  response.resolve(terminalPayload());
  await load;
  assert.equal(harness.state.paperTrading.marketData.candles.length, 120);
  assert.equal(harness.renders.at(-1).state, "rendered");
  harness.resize(740, 440);
  harness.reveal(900, 500);
  harness.reveal(900, 500);
  assert.equal(harness.requests.length, 1, "resize and reveal callbacks must never create fetch loops");
}

assert.match(loaderSource, /try\s*\{[\s\S]*finally\s*\{/i, "production loader must finalize every current request");
assert.match(loaderSource, /requestId !== state\.paperTrading\.marketLoadRequestId/, "production loader must ignore stale responses");
const deferralSource = appSource.slice(
  appSource.indexOf("function deferPaperChartRenderUntilMeasured()"),
  appSource.indexOf("function bindPaperChartInteractions", appSource.indexOf("function deferPaperChartRenderUntilMeasured()"))
);
assert.doesNotMatch(deferralSource, /paperChartLoading\.classList\.remove/, "dimension deferral must not reactivate market loading");
assert.match(appSource, /ResizeObserver[\s\S]*schedulePaperChartRender/, "measured resize must schedule redraw");
assert.match(appSource, /visibilitychange[\s\S]*schedulePaperChartRender/, "tab reveal must schedule redraw");

console.log(JSON.stringify({
  passed: true,
  productionLoaderExecuted: true,
  scenarios: {
    zeroDimensionsThenReveal: true,
    dimensionsReadyBeforeResponse: true,
    hiddenThenReveal: true,
    requestError: true,
    emptyResponse: true,
    handledProviderErrorResponse: true,
    staleTimeframeResponse: true,
    resizeDuringRequest: true,
    noDuplicateFetchOnReveal: true
  },
  rendering: { inputCandles: 120, visibleRealCandles: 96, futureSlots: 24 }
}, null, 2));
