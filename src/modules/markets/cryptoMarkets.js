export const cryptoTimeframes = Object.freeze(["5m", "15m", "1h", "4h"]);

const primaryScannerSymbols = new Set([
  "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "ADA-USD", "DOGE-USD",
  "LINK-USD", "AVAX-USD", "LTC-USD", "BCH-USD", "DOT-USD", "UNI-USD",
  "AAVE-USD", "ATOM-USD", "ETC-USD", "NEAR-USD", "OP-USD", "ARB-USD",
  "INJ-USD", "ICP-USD"
]);

const highVolatilitySymbols = new Set([
  "SHIB-USD", "PEPE-USD", "BONK-USD", "WIF-USD", "FLOKI-USD"
]);

const definitions = [
  ["BTC-USD", "Bitcoin", "major"], ["ETH-USD", "Ethereum", "major"],
  ["SOL-USD", "Solana", "major"], ["XRP-USD", "XRP", "major"],
  ["ADA-USD", "Cardano", "major"], ["DOGE-USD", "Dogecoin", "major"],
  ["LINK-USD", "Chainlink", "major"], ["AVAX-USD", "Avalanche", "major"],
  ["LTC-USD", "Litecoin", "major"], ["BCH-USD", "Bitcoin Cash", "major"],
  ["DOT-USD", "Polkadot", "major"], ["UNI-USD", "Uniswap", "major"],
  ["AAVE-USD", "Aave", "major"], ["ATOM-USD", "Cosmos", "major"],
  ["ETC-USD", "Ethereum Classic", "major"], ["NEAR-USD", "NEAR Protocol", "major"],
  ["OP-USD", "Optimism", "major"], ["ARB-USD", "Arbitrum", "major"],
  ["INJ-USD", "Injective", "major"], ["ICP-USD", "Internet Computer", "major"],
  ["SHIB-USD", "Shiba Inu", "high-volatility"], ["PEPE-USD", "Pepe", "high-volatility"],
  ["BONK-USD", "Bonk", "high-volatility"], ["FIL-USD", "Filecoin", "standard"],
  ["ALGO-USD", "Algorand", "standard"], ["XLM-USD", "Stellar", "standard"],
  ["HBAR-USD", "Hedera", "standard"], ["SUI-USD", "Sui", "standard"],
  ["SEI-USD", "Sei", "standard"], ["RENDER-USD", "Render", "standard"],
  ["FET-USD", "Artificial Superintelligence Alliance", "standard"],
  ["GRT-USD", "The Graph", "standard"], ["POL-USD", "Polygon Ecosystem Token", "standard"],
  ["APT-USD", "Aptos", "standard"], ["WIF-USD", "dogwifhat", "high-volatility"],
  ["FLOKI-USD", "Floki", "high-volatility"], ["ENA-USD", "Ethena", "standard"],
  ["TIA-USD", "Celestia", "standard"], ["JUP-USD", "Jupiter", "standard"],
  ["RUNE-USD", "THORChain", "standard"], ["COMP-USD", "Compound", "standard"],
  ["SAND-USD", "The Sandbox", "standard"], ["MANA-USD", "Decentraland", "standard"],
  ["MKR-USD", "Maker", "standard"], ["MATIC-USD", "Polygon (legacy product)", "standard"],
  ["RNDR-USD", "Render (legacy product)", "standard"]
];

export const cryptoMarketUniverse = Object.freeze(definitions.map(([providerSymbol, name, liquidityTier]) => {
  const displaySymbol = providerSymbol.replace("-", "");
  return Object.freeze({
    symbol: providerSymbol,
    displaySymbol,
    providerSymbol,
    name,
    category: "Crypto",
    group: liquidityTier === "major" ? "Major crypto" : "Altcoins",
    assetClass: "Crypto",
    venue: "Coinbase",
    provider: "coinbase-exchange",
    enabled: true,
    scannerEnabled: primaryScannerSymbols.has(providerSymbol),
    paperTradingEnabled: true,
    watchlistEnabled: true,
    minTimeframesSupported: 1,
    supportedTimeframes: cryptoTimeframes,
    liquidityTier: highVolatilitySymbols.has(providerSymbol) ? "high-volatility" : liquidityTier
  });
}));

export const cryptoProviderSymbols = Object.freeze(cryptoMarketUniverse.map((market) => market.providerSymbol));

export function findCryptoMarket(symbol) {
  const normalized = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cryptoMarketUniverse.find((market) => [market.symbol, market.displaySymbol, market.providerSymbol]
    .some((value) => String(value).toUpperCase().replace(/[^A-Z0-9]/g, "") === normalized)) || null;
}

export function cryptoMarketMatchesSearch(market, query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return true;
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  const text = [
    market.symbol, market.displaySymbol, market.providerSymbol, market.name,
    `Coinbase ${market.providerSymbol}`, market.liquidityTier
  ].join(" ").toLowerCase();
  return text.includes(normalized) || text.replace(/[^a-z0-9]/g, "").includes(compact);
}
