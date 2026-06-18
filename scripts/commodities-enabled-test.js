process.env.TWELVEDATA_API_KEY = "test-key";

const commoditySymbols = ["XAU/USD", "XAG/USD", "WTI", "BRENT", "NATGAS"];
const timeframes = ["5m", "15m", "1h", "4h"];
const requests = [];

globalThis.fetch = async (url) => {
  const requestUrl = new URL(url);
  requests.push({
    symbol: requestUrl.searchParams.get("symbol"),
    interval: requestUrl.searchParams.get("interval")
  });

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

const { handleMarketDataRoutes } = await import("../src/modules/market-data/marketDataController.js");
const { listActivePairs, listPairs } = await import("../src/modules/market-data/marketDataService.js");

const routeChecks = [];

for (const symbol of commoditySymbols) {
  for (const timeframe of timeframes) {
    const response = createResponse();
    const url = new URL(
      `http://localhost/api/market-data/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}`
    );

    await handleMarketDataRoutes(
      { user: { id: "usr_test" }, method: "GET" },
      response,
      "/api/market-data/candles",
      url
    );

    const body = JSON.parse(response.body);
    routeChecks.push({
      symbol,
      timeframe,
      statusCode: response.statusCode,
      returnedSymbol: body.marketData?.pair?.symbol,
      candleCount: body.marketData?.candles?.length,
      source: body.marketData?.source
    });
  }
}

const catalog = listPairs();
const activeSymbols = listActivePairs().map((pair) => pair.symbol);
const result = {
  commoditiesSelectable: commoditySymbols.every((symbol) => {
    const pair = catalog.find((item) => item.symbol === symbol);
    return pair?.status === "active" &&
      pair.selectable === true &&
      pair.availabilityMessage === "Live";
  }),
  routesSupported: routeChecks.every((check) => {
    return check.statusCode === 200 &&
      check.returnedSymbol === check.symbol &&
      check.candleCount === 120 &&
      check.source === "twelve-data";
  }),
  scanAllEligible: commoditySymbols.every((symbol) => activeSymbols.includes(symbol)),
  combinationsTested: routeChecks.length,
  providerRequests: requests.length
};

console.log(JSON.stringify(result, null, 2));

if (
  !result.commoditiesSelectable ||
  !result.routesSupported ||
  !result.scanAllEligible ||
  result.combinationsTested !== 20 ||
  result.providerRequests !== 20
) {
  process.exitCode = 1;
}

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body || "";
    }
  };
}
