import { appConfig } from "../../config/appConfig.js";
import { MarketDataProviderError } from "./marketDataProviderError.js";
import { cryptoProviderSymbols } from "../markets/cryptoMarkets.js";
import {
  aggregateHourlyCandlesToFourHours,
  inspectCandleIntervals,
  normalizeCanonicalCandles,
  selectCompletedCandles,
  timeframeDurationSeconds
} from "./candleIntegrity.js";

const providerGranularityByTimeframe = {
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 3600
};

const coinbaseMaximumCandlesPerRequest = 300;
const maximumLivePages = 12;

export const coinbaseSymbols = cryptoProviderSymbols;

const cache = new Map();
let activeRequests = 0;
const requestQueue = [];

export async function getCandlesFromCoinbase(symbol, timeframe, input = {}) {
  const granularity = providerGranularityByTimeframe[timeframe];

  if (!granularity) {
    throw new MarketDataProviderError("Unsupported timeframe.", { statusCode: 400, code: "UNSUPPORTED_TIMEFRAME" });
  }

  const completedOnly = input.completedOnly === true;
  const nowMs = finiteTime(input.nowMs, Date.now());
  const candleLimit = Math.min(appConfig.marketData.candleLimit, appConfig.cryptoMarkets.maxCandlesPerRequest);
  const cacheKey = `${symbol}:${timeframe}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.cachedAt < appConfig.marketData.cacheTtlMs) {
    return applyRequestedCandleContract(cached.payload, timeframe, { completedOnly, nowMs, candleLimit, cache: "hit" });
  }

  try {
    const rawTarget = timeframe === "4h" ? candleLimit * 4 + 4 : candleLimit + 2;
    const hourlyOrNativeCandles = await fetchRecentCandlePages(symbol, timeframe, granularity, {
      nowMs,
      rawTarget,
      completedOnly,
      outputLimit: candleLimit
    });
    const candles = timeframe === "4h"
      ? aggregateHourlyCandlesToFourHours(hourlyOrNativeCandles, {
          completedOnly: false,
          nowMs,
          limit: candleLimit
        })
      : normalizeCanonicalCandles(hourlyOrNativeCandles).slice(-candleLimit);

    if (candles.length === 0) {
      throw new MarketDataProviderError("Market data provider returned malformed candles.", {
        statusCode: 502,
        code: "BAD_CANDLES"
      });
    }

    const latest = candles[candles.length - 1];
    const previous = candles[Math.max(0, candles.length - 25)];
    const change24h = previous.close === 0 ? 0 : ((latest.close - previous.close) / previous.close) * 100;
    const payload = {
      symbol,
      timeframe,
      candles,
      sourceCandles: hourlyOrNativeCandles,
      latestPrice: latest.close,
      change24h,
      source: appConfig.marketData.provider,
      receivedAt: new Date().toISOString()
    };

    cache.set(cacheKey, {
      cachedAt: Date.now(),
      payload
    });

    return applyRequestedCandleContract(payload, timeframe, { completedOnly, nowMs, candleLimit, cache: "miss" });
  } catch (error) {
    if (error instanceof MarketDataProviderError) {
      throw error;
    }

    if (error.name === "AbortError") {
      throw new MarketDataProviderError("Market data request timed out.", {
        statusCode: 504,
        code: "MARKET_DATA_TIMEOUT"
      });
    }

    throw new MarketDataProviderError("Unable to reach market data provider.", {
      statusCode: 503,
      code: "PROVIDER_UNAVAILABLE"
    });
  }
}

export async function getHistoricalCandlesFromCoinbase(symbol, timeframe, input = {}) {
  const granularity = providerGranularityByTimeframe[timeframe];
  const semanticDuration = timeframeDurationSeconds[timeframe];
  const from = new Date(input.from);
  const to = new Date(input.to);
  const maxCandles = Math.min(2400, Math.max(60, Number(input.maxCandles || 1200)));
  if (!granularity || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new MarketDataProviderError("Invalid historical candle request.", {
      statusCode: 400,
      code: "INVALID_HISTORICAL_WINDOW"
    });
  }

  const expectedCandles = Math.ceil((to.getTime() - from.getTime()) / (semanticDuration * 1000));
  if (expectedCandles > maxCandles) {
    throw new MarketDataProviderError("Historical signal window is larger than the safe review limit.", {
      statusCode: 400,
      code: "HISTORICAL_WINDOW_TOO_LARGE"
    });
  }

  const requestFromMs = timeframe === "4h"
    ? Math.floor(from.getTime() / (timeframeDurationSeconds["4h"] * 1000)) * timeframeDurationSeconds["4h"] * 1000
    : from.getTime();
  const candleMap = new Map();
  const pageSpanMs = granularity * 299 * 1000;
  let cursor = requestFromMs;
  while (cursor <= to.getTime()) {
    const pageEnd = Math.min(to.getTime(), cursor + pageSpanMs);
    const url = new URL(`/products/${encodeURIComponent(symbol)}/candles`, appConfig.marketData.baseUrl);
    url.searchParams.set("granularity", String(granularity));
    url.searchParams.set("start", new Date(cursor).toISOString());
    url.searchParams.set("end", new Date(pageEnd).toISOString());
    for (const candle of await fetchHistoricalCandlePage(url)) candleMap.set(candle.time, candle);
    cursor = pageEnd + granularity * 1000;
  }

  const sourceCandles = [...candleMap.values()].sort((a, b) => a.time - b.time);
  const candles = (timeframe === "4h"
    ? aggregateHourlyCandlesToFourHours(sourceCandles, {
        completedOnly: false,
        nowMs: to.getTime(),
        limit: maxCandles
      })
    : normalizeCanonicalCandles(sourceCandles))
    .filter((candle) => candle.time * 1000 >= requestFromMs && candle.time * 1000 <= to.getTime())
    .slice(-maxCandles);
  if (!candles.length) {
    throw new MarketDataProviderError("Historical chart data is unavailable for this signal.", {
      statusCode: 404,
      code: "EMPTY_HISTORICAL_CANDLES"
    });
  }
  const latestPrice = Number(candles.at(-1).close);
  const comparison = candles[Math.max(0, candles.length - Math.ceil(86400 / semanticDuration) - 1)]?.close;
  return {
    candles,
    latestPrice,
    change24h: Number(comparison) ? ((latestPrice - Number(comparison)) / Number(comparison)) * 100 : 0,
    source: "Coinbase Exchange historical candles",
    volumeAvailable: true,
    receivedAt: new Date().toISOString(),
    cache: "review"
  };
}

async function fetchRecentCandlePages(symbol, timeframe, granularity, input) {
  const candleMap = new Map();
  const perPage = Math.min(coinbaseMaximumCandlesPerRequest, appConfig.cryptoMarkets.maxCandlesPerRequest);
  let cursorEndSeconds = Math.floor(input.nowMs / 1000 / granularity) * granularity;

  for (let page = 0; page < maximumLivePages; page += 1) {
    const remaining = Math.max(perPage, input.rawTarget - candleMap.size);
    const pageCandles = Math.min(perPage, remaining);
    const pageStartSeconds = cursorEndSeconds - granularity * (pageCandles - 1);
    const url = buildCandlesUrl(symbol, granularity, pageStartSeconds * 1000, cursorEndSeconds * 1000);
    const pageCandlesResult = await fetchCandlePage(url, symbol, timeframe);
    for (const candle of pageCandlesResult) candleMap.set(candle.time, candle);

    const raw = [...candleMap.values()];
    const usableCount = timeframe === "4h"
      ? aggregateHourlyCandlesToFourHours(raw, {
          completedOnly: input.completedOnly,
          nowMs: input.nowMs
        }).length
      : input.completedOnly
        ? selectCompletedCandles(raw, timeframe, { nowMs: input.nowMs }).length
        : normalizeCanonicalCandles(raw).length;
    if (usableCount >= input.outputLimit) break;
    cursorEndSeconds = pageStartSeconds - granularity;
  }

  return normalizeCanonicalCandles([...candleMap.values()]);
}

function buildCandlesUrl(symbol, granularity, startMs, endMs) {
  const url = new URL(`/products/${encodeURIComponent(symbol)}/candles`, appConfig.marketData.baseUrl);
  url.searchParams.set("granularity", String(granularity));
  url.searchParams.set("start", new Date(startMs).toISOString());
  url.searchParams.set("end", new Date(endMs).toISOString());
  return url;
}

async function fetchCandlePage(url, symbol, timeframe) {
  const controller = new AbortController();
  await acquireRequestSlot();
  const timeout = setTimeout(() => controller.abort(), appConfig.marketData.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "SignalForge/0.1"
      }
    });
    if (response.status === 429) {
      throw new MarketDataProviderError("Market data rate limit reached. Please wait a moment and try again.", {
        statusCode: 429,
        code: "RATE_LIMITED"
      });
    }
    if (response.status === 400 || response.status === 404) {
      throw new MarketDataProviderError(
        `Coinbase does not support ${symbol} on ${timeframe}, or the product is temporarily unavailable.`,
        { statusCode: 400, code: "PROVIDER_UNSUPPORTED_MARKET" }
      );
    }
    if (!response.ok) {
      throw new MarketDataProviderError(`Market data provider returned ${response.status}.`, {
        statusCode: response.status,
        code: "PROVIDER_RESPONSE_ERROR"
      });
    }
    const rawCandles = await response.json();
    if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
      throw new MarketDataProviderError("Market data provider returned no candles.", {
        statusCode: 502,
        code: "EMPTY_CANDLES"
      });
    }
    return normalizeCoinbaseCandleRows(rawCandles);
  } catch (error) {
    if (error instanceof MarketDataProviderError) throw error;
    if (error.name === "AbortError") {
      throw new MarketDataProviderError("Market data request timed out.", {
        statusCode: 504,
        code: "MARKET_DATA_TIMEOUT"
      });
    }
    throw new MarketDataProviderError("Unable to reach market data provider.", {
      statusCode: 503,
      code: "PROVIDER_UNAVAILABLE"
    });
  } finally {
    clearTimeout(timeout);
    releaseRequestSlot();
  }
}

function normalizeCoinbaseCandleRows(rawCandles) {
  return normalizeCanonicalCandles(rawCandles.map(([time, low, high, open, close, volume]) => ({
    time: Number(time),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume)
  })));
}

function applyRequestedCandleContract(payload, timeframe, input) {
  const candles = input.completedOnly
    ? timeframe === "4h"
      ? aggregateHourlyCandlesToFourHours(payload.sourceCandles || payload.candles, {
          completedOnly: true,
          nowMs: input.nowMs,
          limit: input.candleLimit
        })
      : selectCompletedCandles(payload.sourceCandles || payload.candles, timeframe, {
          nowMs: input.nowMs,
          limit: input.candleLimit
        })
    : payload.candles.slice(-input.candleLimit);
  const latest = candles.at(-1);
  const previous = candles[Math.max(0, candles.length - Math.ceil(86400 / timeframeDurationSeconds[timeframe]) - 1)];
  const { sourceCandles: _sourceCandles, ...publicPayload } = payload;
  return {
    ...publicPayload,
    candles,
    latestPrice: latest?.close ?? payload.latestPrice,
    change24h: latest && previous?.close
      ? ((latest.close - previous.close) / previous.close) * 100
      : payload.change24h,
    integrity: inspectCandleIntervals(candles, timeframe),
    candleContract: input.completedOnly ? "completed_only" : "live_visual",
    cache: input.cache
  };
}

function finiteTime(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function fetchHistoricalCandlePage(url) {
  const controller = new AbortController();
  await acquireRequestSlot();
  const timeout = setTimeout(() => controller.abort(), appConfig.marketData.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "SignalForge/0.1" }
    });
    if (response.status === 429) {
      throw new MarketDataProviderError("Market data rate limit reached. Please retry later.", {
        statusCode: 429,
        code: "RATE_LIMITED"
      });
    }
    if (!response.ok) {
      throw new MarketDataProviderError(`Historical market data provider returned ${response.status}.`, {
        statusCode: response.status,
        code: response.status === 400 || response.status === 404
          ? "PROVIDER_UNSUPPORTED_MARKET"
          : "PROVIDER_RESPONSE_ERROR"
      });
    }
    const raw = await response.json();
    if (!Array.isArray(raw)) {
      throw new MarketDataProviderError("Historical market data response was malformed.", {
        statusCode: 502,
        code: "BAD_CANDLES"
      });
    }
    return raw.map(([time, low, high, open, close, volume]) => ({
      time: Number(time),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume)
    })).filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite));
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new MarketDataProviderError("Historical market data request timed out.", {
        statusCode: 504,
        code: "PROVIDER_TIMEOUT"
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    releaseRequestSlot();
  }
}

export async function getProductsFromCoinbase() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), appConfig.marketData.requestTimeoutMs);
  try {
    const response = await fetch(new URL("/products", appConfig.marketData.baseUrl), {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "SignalForge/0.1" }
    });
    if (!response.ok) {
      throw new MarketDataProviderError(`Coinbase products returned ${response.status}.`, {
        statusCode: response.status,
        code: "PROVIDER_RESPONSE_ERROR"
      });
    }
    const products = await response.json();
    if (!Array.isArray(products)) {
      throw new MarketDataProviderError("Coinbase products response was invalid.", {
        statusCode: 502,
        code: "BAD_PROVIDER_RESPONSE"
      });
    }
    return products;
  } catch (error) {
    if (error instanceof MarketDataProviderError) throw error;
    if (error.name === "AbortError") {
      throw new MarketDataProviderError("Coinbase product sync timed out.", {
        statusCode: 504,
        code: "MARKET_DATA_TIMEOUT"
      });
    }
    throw new MarketDataProviderError("Unable to reach Coinbase product catalog.", {
      statusCode: 503,
      code: "PROVIDER_UNAVAILABLE"
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function getProductFromCoinbase(symbol) {
  const productId = String(symbol || "").trim().toUpperCase();
  if (!isCoinbaseUsdCryptoSymbol(productId)) {
    throw new MarketDataProviderError(`Coinbase product symbol is invalid: ${symbol}.`, {
      statusCode: 400,
      code: "PROVIDER_UNSUPPORTED_MARKET"
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), appConfig.marketData.requestTimeoutMs);
  try {
    const response = await fetch(new URL(`/products/${encodeURIComponent(productId)}`, appConfig.marketData.baseUrl), {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "SignalForge/0.1" }
    });

    if (response.status === 404 || response.status === 400) {
      throw new MarketDataProviderError(`Coinbase product not found: ${productId}.`, {
        statusCode: response.status,
        code: "PROVIDER_UNSUPPORTED_MARKET"
      });
    }

    if (response.status === 429) {
      throw new MarketDataProviderError("Coinbase product check rate limited.", {
        statusCode: 429,
        code: "RATE_LIMITED"
      });
    }

    if (!response.ok) {
      throw new MarketDataProviderError(`Coinbase product check returned ${response.status}.`, {
        statusCode: response.status,
        code: "PROVIDER_RESPONSE_ERROR"
      });
    }

    const product = await response.json();
    if (!product || typeof product !== "object") {
      throw new MarketDataProviderError("Coinbase product response was invalid.", {
        statusCode: 502,
        code: "BAD_PROVIDER_RESPONSE"
      });
    }

    return product;
  } catch (error) {
    if (error instanceof MarketDataProviderError) throw error;
    if (error.name === "AbortError") {
      throw new MarketDataProviderError("Coinbase product check timed out.", {
        statusCode: 504,
        code: "MARKET_DATA_TIMEOUT"
      });
    }
    throw new MarketDataProviderError("Unable to reach Coinbase product check.", {
      statusCode: 503,
      code: "PROVIDER_UNAVAILABLE"
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function isCoinbaseUsdCryptoSymbol(symbol) {
  return /^[A-Z0-9]{1,20}-USD$/.test(String(symbol || "").trim().toUpperCase());
}

export function getCoinbaseRequestState() {
  return { active: activeRequests, queued: requestQueue.length, limit: appConfig.cryptoMarkets.maxConcurrentRequests };
}

async function acquireRequestSlot() {
  if (activeRequests < appConfig.cryptoMarkets.maxConcurrentRequests) {
    activeRequests += 1;
    return;
  }
  await new Promise((resolve) => requestQueue.push(resolve));
  activeRequests += 1;
}

function releaseRequestSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  requestQueue.shift()?.();
}

export const coinbaseMarketDataProvider = {
  id: "coinbase-exchange",
  category: "Crypto",
  isConfigured() {
    return true;
  },
  supports(symbol, timeframe) {
    return isCoinbaseUsdCryptoSymbol(symbol) &&
      Object.hasOwn(providerGranularityByTimeframe, timeframe);
  },
  async getCandles(symbol, timeframe, input) {
    if (!this.supports(symbol, timeframe)) {
      throw new MarketDataProviderError(`Coinbase does not support ${symbol} on ${timeframe}.`, {
        statusCode: 400,
        code: "PROVIDER_UNSUPPORTED_MARKET"
      });
    }

    return getCandlesFromCoinbase(symbol, timeframe, input);
  },
  async getHistoricalCandles(symbol, timeframe, input) {
    if (!this.supports(symbol, timeframe)) {
      throw new MarketDataProviderError(`Coinbase does not support ${symbol} on ${timeframe}.`, {
        statusCode: 400,
        code: "PROVIDER_UNSUPPORTED_MARKET"
      });
    }
    return getHistoricalCandlesFromCoinbase(symbol, timeframe, input);
  }
};
