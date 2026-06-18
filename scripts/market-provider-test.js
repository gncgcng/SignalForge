process.env.COMMODITIES_LIVE_ENABLED = "false";

const { listPairs, getOhlcv } = await import("../src/modules/market-data/marketDataService.js");
const { commoditiesMarketDataProvider } = await import("../src/modules/market-data/commoditiesMarketDataProvider.js");

const pairs = listPairs();
const crypto = pairs.filter((pair) => pair.category === "Crypto");
const commodities = pairs.filter((pair) => pair.category === "Commodities");
const stocks = pairs.filter((pair) => pair.category === "Stocks & ETFs");
const requiredCommoditySymbols = ["XAU/USD", "XAG/USD", "WTI", "BRENT"];
const optionalCommoditySymbols = ["NATGAS"];
const timeframes = ["5m", "15m", "1h", "4h"];
const comingSoonChecks = [];
const supportChecks = [];

for (const symbol of [...requiredCommoditySymbols, ...optionalCommoditySymbols]) {
  for (const timeframe of timeframes) {
    supportChecks.push({
      symbol,
      timeframe,
      supported: commoditiesMarketDataProvider.supports(symbol, timeframe)
    });

    try {
      await getOhlcv(symbol, timeframe);
      comingSoonChecks.push({ symbol, timeframe, rejected: false });
    } catch (error) {
      comingSoonChecks.push({
        symbol,
        timeframe,
        rejected: true,
        code: error.code,
        statusCode: error.statusCode
      });
    }
  }
}

const result = {
  cryptoActive: crypto.every((pair) => pair.status === "active"),
  commoditySymbols: commodities.map((pair) => pair.symbol),
  commoditiesComingSoon: commodities.every((pair) => pair.status === "coming-soon"),
  stocksComingSoon: stocks.every((pair) => pair.status === "coming-soon"),
  requiredCommodityCoverage: requiredCommoditySymbols.every((symbol) => commodities.some((pair) => pair.symbol === symbol)),
  naturalGasOptionalCoverage: optionalCommoditySymbols.every((symbol) => commodities.some((pair) => pair.symbol === symbol && pair.optional)),
  allTimeframesSupported: supportChecks.every((check) => check.supported),
  allUnavailableMarketsRejectCleanly: comingSoonChecks.every((check) => {
    return check.rejected && check.code === "PROVIDER_NOT_CONFIGURED" && check.statusCode === 503;
  }),
  clearProviderMessage: commodities.every((pair) => {
    return pair.selectable === false &&
      pair.availabilityCode === "PROVIDER_NOT_CONFIGURED" &&
      pair.availabilityMessage === "Data provider not configured";
  }),
  unsupportedSymbol: !commoditiesMarketDataProvider.supports("COPPER", "15m"),
  unsupportedTimeframe: !commoditiesMarketDataProvider.supports("XAU/USD", "1d"),
  combinationsTested: supportChecks.length
};

console.log(JSON.stringify(result, null, 2));

if (
  !result.cryptoActive ||
  !result.requiredCommodityCoverage ||
  !result.naturalGasOptionalCoverage ||
  !result.commoditiesComingSoon ||
  !result.stocksComingSoon ||
  !result.allTimeframesSupported ||
  !result.allUnavailableMarketsRejectCleanly ||
  !result.clearProviderMessage ||
  !result.unsupportedSymbol ||
  !result.unsupportedTimeframe ||
  result.combinationsTested !== 20
) {
  process.exitCode = 1;
}
