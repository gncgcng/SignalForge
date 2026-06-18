process.env.COMMODITIES_LIVE_ENABLED = "false";

const { listPairs, getOhlcv } = await import("../src/modules/market-data/marketDataService.js");
const { commoditiesMarketDataProvider } = await import("../src/modules/market-data/commoditiesMarketDataProvider.js");

const pairs = listPairs();
const crypto = pairs.filter((pair) => pair.category === "Crypto");
const commodities = pairs.filter((pair) => pair.category === "Commodities");
const stocks = pairs.filter((pair) => pair.category === "Stocks & ETFs");
let comingSoonError = null;
let unsupportedTimeframe = false;

try {
  await getOhlcv("XAU/USD", "15m");
} catch (error) {
  comingSoonError = {
    code: error.code,
    statusCode: error.statusCode,
    message: error.message
  };
}

unsupportedTimeframe = !commoditiesMarketDataProvider.supports("XAU/USD", "1d");

const result = {
  cryptoActive: crypto.every((pair) => pair.status === "active"),
  commoditySymbols: commodities.map((pair) => pair.symbol),
  commoditiesComingSoon: commodities.every((pair) => pair.status === "coming-soon"),
  stocksComingSoon: stocks.every((pair) => pair.status === "coming-soon"),
  comingSoonError,
  unsupportedTimeframe
};

console.log(JSON.stringify(result, null, 2));

if (
  !result.cryptoActive ||
  JSON.stringify(result.commoditySymbols) !== JSON.stringify(["XAU/USD", "XAG/USD", "WTI", "BRENT"]) ||
  !result.commoditiesComingSoon ||
  !result.stocksComingSoon ||
  result.comingSoonError?.code !== "MARKET_COMING_SOON" ||
  result.comingSoonError?.statusCode !== 503 ||
  !result.unsupportedTimeframe
) {
  process.exitCode = 1;
}
