import { appConfig } from "../../config/appConfig.js";

const granularityByTimeframe = {
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 21600
};

const cache = new Map();

export class MarketDataProviderError extends Error {
  constructor(message, { statusCode, code } = {}) {
    super(message);
    this.name = "MarketDataProviderError";
    this.statusCode = statusCode;
    this.code = code || "MARKET_DATA_ERROR";
  }
}

export async function getCandlesFromCoinbase(symbol, timeframe) {
  const granularity = granularityByTimeframe[timeframe];

  if (!granularity) {
    throw new MarketDataProviderError("Unsupported timeframe.", { statusCode: 400, code: "UNSUPPORTED_TIMEFRAME" });
  }

  const cacheKey = `${symbol}:${timeframe}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.cachedAt < appConfig.marketData.cacheTtlMs) {
    return {
      ...cached.payload,
      cache: "hit"
    };
  }

  const end = new Date();
  const start = new Date(end.getTime() - granularity * appConfig.marketData.candleLimit * 1000);
  const url = new URL(`/products/${encodeURIComponent(symbol)}/candles`, appConfig.marketData.baseUrl);
  url.searchParams.set("granularity", String(granularity));
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("end", end.toISOString());

  const controller = new AbortController();
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

    const candles = rawCandles
      .map(([time, low, high, open, close, volume]) => ({
        time: Number(time),
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume)
      }))
      .filter((candle) => {
        return Number.isFinite(candle.time) &&
          Number.isFinite(candle.open) &&
          Number.isFinite(candle.high) &&
          Number.isFinite(candle.low) &&
          Number.isFinite(candle.close) &&
          Number.isFinite(candle.volume);
      })
      .sort((a, b) => a.time - b.time);

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
      latestPrice: latest.close,
      change24h,
      source: appConfig.marketData.provider,
      receivedAt: new Date().toISOString()
    };

    cache.set(cacheKey, {
      cachedAt: Date.now(),
      payload
    });

    return {
      ...payload,
      cache: "miss"
    };
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
  } finally {
    clearTimeout(timeout);
  }
}
