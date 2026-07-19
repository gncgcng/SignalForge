import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const requiredCryptoSymbols = [
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "XRP-USD",
  "ADA-USD",
  "DOGE-USD",
  "LINK-USD",
  "AVAX-USD",
  "LTC-USD",
  "BCH-USD",
  "DOT-USD",
  "UNI-USD",
  "AAVE-USD",
  "MKR-USD",
  "ATOM-USD",
  "ETC-USD",
  "FIL-USD",
  "ICP-USD",
  "NEAR-USD",
  "ARB-USD",
  "OP-USD",
  "APT-USD",
  "SUI-USD",
  "SEI-USD",
  "INJ-USD",
  "HBAR-USD",
  "PEPE-USD",
  "SHIB-USD",
  "BONK-USD",
  "WIF-USD",
  "FLOKI-USD",
  "ENA-USD",
  "TIA-USD",
  "JUP-USD",
  "RNDR-USD",
  "RUNE-USD",
  "GRT-USD",
  "ALGO-USD",
  "XLM-USD",
  "MATIC-USD",
  "COMP-USD",
  "SAND-USD",
  "MANA-USD"
];
const timeframes = ["5m", "15m", "1h", "4h"];
let unavailableProduct = "XRP-USD";
const providerCalls = [];

globalThis.fetch = async (url) => {
  const requestUrl = new URL(url);
  const symbol = decodeURIComponent(requestUrl.pathname.split("/products/")[1].split("/candles")[0]);
  providerCalls.push({ symbol, granularity: requestUrl.searchParams.get("granularity") });

  if (symbol === unavailableProduct) {
    return new Response(JSON.stringify({ message: "NotFound" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const candles = Array.from({ length: 120 }, (_, index) => {
    const price = 100 + index * 0.1;
    return [now - index * 300, price - 0.5, price + 0.5, price, price + 0.2, 1000 + index];
  });
  return new Response(JSON.stringify(candles), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

const {
  getOhlcv,
  listActivePairs,
  listPairs
} = await import("../src/modules/market-data/marketDataService.js");
const {
  coinbaseMarketDataProvider,
  coinbaseSymbols
} = await import("../src/modules/market-data/coinbaseMarketDataProvider.js");

await assert.rejects(
  () => getOhlcv("XRP-USD", "5m"),
  (error) => {
    return error.code === "PROVIDER_UNSUPPORTED_MARKET" &&
      error.message.includes("XRP-USD") &&
      error.message.includes("Coinbase");
  },
  "Coinbase product failures should return a clear market-specific error."
);
unavailableProduct = "";
const { resetCryptoMarketCooldown } = await import("../src/modules/markets/cryptoMarketService.js");
await resetCryptoMarketCooldown("XRP-USD");

const combinations = [];
for (const symbol of requiredCryptoSymbols) {
  for (const timeframe of timeframes) {
    const marketData = await coinbaseMarketDataProvider.getCandles(symbol, timeframe);
    combinations.push({
      symbol,
      timeframe,
      source: marketData.source,
      candleCount: marketData.candles.length
    });
  }
}

const catalog = listPairs();
const activeSymbols = new Set(listActivePairs().map((pair) => pair.symbol));
const signalService = readFileSync(
  new URL("../src/modules/signals/signalService.js", import.meta.url),
  "utf8"
);
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const result = {
  catalogCoverage: requiredCryptoSymbols.every((symbol) => {
    const pair = catalog.find((item) => item.symbol === symbol);
    return pair?.category === "Crypto" &&
      pair.provider === "coinbase-exchange";
  }),
  providerCoverage: requiredCryptoSymbols.every((symbol) => coinbaseSymbols.includes(symbol)),
  allTimeframesSupported: requiredCryptoSymbols.every((symbol) => {
    return timeframes.every((timeframe) => coinbaseMarketDataProvider.supports(symbol, timeframe));
  }),
  candlesParsed: combinations.every((item) => {
    return item.source === "coinbase-exchange" && item.candleCount === 120;
  }),
  scanAllCoverage: activeSymbols.has("BTC-USD") &&
    !activeSymbols.has("MATIC-USD") &&
    signalService.includes("listScannerPairs()"),
  uiGroupsPresent: ["Major crypto", "Altcoins", "Commodities"].every((group) => {
    return catalog.some((pair) => pair.group === group);
  }) && app.includes("pair.group || pair.category"),
  goldPreserved: catalog.some((pair) => {
    return pair.symbol === "XAU/USD" &&
      pair.provider === "twelve-data" &&
      pair.group === "Commodities";
  }),
  gracefulProviderFailure: providerCalls.some((call) => call.symbol === "XRP-USD")
};

console.log(JSON.stringify({
  ...result,
  combinationsTested: combinations.length
}, null, 2));

if (
  Object.values(result).some((value) => value !== true) ||
  combinations.length !== requiredCryptoSymbols.length * timeframes.length
) {
  process.exitCode = 1;
}
