delete process.env.TWELVEDATA_API_KEY;

const {
  getOhlcv,
  listPairs,
  providerIssueStatus,
  resolveMarketStatus
} = await import("../src/modules/market-data/marketDataService.js");
const { twelveDataMarketDataProvider } = await import("../src/modules/market-data/twelveDataMarketDataProvider.js");

const pairs = listPairs();
const crypto = pairs.filter((pair) => pair.category === "Crypto");
const commodities = pairs.filter((pair) => pair.category === "Commodities");
const stocks = pairs.filter((pair) => pair.category === "Stocks & ETFs");
const requiredCommoditySymbols = ["XAU/USD", "XAG/USD", "WTI", "BRENT"];
const optionalCommoditySymbols = ["NATGAS"];
const timeframes = ["5m", "15m", "1h", "4h"];
const comingSoonChecks = [];
const supportChecks = [];
const now = new Date("2026-07-01T16:00:00Z");
const freshCryptoStatus = resolveMarketStatus(
  { category: "Crypto", symbol: "BTC-USD" },
  "15m",
  [{ time: Math.floor((now.getTime() - 5 * 60 * 1000) / 1000) }],
  now.toISOString(),
  now
);
const closedCommodityStatus = resolveMarketStatus(
  { category: "Commodities", symbol: "XAU/USD" },
  "1h",
  [{ time: Math.floor(new Date("2026-07-04T21:00:00Z").getTime() / 1000) }],
  "2026-07-04T22:00:00Z",
  new Date("2026-07-04T22:00:00Z")
);
const staleCommodityStatus = resolveMarketStatus(
  { category: "Commodities", symbol: "XAU/USD" },
  "5m",
  [{ time: Math.floor((now.getTime() - 30 * 60 * 1000) / 1000) }],
  now.toISOString(),
  now
);
const providerIssue = providerIssueStatus("Twelve Data rate limit reached.");

for (const symbol of [...requiredCommoditySymbols, ...optionalCommoditySymbols]) {
  for (const timeframe of timeframes) {
    supportChecks.push({
      symbol,
      timeframe,
      supported: twelveDataMarketDataProvider.supports(symbol, timeframe)
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
  cryptoActive: ["BTC-USD", "ETH-USD", "SOL-USD"].every((symbol) =>
    crypto.some((pair) => pair.symbol === symbol && pair.status === "active")
  ) && crypto.filter((pair) => pair.marketStatus === "pending").every((pair) => pair.selectable === false),
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
  unsupportedSymbol: !twelveDataMarketDataProvider.supports("COPPER", "15m"),
  unsupportedTimeframe: !twelveDataMarketDataProvider.supports("XAU/USD", "1d"),
  cryptoLiveStatus: freshCryptoStatus.label === "Live" && freshCryptoStatus.code === "LIVE",
  commodityClosedStatus: closedCommodityStatus.label === "Closed" && closedCommodityStatus.code === "CLOSED",
  staleDataStatus: staleCommodityStatus.label === "Delayed" && staleCommodityStatus.code === "DELAYED",
  providerIssueStatus: providerIssue.label === "Provider issue" &&
    providerIssue.code === "PROVIDER_ISSUE" &&
    providerIssue.detail.includes("rate limit"),
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
  !result.cryptoLiveStatus ||
  !result.commodityClosedStatus ||
  !result.staleDataStatus ||
  !result.providerIssueStatus ||
  result.combinationsTested !== 20
) {
  process.exitCode = 1;
}
