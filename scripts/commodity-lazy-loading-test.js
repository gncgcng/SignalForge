process.env.TWELVEDATA_API_KEY = "test-key";
process.env.TWELVEDATA_CACHE_TTL_MS = "300000";

let providerRequests = 0;

globalThis.fetch = async () => {
  providerRequests += 1;

  const values = Array.from({ length: 120 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1, 0, index * 5));
    const price = 100 + index * 0.1;

    return {
      datetime: date.toISOString().replace("T", " ").slice(0, 19),
      open: String(price),
      high: String(price + 0.5),
      low: String(price - 0.5),
      close: String(price + 0.2),
      volume: String(1000 + index)
    };
  });

  return new Response(JSON.stringify({ status: "ok", values }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

const { getCachedOhlcv, listPairs } = await import("../src/modules/market-data/marketDataService.js");
const { twelveDataMarketDataProvider } = await import("../src/modules/market-data/twelveDataMarketDataProvider.js");
const { shouldFetchSignalOutcomeMarketData } = await import("../src/modules/signals/signalOutcomeService.js");

const catalog = listPairs();
const requestsAfterCatalogLoad = providerRequests;
const defaultMarket = catalog.find((pair) => pair.symbol === "BTC-USD");
const cacheBeforeExplicitLoad = getCachedOhlcv("XAU/USD", "15m");

const [first, second] = await Promise.all([
  twelveDataMarketDataProvider.getCandles("XAU/USD", "15m"),
  twelveDataMarketDataProvider.getCandles("XAU/USD", "15m")
]);
const requestsAfterConcurrentLoad = providerRequests;

const cached = await twelveDataMarketDataProvider.getCandles("XAU/USD", "15m");
const result = {
  catalogLoadUsesNoCommodityCredits: requestsAfterCatalogLoad === 0,
  btcRemainsAvailableAsDefault: defaultMarket?.status === "active",
  passiveCommodityOutcomeTrackingDisabled: !shouldFetchSignalOutcomeMarketData({ symbol: "XAU/USD" }),
  passiveCryptoOutcomeTrackingEnabled: shouldFetchSignalOutcomeMarketData({ symbol: "BTC-USD" }),
  commodityCacheEmptyBeforeExplicitLoad: cacheBeforeExplicitLoad === null,
  duplicateRequestsCoalesced: requestsAfterConcurrentLoad === 1,
  concurrentResponsesReturned: first.candles.length === 120 && second.candles.length === 120,
  subsequentRequestCached: providerRequests === 1 && cached.cache === "hit",
  passiveTrackingCanReuseExplicitCache: getCachedOhlcv("XAU/USD", "15m")?.candles.length === 120
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}
