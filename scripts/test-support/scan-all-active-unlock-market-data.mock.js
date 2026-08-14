import * as actual from "../../src/modules/market-data/marketDataService.js?active-scan-actual=1";

export * from "../../src/modules/market-data/marketDataService.js?active-scan-actual=1";

const symbols = [
  "BTC-USD",
  "SOL-USD",
  "ETH-USD",
  "PEPE-USD",
  "BONK-USD",
  "WIF-USD",
  "FLOKI-USD",
  "FIL-USD",
  "ALGO-USD",
  "XLM-USD",
  "HBAR-USD",
  "SEI-USD"
];

export function getManualScannerUniverse(options = {}) {
  const selectedSymbols = options.marketType === "commodities" ? ["PEPE-USD"] : symbols;
  const markets = selectedSymbols.map((symbol) => ({
    symbol,
    displaySymbol: symbol.replace("-", ""),
    providerSymbol: symbol,
    name: symbol,
    category: "Crypto",
    provider: "coinbase-exchange",
    enabled: true,
    scannerEnabled: true,
    status: "active",
    scannerTimeframes: ["15m"]
  }));
  const count = markets.length;
  return {
    marketType: "crypto",
    markets,
    skipped: [],
    summary: {
      selectedMarkets: count,
      crypto: count,
      commodities: 0,
      scanTasks: count,
      activeMarkets: { total: count, crypto: count, commodities: 0 },
      scannerEnabledMarkets: { total: count, crypto: count, commodities: 0 },
      skippedByReason: {},
      selectedFilter: options.marketType || "crypto"
    },
    signature: `active-unlock:${options.marketType || "crypto"}:${selectedSymbols.join("|")}`
  };
}

export function getOhlcv(symbol, timeframe) {
  const controlled = globalThis.__signalForgeActiveScanMarketData?.(symbol, timeframe);
  return controlled || actual.getOhlcv(symbol, timeframe);
}
