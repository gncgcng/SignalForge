import { query } from "../../db/client.js";

// Runtime view of the non-crypto rows in the `markets` table. Crypto rows live in the same table
// but are served by cryptoMarketService, which owns their verification lifecycle.

// Stock placeholders are stored with provider 'none' (markets.provider is NOT NULL); the rest of
// the app has always represented "no provider" as a null provider.
const NO_PROVIDER = "none";

//
// The database is authoritative. bootstrapRows mirrors what migrations 059/060 seed and is used
// only until loadMarketRegistry() runs at boot (and by unit tests that never open a database).
const bootstrapRows = Object.freeze([
  commodityRow("XAU/USD", "XAU/USD", "Gold"),
  commodityRow("XAG/USD", "XAG/USD", "Silver"),
  commodityRow("WTI", "XTI/USD", "WTI Crude Oil"),
  commodityRow("BRENT", "XBR/USD", "Brent Crude Oil"),
  commodityRow("NATGAS", "XNG/USD", "Natural Gas"),
  stockRow("NVDA", "NVIDIA Corp", "NASDAQ"),
  stockRow("TSLA", "Tesla Inc", "NASDAQ"),
  stockRow("AAPL", "Apple Inc", "NASDAQ"),
  stockRow("SPY", "S&P 500 ETF", "NYSE Arca")
]);

const assetClassLabels = Object.freeze({
  crypto: "Crypto",
  commodity: "Commodity",
  stock: "Stock",
  forex: "Forex"
});

let runtime = toRuntime(bootstrapRows);
let loadedFromDatabase = false;

export async function loadMarketRegistry() {
  const result = await query("SELECT * FROM markets WHERE asset_class <> 'crypto' ORDER BY asset_class, symbol");
  runtime = toRuntime(result.rows);
  loadedFromDatabase = true;
  const counts = countByAssetClass([...runtime.values()]);
  console.info(`[markets] loaded non_crypto=${runtime.size} ${Object.entries(counts).map(([key, count]) => `${key}=${count}`).join(" ")}`.trim());
  return listNonCryptoMarkets();
}

export function isMarketRegistryLoaded() {
  return loadedFromDatabase;
}

export function listNonCryptoMarkets() {
  return [...runtime.values()];
}

export function getNonCryptoMarket(symbol) {
  return runtime.get(String(symbol || "").trim().toUpperCase()) || null;
}

export function listMarketsByAssetClass(assetClass) {
  return listNonCryptoMarkets().filter((market) => market.assetClassKey === assetClass);
}

export function isCommoditySymbol(symbol) {
  return getNonCryptoMarket(symbol)?.assetClassKey === "commodity";
}

// Test seam: replace the runtime with explicit rows (snake_case, as stored) without a database.
export function setMarketRegistryRowsForTest(rows) {
  runtime = toRuntime(rows);
}

export function resetMarketRegistryForTest() {
  runtime = toRuntime(bootstrapRows);
  loadedFromDatabase = false;
}

export function mapMarketRow(row) {
  const assetClassKey = row.asset_class;
  const category = row.category || assetClassLabels[assetClassKey] || "Other";
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    category,
    group: category,
    assetClass: assetClassLabels[assetClassKey] || "Other",
    assetClassKey,
    venue: row.venue,
    provider: row.provider && row.provider !== NO_PROVIDER ? row.provider : null,
    providerSymbol: row.provider_symbol,
    exchangeTimezone: row.exchange_timezone || null,
    sessionCalendarId: row.session_calendar_id || null,
    enabled: row.enabled !== false,
    scannerEnabled: row.scanner_enabled !== false,
    paperTradingEnabled: row.paper_trading_enabled !== false,
    watchlistEnabled: row.watchlist_enabled !== false,
    supportedTimeframes: row.supported_timeframes || []
  };
}

function toRuntime(rows) {
  return new Map(rows
    .filter((row) => row.asset_class !== "crypto" && row.enabled !== false)
    .sort((a, b) => a.asset_class.localeCompare(b.asset_class) || a.symbol.localeCompare(b.symbol))
    .map((row) => [String(row.symbol).toUpperCase(), Object.freeze(mapMarketRow(row))]));
}

function countByAssetClass(markets) {
  return markets.reduce((counts, market) => {
    counts[market.assetClassKey] = (counts[market.assetClassKey] || 0) + 1;
    return counts;
  }, {});
}

function commodityRow(symbol, providerSymbol, name) {
  return Object.freeze({
    id: `commodity:${symbol}`,
    symbol,
    asset_class: "commodity",
    provider: "twelve-data",
    provider_symbol: providerSymbol,
    exchange_timezone: "America/New_York",
    session_calendar_id: "us_commodity_week",
    category: "Commodities",
    venue: "OTC",
    scanner_enabled: true,
    name,
    display_symbol: symbol,
    enabled: true,
    supported_timeframes: ["5m", "15m", "1h", "4h"]
  });
}

function stockRow(symbol, name, venue) {
  return Object.freeze({
    id: `stock:${symbol}`,
    symbol,
    asset_class: "stock",
    provider: NO_PROVIDER,
    provider_symbol: symbol,
    exchange_timezone: null,
    session_calendar_id: null,
    category: "Stocks & ETFs",
    venue,
    scanner_enabled: false,
    name,
    display_symbol: symbol,
    enabled: true,
    supported_timeframes: []
  });
}
