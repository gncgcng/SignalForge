import { getMarketDataProvider, getPairProviderAvailability } from "./marketDataProviderRegistry.js";
import { MarketDataProviderError } from "./marketDataProviderError.js";

const marketCatalog = [
  { symbol: "BTC-USD", name: "Bitcoin", category: "Crypto", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "ETH-USD", name: "Ethereum", category: "Crypto", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "SOL-USD", name: "Solana", category: "Crypto", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "XAU/USD", name: "Gold", category: "Commodities", assetClass: "Commodity", venue: "OTC", provider: "twelve-data" },
  { symbol: "XAG/USD", name: "Silver", category: "Commodities", assetClass: "Commodity", venue: "OTC", provider: "twelve-data" },
  { symbol: "WTI", name: "WTI Crude Oil", category: "Commodities", assetClass: "Commodity", venue: "OTC", provider: "twelve-data" },
  { symbol: "BRENT", name: "Brent Crude Oil", category: "Commodities", assetClass: "Commodity", venue: "OTC", provider: "twelve-data" },
  { symbol: "NATGAS", name: "Natural Gas", category: "Commodities", assetClass: "Commodity", venue: "OTC", provider: "twelve-data", optional: true },
  { symbol: "NVDA", name: "NVIDIA Corp", category: "Stocks & ETFs", assetClass: "Stock", venue: "NASDAQ", provider: null },
  { symbol: "TSLA", name: "Tesla Inc", category: "Stocks & ETFs", assetClass: "Stock", venue: "NASDAQ", provider: null },
  { symbol: "AAPL", name: "Apple Inc", category: "Stocks & ETFs", assetClass: "Stock", venue: "NASDAQ", provider: null },
  { symbol: "SPY", name: "S&P 500 ETF", category: "Stocks & ETFs", assetClass: "ETF", venue: "NYSE Arca", provider: null }
];

export function listPairs(query = "") {
  const normalized = query.trim().toLowerCase();
  const pairs = marketCatalog.map(withAvailability);

  if (!normalized) {
    return pairs;
  }

  return pairs.filter((pair) => {
    return [pair.symbol, pair.name, pair.category, pair.assetClass, pair.venue]
      .join(" ")
      .toLowerCase()
      .includes(normalized);
  });
}

export function getPair(symbol) {
  const pair = marketCatalog.find((item) => item.symbol === symbol);
  return pair ? withAvailability(pair) : null;
}

export function listActivePairs() {
  return marketCatalog.map(withAvailability).filter((pair) => pair.status === "active");
}

export async function getMarketSnapshot(symbol, timeframe = "15m") {
  const marketData = await getOhlcv(symbol, timeframe);

  return {
    ...marketData.pair,
    source: marketData.source,
    receivedAt: marketData.receivedAt
  };
}

export async function getOhlcv(symbol, timeframe) {
  const pair = getPair(symbol);

  if (!pair) {
    throw new MarketDataProviderError(`Unknown market symbol ${symbol}.`, {
      statusCode: 404,
      code: "MARKET_NOT_FOUND"
    });
  }

  if (pair.status !== "active") {
    throw new MarketDataProviderError(
      pair.category === "Commodities" && pair.availabilityCode === "PROVIDER_NOT_CONFIGURED"
        ? `${pair.symbol}: Data provider not configured.`
        : `${pair.symbol} market data is Coming Soon.`,
      {
        statusCode: 503,
        code: pair.availabilityCode || "MARKET_COMING_SOON"
      }
    );
  }

  const provider = getMarketDataProvider(pair);

  if (!provider.supports(pair.symbol, timeframe)) {
    throw new MarketDataProviderError(
      `${provider.id} does not support ${pair.symbol} on ${timeframe}.`,
      { statusCode: 400, code: "PROVIDER_UNSUPPORTED_MARKET" }
    );
  }

  const marketData = await provider.getCandles(pair.symbol, timeframe);

  return {
    pair: {
      ...pair,
      lastPrice: marketData.latestPrice,
      change24h: marketData.change24h
    },
    candles: marketData.candles,
    source: marketData.source,
    cache: marketData.cache,
    receivedAt: marketData.receivedAt
  };
}

export function getCachedOhlcv(symbol, timeframe) {
  const pair = getPair(symbol);

  if (!pair || pair.status !== "active") {
    return null;
  }

  const provider = getMarketDataProvider(pair);
  const marketData = provider.getCachedCandles?.(pair.symbol, timeframe);

  if (!marketData) {
    return null;
  }

  return {
    pair: {
      ...pair,
      lastPrice: marketData.latestPrice,
      change24h: marketData.change24h
    },
    candles: marketData.candles,
    source: marketData.source,
    cache: marketData.cache,
    receivedAt: marketData.receivedAt
  };
}

function withAvailability(pair) {
  const availability = getPairProviderAvailability(pair);

  return {
    ...pair,
    status: availability.configured ? "active" : "coming-soon",
    selectable: availability.configured,
    availabilityCode: availability.code,
    availabilityMessage: availability.message
  };
}
