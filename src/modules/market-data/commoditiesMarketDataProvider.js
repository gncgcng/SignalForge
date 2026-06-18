import { appConfig } from "../../config/appConfig.js";
import { MarketDataProviderError } from "./marketDataProviderError.js";

const providerSymbols = {
  "XAU/USD": "XAU/USD",
  "XAG/USD": "XAG/USD",
  WTI: "XTI/USD",
  BRENT: "XBR/USD"
};

const providerIntervals = {
  "5m": "5min",
  "15m": "15min",
  "1h": "1h",
  "4h": "4h"
};

const cache = new Map();

export const commoditiesMarketDataProvider = {
  id: "twelve-data",
  category: "Commodities",
  isConfigured() {
    return appConfig.commodities.enabled &&
      appConfig.commodities.provider === "twelve-data" &&
      Boolean(appConfig.commodities.apiKey);
  },
  supports(symbol, timeframe) {
    return Object.hasOwn(providerSymbols, symbol) &&
      Object.hasOwn(providerIntervals, timeframe);
  },
  async getCandles(symbol, timeframe) {
    if (!this.isConfigured()) {
      throw new MarketDataProviderError(
        `${symbol} live commodity data is not configured. Set COMMODITIES_LIVE_ENABLED=true and COMMODITIES_API_KEY to enable it.`,
        { statusCode: 503, code: "PROVIDER_NOT_CONFIGURED" }
      );
    }

    if (!this.supports(symbol, timeframe)) {
      throw new MarketDataProviderError(`The commodities provider does not support ${symbol} on ${timeframe}.`, {
        statusCode: 400,
        code: "PROVIDER_UNSUPPORTED_MARKET"
      });
    }

    const cacheKey = `${symbol}:${timeframe}`;
    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.cachedAt < appConfig.marketData.cacheTtlMs) {
      return { ...cached.payload, cache: "hit" };
    }

    const url = new URL("/time_series", appConfig.commodities.baseUrl);
    url.searchParams.set("symbol", providerSymbols[symbol]);
    url.searchParams.set("interval", providerIntervals[timeframe]);
    url.searchParams.set("outputsize", String(appConfig.marketData.candleLimit));
    url.searchParams.set("format", "JSON");
    url.searchParams.set("apikey", appConfig.commodities.apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), appConfig.marketData.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" }
      });

      if (response.status === 429) {
        throw providerError("Commodity market data rate limit reached.", 429, "RATE_LIMITED");
      }

      if (!response.ok) {
        throw providerError(`Commodity provider returned ${response.status}.`, response.status, "PROVIDER_RESPONSE_ERROR");
      }

      const body = await response.json();

      if (body.status === "error" || !Array.isArray(body.values)) {
        throw providerError(
          body.message || `Commodity provider does not support ${symbol} on ${timeframe}.`,
          400,
          "PROVIDER_UNSUPPORTED_MARKET"
        );
      }

      const candles = body.values
        .map((value) => ({
          time: Math.floor(new Date(`${value.datetime}Z`).getTime() / 1000),
          open: Number(value.open),
          high: Number(value.high),
          low: Number(value.low),
          close: Number(value.close),
          volume: Number(value.volume)
        }))
        .filter(isValidOhlcvCandle)
        .sort((a, b) => a.time - b.time);

      if (candles.length < 60) {
        throw providerError(
          `${symbol} returned insufficient OHLCV data for signal analysis. Volume data may be unavailable on the configured provider plan.`,
          422,
          "INSUFFICIENT_OHLCV"
        );
      }

      const latest = candles[candles.length - 1];
      const previous = candles[Math.max(0, candles.length - 25)];
      const payload = {
        symbol,
        timeframe,
        candles,
        latestPrice: latest.close,
        change24h: previous.close === 0 ? 0 : ((latest.close - previous.close) / previous.close) * 100,
        source: this.id,
        receivedAt: new Date().toISOString()
      };

      cache.set(cacheKey, { cachedAt: Date.now(), payload });
      return { ...payload, cache: "miss" };
    } catch (error) {
      if (error instanceof MarketDataProviderError) {
        throw error;
      }

      if (error.name === "AbortError") {
        throw providerError("Commodity market data request timed out.", 504, "MARKET_DATA_TIMEOUT");
      }

      throw providerError("Unable to reach the commodity market data provider.", 503, "PROVIDER_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  }
};

function isValidOhlcvCandle(candle) {
  return Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    Number.isFinite(candle.volume) &&
    candle.volume >= 0;
}

function providerError(message, statusCode, code) {
  return new MarketDataProviderError(message, { statusCode, code });
}
