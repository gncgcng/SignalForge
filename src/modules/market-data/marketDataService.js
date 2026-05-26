import { getCandlesFromCoinbase } from "./coinbaseMarketDataProvider.js";

export const tradingPairs = [
  { symbol: "BTC-USD", name: "Bitcoin", assetClass: "Crypto", venue: "Coinbase", status: "active" },
  { symbol: "ETH-USD", name: "Ethereum", assetClass: "Crypto", venue: "Coinbase", status: "active" },
  { symbol: "SOL-USD", name: "Solana", assetClass: "Crypto", venue: "Coinbase", status: "active" },
  { symbol: "NVDA", name: "NVIDIA Corp", assetClass: "Stock", venue: "NASDAQ", status: "coming-soon" },
  { symbol: "TSLA", name: "Tesla Inc", assetClass: "Stock", venue: "NASDAQ", status: "coming-soon" },
  { symbol: "AAPL", name: "Apple Inc", assetClass: "Stock", venue: "NASDAQ", status: "coming-soon" },
  { symbol: "SPY", name: "S&P 500 ETF", assetClass: "ETF", venue: "NYSE Arca", status: "coming-soon" }
];

export function listPairs(query = "") {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return tradingPairs;
  }

  return tradingPairs.filter((pair) => {
    return [pair.symbol, pair.name, pair.assetClass, pair.venue]
      .join(" ")
      .toLowerCase()
      .includes(normalized);
  });
}

export function getPair(symbol) {
  return tradingPairs.find((pair) => pair.symbol === symbol);
}

export async function getMarketSnapshot(symbol, timeframe = "15m") {
  const pair = getPair(symbol);

  if (!pair) {
    throw new Error("Trading pair not found.");
  }

  if (pair.status !== "active") {
    throw new Error(`${pair.symbol} market data is coming soon.`);
  }

  const marketData = await getCandlesFromCoinbase(symbol, timeframe);

  return {
    ...pair,
    lastPrice: marketData.latestPrice,
    change24h: marketData.change24h,
    source: marketData.source,
    receivedAt: marketData.receivedAt
  };
}

export async function getOhlcv(symbol, timeframe) {
  const pair = getPair(symbol);

  if (!pair) {
    throw new Error("Trading pair not found.");
  }

  if (pair.status !== "active") {
    throw new Error(`${pair.symbol} market data is coming soon.`);
  }

  const marketData = await getCandlesFromCoinbase(symbol, timeframe);

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
