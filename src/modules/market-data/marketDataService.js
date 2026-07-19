import { getMarketDataProvider, getPairProviderAvailability } from "./marketDataProviderRegistry.js";
import { MarketDataProviderError } from "./marketDataProviderError.js";
import { appConfig } from "../../config/appConfig.js";
import { analyzeMarketRegime } from "./marketRegimeService.js";
import { analyzeAdvancedMarketStructure } from "./advancedMarketStructureService.js";
import {
  canUseCryptoTimeframe,
  getCryptoMarketState,
  isCryptoMarketCoolingDown,
  listCryptoMarketSettings,
  listPaperCryptoMarkets,
  listScannerCryptoMarkets,
  recordCryptoMarketFailure,
  recordCryptoMarketSuccess
} from "../markets/cryptoMarketService.js";

const legacyMarketCatalog = [
  { symbol: "BTC-USD", name: "Bitcoin", category: "Crypto", group: "Major crypto", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "ETH-USD", name: "Ethereum", category: "Crypto", group: "Major crypto", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "SOL-USD", name: "Solana", category: "Crypto", group: "Major crypto", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "XRP-USD", name: "XRP", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "ADA-USD", name: "Cardano", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "DOGE-USD", name: "Dogecoin", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "LINK-USD", name: "Chainlink", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "AVAX-USD", name: "Avalanche", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "LTC-USD", name: "Litecoin", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "BCH-USD", name: "Bitcoin Cash", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "DOT-USD", name: "Polkadot", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "UNI-USD", name: "Uniswap", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "AAVE-USD", name: "Aave", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "MKR-USD", name: "Maker", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "ATOM-USD", name: "Cosmos", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "ETC-USD", name: "Ethereum Classic", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "FIL-USD", name: "Filecoin", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "ICP-USD", name: "Internet Computer", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "NEAR-USD", name: "NEAR Protocol", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "ARB-USD", name: "Arbitrum", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "OP-USD", name: "Optimism", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "APT-USD", name: "Aptos", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "SUI-USD", name: "Sui", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "SEI-USD", name: "Sei", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "INJ-USD", name: "Injective", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "HBAR-USD", name: "Hedera", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "PEPE-USD", name: "Pepe", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "SHIB-USD", name: "Shiba Inu", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "BONK-USD", name: "Bonk", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "WIF-USD", name: "dogwifhat", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "FLOKI-USD", name: "Floki", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "ENA-USD", name: "Ethena", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "TIA-USD", name: "Celestia", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "JUP-USD", name: "Jupiter", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "RNDR-USD", name: "Render", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "RUNE-USD", name: "THORChain", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "GRT-USD", name: "The Graph", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "ALGO-USD", name: "Algorand", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "XLM-USD", name: "Stellar", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "MATIC-USD", name: "Polygon", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "COMP-USD", name: "Compound", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "SAND-USD", name: "The Sandbox", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "MANA-USD", name: "Decentraland", category: "Crypto", group: "Altcoins", assetClass: "Crypto", venue: "Coinbase", provider: "coinbase-exchange" },
  { symbol: "XAU/USD", name: "Gold", category: "Commodities", group: "Commodities", assetClass: "Commodity", venue: "OTC", provider: "twelve-data" },
  { symbol: "XAG/USD", name: "Silver", category: "Commodities", group: "Commodities", assetClass: "Commodity", venue: "OTC", provider: "twelve-data" },
  { symbol: "WTI", name: "WTI Crude Oil", category: "Commodities", group: "Commodities", assetClass: "Commodity", venue: "OTC", provider: "twelve-data" },
  { symbol: "BRENT", name: "Brent Crude Oil", category: "Commodities", group: "Commodities", assetClass: "Commodity", venue: "OTC", provider: "twelve-data" },
  { symbol: "NATGAS", name: "Natural Gas", category: "Commodities", group: "Commodities", assetClass: "Commodity", venue: "OTC", provider: "twelve-data", optional: true },
  { symbol: "NVDA", name: "NVIDIA Corp", category: "Stocks & ETFs", group: "Stocks & ETFs", assetClass: "Stock", venue: "NASDAQ", provider: null },
  { symbol: "TSLA", name: "Tesla Inc", category: "Stocks & ETFs", group: "Stocks & ETFs", assetClass: "Stock", venue: "NASDAQ", provider: null },
  { symbol: "AAPL", name: "Apple Inc", category: "Stocks & ETFs", group: "Stocks & ETFs", assetClass: "Stock", venue: "NASDAQ", provider: null },
  { symbol: "SPY", name: "S&P 500 ETF", category: "Stocks & ETFs", group: "Stocks & ETFs", assetClass: "ETF", venue: "NYSE Arca", provider: null }
];

const nonCryptoMarketCatalog = legacyMarketCatalog.filter((market) => market.category !== "Crypto");

function currentMarketCatalog() {
  const activeCryptoMarkets = listCryptoMarketSettings().filter((market) =>
    market.status === "active" && market.enabled
  );
  return [...activeCryptoMarkets, ...nonCryptoMarketCatalog];
}

export function listPairs(query = "") {
  const normalized = query.trim().toLowerCase();
  const pairs = currentMarketCatalog().map(withAvailability);

  if (!normalized) {
    return pairs;
  }

  return pairs.filter((pair) => {
    return [
      pair.symbol,
      pair.displaySymbol,
      pair.providerLabel,
      pair.name,
      pair.group,
      pair.category,
      pair.assetClass,
      pair.venue
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalized);
  });
}

export function getPair(symbol) {
  const pair = getCryptoMarketState(symbol) || nonCryptoMarketCatalog.find((item) => item.symbol === symbol);
  return pair ? withAvailability(pair) : null;
}

export function listActivePairs() {
  return currentMarketCatalog().map(withAvailability).filter((pair) => pair.status === "active");
}

export function listScannerPairs() {
  return listManualScannerPairs();
}

export function listAutoScannerPairs() {
  const crypto = listScannerCryptoMarkets().map(withAvailability).filter((pair) => pair.status === "active");
  if (appConfig.autoScan.cryptoOnly) {
    return crypto;
  }
  return listManualScannerPairs();
}

export function listManualScannerPairs(options = {}) {
  return getManualScannerUniverse(options).markets;
}

export function getManualScannerUniverse(options = {}) {
  const marketType = normalizeMarketType(options.marketType);
  const skipped = [];
  const selected = [];
  const candidates = [
    ...listCryptoMarketSettings().map(withAvailability),
    ...nonCryptoMarketCatalog.map(withAvailability)
  ];

  for (const pair of candidates) {
    const typeMatches = marketType === "all" || getMarketTypeKey(pair) === marketType;
    if (!typeMatches) {
      skipped.push(toSkippedMarket(pair, "market_type_excluded", "Market type excluded by selected filter."));
      continue;
    }

    if (pair.category === "Crypto" && (!pair.enabled || !pair.scannerEnabled)) {
      skipped.push(toSkippedMarket(pair, "scanner_disabled", "Scanner is disabled for this crypto market."));
      continue;
    }

    if (pair.category === "Commodities" && !appConfig.manualScan.twelveDataEnabled) {
      skipped.push(toSkippedMarket(pair, "manual_provider_disabled", "Twelve Data manual scanning is disabled."));
      continue;
    }

    if (!pair.provider) {
      skipped.push(toSkippedMarket(pair, "provider_not_configured", "No market data provider is configured."));
      continue;
    }

    if (pair.status !== "active") {
      skipped.push(toSkippedMarket(pair, pair.availabilityCode || "market_unavailable", pair.availabilityMessage || "Market is not ready for scanning."));
      continue;
    }

    let provider;
    try {
      provider = getMarketDataProvider(pair);
    } catch (error) {
      skipped.push(toSkippedMarket(pair, "provider_not_configured", error.message));
      continue;
    }

    const supportedTimeframes = getSupportedScannerTimeframes(pair, provider);
    if (supportedTimeframes.length === 0) {
      skipped.push(toSkippedMarket(pair, "unsupported_timeframe", "No supported scanner timeframe is available for this provider."));
      continue;
    }

    selected.push({
      ...pair,
      scannerTimeframes: supportedTimeframes
    });
  }

  const limited = selected.slice(0, appConfig.manualScan.maxMarkets);
  for (const pair of selected.slice(appConfig.manualScan.maxMarkets)) {
    skipped.push(toSkippedMarket(pair, "manual_scan_limit", `Manual scan limit reached (${appConfig.manualScan.maxMarkets} markets).`));
  }

  return {
    marketType,
    markets: limited,
    skipped,
    summary: summarizeScannerUniverse(limited, skipped),
    signature: `${marketType}:${limited.map((pair) => `${pair.symbol}:${(pair.scannerTimeframes || []).join(",")}`).join("|")}`
  };
}

export function getSupportedScannerTimeframes(pair, provider = null) {
  let dataProvider = provider;
  try {
    dataProvider ||= getMarketDataProvider(pair);
  } catch {
    return [];
  }
  return appConfig.supportedTimeframes.filter((timeframe) => {
    if (pair.category === "Crypto" && !canUseCryptoTimeframe(pair.symbol, timeframe)) {
      return false;
    }
    return dataProvider.supports(pair.symbol, timeframe);
  });
}

export function listPaperTradingPairs() {
  const crypto = listPaperCryptoMarkets().map(withAvailability);
  const other = nonCryptoMarketCatalog.map(withAvailability).filter((pair) => pair.status === "active");
  return [...crypto, ...other];
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
      pair.category === "Crypto" && pair.availabilityCode === "MARKET_COOLDOWN"
        ? `${pair.symbol} is temporarily paused after a provider failure.`
        : pair.category === "Crypto" && pair.status === "unavailable"
          ? `${pair.symbol}: ${pair.availabilityMessage || "No candle data from provider"}.`
      : pair.category === "Commodities" && pair.availabilityCode === "PROVIDER_NOT_CONFIGURED"
        ? `${pair.symbol}: Data provider not configured.`
        : `${pair.symbol} market data is Coming Soon.`,
      {
        statusCode: 503,
        code: pair.availabilityCode || "MARKET_COMING_SOON"
      }
    );
  }

  if (pair.category === "Crypto" && !canUseCryptoTimeframe(pair.symbol, timeframe)) {
    throw new MarketDataProviderError(
      isCryptoMarketCoolingDown(pair.symbol)
        ? `${pair.symbol} is temporarily paused after a provider failure.`
        : `${pair.symbol} does not have verified candle support for ${timeframe}.`,
      { statusCode: 503, code: isCryptoMarketCoolingDown(pair.symbol) ? "MARKET_COOLDOWN" : "PROVIDER_UNSUPPORTED_MARKET" }
    );
  }

  const provider = getMarketDataProvider(pair);

  if (
    (pair.category === "Crypto" && provider.id !== "coinbase-exchange") ||
    (pair.category === "Commodities" && provider.id !== "twelve-data")
  ) {
    throw new MarketDataProviderError(
      `Invalid provider routing for ${pair.symbol}: ${provider.id}.`,
      { statusCode: 500, code: "INVALID_PROVIDER_ROUTING" }
    );
  }

  if (!provider.supports(pair.symbol, timeframe)) {
    throw new MarketDataProviderError(
      `${provider.id} does not support ${pair.symbol} on ${timeframe}.`,
      { statusCode: 400, code: "PROVIDER_UNSUPPORTED_MARKET" }
    );
  }

  let marketData;
  try {
    marketData = await provider.getCandles(pair.symbol, timeframe);
  } catch (error) {
    if (pair.category === "Crypto") await recordCryptoMarketFailure(pair.symbol, timeframe, error);
    throw error;
  }
  const marketStatus = resolveMarketStatus(pair, timeframe, marketData.candles, marketData.receivedAt);
  if (pair.category === "Crypto") {
    if (!Array.isArray(marketData.candles) || marketData.candles.length < 60) {
      const error = new MarketDataProviderError(`${pair.symbol} returned insufficient OHLCV candles.`, { statusCode: 502, code: "INSUFFICIENT_CANDLES" });
      await recordCryptoMarketFailure(pair.symbol, timeframe, error);
      throw error;
    }
    if (marketStatus.stale) {
      const error = new MarketDataProviderError(`${pair.symbol} latest candle is stale.`, { statusCode: 503, code: "STALE_CANDLES" });
      await recordCryptoMarketFailure(pair.symbol, timeframe, error);
      throw error;
    }
    await recordCryptoMarketSuccess(pair.symbol, timeframe, marketStatus.lastCandleAt);
  }
  const advancedStructure = analyzeAdvancedMarketStructure(marketData.candles, {
    volumeAvailable: marketData.volumeAvailable !== false
  });

  return {
    pair: {
      ...pair,
      lastPrice: marketData.latestPrice,
      change24h: marketData.change24h
    },
    candles: marketData.candles,
    regime: analyzeMarketRegime(marketData.candles),
    advancedStructure,
    source: marketData.source,
    volumeAvailable: marketData.volumeAvailable !== false,
    marketStatus,
    lastCandleAt: marketStatus.lastCandleAt,
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
    regime: analyzeMarketRegime(marketData.candles),
    advancedStructure: analyzeAdvancedMarketStructure(marketData.candles, {
      volumeAvailable: marketData.volumeAvailable !== false
    }),
    source: marketData.source,
    volumeAvailable: marketData.volumeAvailable !== false,
    marketStatus: resolveMarketStatus(pair, timeframe, marketData.candles, marketData.receivedAt),
    lastCandleAt: resolveLastCandleAt(marketData.candles),
    cache: marketData.cache,
    receivedAt: marketData.receivedAt
  };
}

export function resolveMarketStatus(pair, timeframe, candles = [], receivedAt = new Date().toISOString(), now = new Date()) {
  const latestCandleAt = resolveLastCandleAt(candles);
  const ageMs = latestCandleAt ? now.getTime() - new Date(latestCandleAt).getTime() : Infinity;
  const expectedMs = timeframeToMilliseconds(timeframe);
  const stale = !Number.isFinite(ageMs) || ageMs > expectedMs * 2.5;

  if (pair.category === "Crypto") {
    return {
      code: stale ? "DELAYED" : "LIVE",
      label: stale ? "Delayed" : "Live",
      detail: stale ? "Latest crypto candle is older than expected." : "Crypto trades continuously.",
      stale,
      lastCandleAt: latestCandleAt,
      checkedAt: receivedAt
    };
  }

  if (pair.category === "Commodities") {
    const open = isCommodityMarketOpen(now);
    const code = !open ? "CLOSED" : stale ? "DELAYED" : "LIVE";

    return {
      code,
      label: code === "LIVE" ? "Live" : code === "DELAYED" ? "Delayed" : "Closed",
      detail: code === "CLOSED"
        ? "Commodity session is closed or the feed is not actively updating."
        : code === "DELAYED"
          ? "Commodity feed is active, but the latest candle is stale."
          : "Commodity feed is updating during active session hours.",
      stale,
      lastCandleAt: latestCandleAt,
      checkedAt: receivedAt
    };
  }

  return {
    code: "COMING_SOON",
    label: "Coming Soon",
    detail: "Market data is not enabled for this market yet.",
    stale: true,
    lastCandleAt: latestCandleAt,
    checkedAt: receivedAt
  };
}

export function providerIssueStatus(message = "Market data provider is unavailable.") {
  return {
    code: "PROVIDER_ISSUE",
    label: "Provider issue",
    detail: message,
    stale: true,
    lastCandleAt: null,
    checkedAt: new Date().toISOString()
  };
}

function resolveLastCandleAt(candles = []) {
  const latest = candles[candles.length - 1];
  return latest?.time ? new Date(Number(latest.time) * 1000).toISOString() : null;
}

function timeframeToMilliseconds(timeframe) {
  return {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000
  }[timeframe] || 15 * 60 * 1000;
}

export function normalizeMarketType(value = "all") {
  const normalized = String(value || "all").trim().toLowerCase();
  if (["crypto", "commodities", "forex", "stocks"].includes(normalized)) {
    return normalized;
  }
  return "all";
}

function getMarketTypeKey(pair) {
  if (pair.category === "Crypto") return "crypto";
  if (pair.category === "Commodities") return "commodities";
  if (pair.category === "Forex") return "forex";
  if (pair.category === "Stocks & ETFs" || pair.assetClass === "Stock" || pair.assetClass === "ETF") return "stocks";
  return String(pair.category || "").toLowerCase();
}

function toSkippedMarket(pair, reasonCode, reason) {
  return {
    symbol: pair.symbol,
    displaySymbol: pair.displaySymbol || getDisplaySymbol(pair),
    name: pair.name,
    category: pair.category,
    provider: pair.provider,
    providerLabel: pair.providerLabel,
    reasonCode,
    reason
  };
}

function summarizeScannerUniverse(markets, skipped) {
  const countByType = (items, key) => items.filter((item) => getMarketTypeKey(item) === key).length;
  const timeframeSet = new Set(markets.flatMap((item) => item.scannerTimeframes || []));
  const skippedByReason = skipped.reduce((acc, item) => {
    acc[item.reasonCode] = (acc[item.reasonCode] || 0) + 1;
    return acc;
  }, {});

  return {
    totalActive: listActivePairs().length,
    scannerEnabled: markets.length,
    selectedManual: markets.length,
    selectedAuto: listScannerCryptoMarkets().length,
    timeframes: timeframeSet.size,
    scanTasks: markets.reduce((total, item) => total + (item.scannerTimeframes || []).length, 0),
    crypto: countByType(markets, "crypto"),
    commodities: countByType(markets, "commodities"),
    forex: countByType(markets, "forex"),
    stocks: countByType(markets, "stocks"),
    skipped: skipped.length,
    skippedByReason
  };
}

function isCommodityMarketOpen(date) {
  const day = date.getUTCDay();
  const hour = date.getUTCHours();

  if (day === 0) return hour >= 22;
  if (day >= 1 && day <= 4) return true;
  if (day === 5) return hour < 22;
  return false;
}

function withAvailability(pair) {
  const availability = getPairProviderAvailability(pair);
  const displaySymbol = getDisplaySymbol(pair);

  if (pair.category === "Crypto") {
    const operational = getCryptoMarketState(pair.symbol);
    const coolingDown = isCryptoMarketCoolingDown(pair.symbol);
    const available = availability.configured && operational?.enabled && operational.marketStatus === "active" && !coolingDown;
    return {
      ...pair,
      ...operational,
      displaySymbol,
      providerLabel: `Coinbase · ${pair.symbol}`,
      status: available ? "active" : operational?.marketStatus === "disabled" ? "disabled" : "unavailable",
      selectable: available,
      availabilityCode: coolingDown ? "MARKET_COOLDOWN" : operational?.failureCode || availability.code,
      availabilityMessage: operational?.lastError || operational?.statusLabel || availability.message
    };
  }

  return {
    ...pair,
    displaySymbol,
    providerLabel: `${pair.venue}${pair.symbol ? ` · ${pair.symbol}` : ""}`,
    status: availability.configured ? "active" : "coming-soon",
    selectable: availability.configured,
    availabilityCode: availability.code,
    availabilityMessage: availability.message
  };
}

function getDisplaySymbol(pair) {
  if (pair.category === "Crypto") {
    return pair.symbol.replace("-", "");
  }

  return pair.symbol;
}
