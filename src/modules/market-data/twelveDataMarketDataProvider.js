import { appConfig } from "../../config/appConfig.js";
import { MarketDataProviderError } from "./marketDataProviderError.js";
import { getNonCryptoMarket } from "../markets/marketRegistry.js";

const providerIntervals = {
  "5m": "5min",
  "15m": "15min",
  "1h": "1h",
  "4h": "4h"
};

const cache = new Map();
const inFlightRequests = new Map();

// Result of the boot-time credential check. "unchecked" until verifyTwelveDataCredentials() runs;
// only a definite rejection of the key ("rejected") takes the provider out of service.
let credentialHealth = { status: "unchecked", checkedAt: null, planLimitPerMinute: null, message: null };

export const twelveDataMarketDataProvider = {
  id: "twelve-data",
  category: "Commodities",
  isConfigured() {
    return Boolean(appConfig.twelveData.apiKey);
  },
  // Configured is not the same as working: a present-but-rejected key is reported here.
  getHealth() {
    return { ...credentialHealth };
  },
  // True once today's TWELVEDATA_REQUESTS_PER_DAY budget is spent; callers can skip work up front.
  isDailyLimitReached() {
    return isDailyLimitReached();
  },
  supports(symbol, timeframe) {
    return Boolean(resolveProviderSymbol(symbol)) &&
      Object.hasOwn(providerIntervals, timeframe);
  },
  getCachedCandles(symbol, timeframe) {
    const cached = cache.get(`${symbol}:${timeframe}`);

    if (!cached || Date.now() - cached.cachedAt >= appConfig.twelveData.cacheTtlMs) {
      return null;
    }

    return { ...cached.payload, cache: "hit" };
  },
  async getCandles(symbol, timeframe) {
    if (!this.isConfigured()) {
      throw new MarketDataProviderError(
        `${symbol} live commodity data is not configured. Set TWELVEDATA_API_KEY to enable it.`,
        { statusCode: 503, code: "PROVIDER_NOT_CONFIGURED" }
      );
    }

    if (!this.supports(symbol, timeframe)) {
      throw new MarketDataProviderError(`Twelve Data does not support ${symbol} on ${timeframe}.`, {
        statusCode: 400,
        code: "PROVIDER_UNSUPPORTED_MARKET"
      });
    }

    const cacheKey = `${symbol}:${timeframe}`;
    const cached = this.getCachedCandles(symbol, timeframe);

    if (cached) {
      return cached;
    }

    const inFlightRequest = inFlightRequests.get(cacheKey);

    if (inFlightRequest) {
      const payload = await inFlightRequest;
      return { ...payload, cache: "shared" };
    }

    const request = acquireRequestSlot().then(() => fetchCandles(this.id, symbol, timeframe, cacheKey));
    inFlightRequests.set(cacheKey, request);

    try {
      return await request;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  }
};

// ---------------------------------------------------------------- outgoing request throttle
// Twelve Data plans allow a fixed number of API credits per minute (free plan: 8). Requests beyond
// that fail, so they are queued FIFO and released at most `requestsPerMinute` per rolling window
// instead of being fired together. A queued request that cannot be sent within maxQueueWaitMs fails
// as RATE_LIMITED, so callers report it as a rate-limit miss rather than hanging.
const sentAt = [];
let pausedUntil = 0;
let queueTail = Promise.resolve();

// Daily budget (plans also cap credits per day; free plan: 800). Counted per UTC day, by requests
// actually sent. Once spent, requests fail immediately as DAILY_LIMIT_REACHED instead of queueing:
// waiting would not help until the day rolls over.
let daily = { day: utcDay(Date.now()), used: 0 };

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function rollDailyCounter(now = Date.now()) {
  const day = utcDay(now);
  if (daily.day !== day) daily = { day, used: 0 };
}

function isDailyLimitReached() {
  rollDailyCounter();
  return daily.used >= appConfig.twelveData.requestsPerDay;
}

function dailyLimitError() {
  return providerError(
    `Twelve Data daily request limit reached (${daily.used}/${appConfig.twelveData.requestsPerDay} today, resets 00:00 UTC).`,
    429,
    "DAILY_LIMIT_REACHED"
  );
}

function acquireRequestSlot() {
  const enqueuedAt = Date.now();
  const slot = queueTail.then(() => waitForCapacity(enqueuedAt));
  queueTail = slot.catch(() => {});
  return slot;
}

async function waitForCapacity(enqueuedAt) {
  const { requestsPerMinute, rateWindowMs, maxQueueWaitMs } = appConfig.twelveData;
  for (;;) {
    const now = Date.now();
    rollDailyCounter(now);
    if (daily.used >= appConfig.twelveData.requestsPerDay) throw dailyLimitError();
    while (sentAt.length && now - sentAt[0] >= rateWindowMs) sentAt.shift();
    let waitMs = 0;
    if (pausedUntil > now) waitMs = pausedUntil - now;
    else if (sentAt.length >= requestsPerMinute) waitMs = sentAt[0] + rateWindowMs - now;
    if (waitMs <= 0) {
      sentAt.push(now);
      daily.used += 1;
      return;
    }
    if (now + waitMs - enqueuedAt > maxQueueWaitMs) {
      throw providerError(
        `Twelve Data rate limit: request could not be sent within ${Math.round(maxQueueWaitMs / 1000)}s (limit ${requestsPerMinute} requests per ${Math.round(rateWindowMs / 1000)}s).`,
        429,
        "RATE_LIMITED"
      );
    }
    await sleep(waitMs);
  }
}

// The provider said the window's credits are gone (another process, or a limit set too high):
// hold the whole queue until the window has passed rather than burning more failed requests.
function pauseAfterRateLimit() {
  pausedUntil = Math.max(pausedUntil, Date.now() + appConfig.twelveData.rateWindowMs);
}

export function getTwelveDataThrottleState() {
  const now = Date.now();
  return {
    requestsPerMinute: appConfig.twelveData.requestsPerMinute,
    sentInWindow: sentAt.filter((at) => now - at < appConfig.twelveData.rateWindowMs).length,
    pausedUntil: pausedUntil > now ? new Date(pausedUntil).toISOString() : null,
    requestsPerDay: appConfig.twelveData.requestsPerDay,
    usedToday: (rollDailyCounter(now), daily.used),
    day: daily.day
  };
}

export function setTwelveDataDailyUsageForTest({ day = utcDay(Date.now()), used = 0 } = {}) {
  daily = { day, used };
}

export function resetTwelveDataStateForTest() {
  sentAt.length = 0;
  pausedUntil = 0;
  queueTail = Promise.resolve();
  daily = { day: utcDay(Date.now()), used: 0 };
  cache.clear();
  credentialHealth = { status: "unchecked", checkedAt: null, planLimitPerMinute: null, message: null };
}

// ---------------------------------------------------------------- boot-time credential check
// One cheap call (/api_usage) proving the key works, instead of trusting that it is non-empty.
export async function verifyTwelveDataCredentials() {
  if (!appConfig.twelveData.apiKey) {
    credentialHealth = { status: "not_configured", checkedAt: new Date().toISOString(), planLimitPerMinute: null, message: "TWELVEDATA_API_KEY is not set." };
    return { ...credentialHealth };
  }
  const url = new URL("/api_usage", appConfig.twelveData.baseUrl);
  url.searchParams.set("apikey", appConfig.twelveData.apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), appConfig.marketData.requestTimeoutMs);
  try {
    await acquireRequestSlot();
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    const body = await response.json().catch(() => ({}));
    const code = Number(body.code || (response.ok ? 0 : response.status));
    if (code === 401 || code === 403) {
      credentialHealth = { status: "rejected", checkedAt: new Date().toISOString(), planLimitPerMinute: null, message: "Twelve Data rejected the API key." };
    } else if (body.status === "error" || !response.ok) {
      // Rate limit, outage, etc.: says nothing about the key. Keep serving and let requests decide.
      credentialHealth = { status: "unverified", checkedAt: new Date().toISOString(), planLimitPerMinute: null, message: `Credential check inconclusive (${code || response.status}).` };
    } else {
      const planLimit = Number(body.plan_limit);
      // The provider's own count for today includes earlier processes and other consumers of the
      // key, so start from it rather than from zero after every restart.
      const providerDailyUsage = Number(body.daily_usage);
      if (Number.isFinite(providerDailyUsage) && providerDailyUsage > daily.used) daily.used = providerDailyUsage;
      const planDailyLimit = Number(body.plan_daily_limit);
      if (Number.isFinite(planDailyLimit) && planDailyLimit > 0 && planDailyLimit < appConfig.twelveData.requestsPerDay) {
        console.warn(`[twelve-data] TWELVEDATA_REQUESTS_PER_DAY=${appConfig.twelveData.requestsPerDay} exceeds the plan's daily limit ${planDailyLimit}; using ${planDailyLimit}`);
        appConfig.twelveData.requestsPerDay = planDailyLimit;
      }
      credentialHealth = {
        status: "ok",
        checkedAt: new Date().toISOString(),
        planLimitPerMinute: Number.isFinite(planLimit) && planLimit > 0 ? planLimit : null,
        message: null
      };
    }
  } catch (error) {
    credentialHealth = {
      status: "unverified",
      checkedAt: new Date().toISOString(),
      planLimitPerMinute: null,
      message: error.name === "AbortError" ? "Credential check timed out." : "Credential check could not reach Twelve Data."
    };
  } finally {
    clearTimeout(timeout);
  }
  return { ...credentialHealth };
}

// Boot entry point: verify the key and log what is actually true, not just that a key is set.
export async function runTwelveDataBootCheck(log = console) {
  const health = await verifyTwelveDataCredentials();
  const configured = appConfig.twelveData.requestsPerMinute;
  if (health.status === "ok" && health.planLimitPerMinute && health.planLimitPerMinute < configured) {
    log.warn(`[twelve-data] TWELVEDATA_REQUESTS_PER_MINUTE=${configured} exceeds the plan limit ${health.planLimitPerMinute}; throttling at ${health.planLimitPerMinute}`);
    appConfig.twelveData.requestsPerMinute = health.planLimitPerMinute;
  }
  const line = `[twelve-data] credentials=${health.status} plan_limit=${health.planLimitPerMinute ?? "unknown"} ` +
    `throttle_per_minute=${appConfig.twelveData.requestsPerMinute} daily=${getTwelveDataThrottleState().usedToday}/${appConfig.twelveData.requestsPerDay}${health.message ? ` detail="${health.message}"` : ""}`;
  if (health.status === "ok" || health.status === "not_configured") log.info(line);
  else log.warn(line);
  return health;
}

async function fetchCandles(providerId, symbol, timeframe, cacheKey) {
    const url = new URL("/time_series", appConfig.twelveData.baseUrl);
    url.searchParams.set("symbol", resolveProviderSymbol(symbol));
    url.searchParams.set("interval", providerIntervals[timeframe]);
    url.searchParams.set("outputsize", String(appConfig.marketData.candleLimit));
    // Datetimes default to the instrument's exchange timezone; ask for UTC explicitly so parsing
    // them as UTC below is true by construction rather than by assumption.
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("format", "JSON");
    url.searchParams.set("apikey", appConfig.twelveData.apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), appConfig.marketData.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json" }
      });

      if (response.status === 429) {
        pauseAfterRateLimit();
        throw providerError("Twelve Data rate limit reached.", 429, "RATE_LIMITED");
      }

      if (!response.ok) {
        throw providerError(`Twelve Data returned ${response.status}.`, response.status, "PROVIDER_RESPONSE_ERROR");
      }

      const body = await response.json();

      // Twelve Data reports most failures as HTTP 200 with {status: "error", code, message}.
      if (body.status === "error") {
        throw classifyBodyError(body, symbol, timeframe);
      }
      if (!Array.isArray(body.values)) {
        throw providerError(`Twelve Data returned no candles for ${symbol} on ${timeframe}.`, 502, "BAD_PROVIDER_RESPONSE");
      }

      const parsedCandles = body.values
        .map((value) => {
          const hasRawVolume = value.volume !== undefined &&
            value.volume !== null &&
            value.volume !== "";
          const volume = Number(value.volume);

          return {
          time: Math.floor(new Date(`${value.datetime}Z`).getTime() / 1000),
          open: Number(value.open),
          high: Number(value.high),
          low: Number(value.low),
          close: Number(value.close),
            volume: hasRawVolume && Number.isFinite(volume) && volume >= 0 ? volume : 0,
            volumeAvailable: hasRawVolume && Number.isFinite(volume) && volume >= 0
          };
        });
      const candles = parsedCandles
        .filter(isValidPriceCandle)
        .sort((a, b) => a.time - b.time);

      if (candles.length < 60) {
        throw providerError(
          `Twelve Data returned ${candles.length} usable ${symbol} ${timeframe} candles; at least 60 are required. Check symbol support and your Twelve Data plan.`,
          422,
          "INSUFFICIENT_OHLCV"
        );
      }

      const latest = candles[candles.length - 1];
      const previous = candles[Math.max(0, candles.length - 25)];
      const volumeAvailable = candles.every((candle) => candle.volumeAvailable);
      const payload = {
        symbol,
        timeframe,
        candles,
        volumeAvailable,
        latestPrice: latest.close,
        change24h: previous.close === 0 ? 0 : ((latest.close - previous.close) / previous.close) * 100,
        source: providerId,
        receivedAt: new Date().toISOString()
      };

      cache.set(cacheKey, { cachedAt: Date.now(), payload });
      return { ...payload, cache: "miss" };
    } catch (error) {
      if (error instanceof MarketDataProviderError) {
        throw error;
      }

      if (error.name === "AbortError") {
        throw providerError("Twelve Data request timed out.", 504, "MARKET_DATA_TIMEOUT");
      }

      throw providerError("Unable to reach Twelve Data.", 503, "PROVIDER_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
}

function classifyBodyError(body, symbol, timeframe) {
  const code = Number(body.code);
  const detail = String(body.message || "").slice(0, 200);
  if (code === 429) {
    pauseAfterRateLimit();
    return providerError(`Twelve Data rate limit reached: ${detail}`, 429, "RATE_LIMITED");
  }
  if (code === 401 || code === 403) {
    return providerError(`Twelve Data rejected the API key: ${detail}`, 503, "PROVIDER_AUTH_FAILED");
  }
  if (code >= 500) {
    return providerError(`Twelve Data is unavailable (${code}): ${detail}`, 503, "PROVIDER_UNAVAILABLE");
  }
  return providerError(
    detail || `Twelve Data does not support ${symbol} on ${timeframe}.`,
    400,
    "PROVIDER_UNSUPPORTED_MARKET"
  );
}

// The symbol string Twelve Data expects comes from markets.provider_symbol (e.g. WTI -> XTI/USD).
function resolveProviderSymbol(symbol) {
  const market = getNonCryptoMarket(symbol);
  return market?.provider === "twelve-data" ? market.providerSymbol : null;
}

function isValidPriceCandle(candle) {
  return Number.isFinite(candle.time) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close);
}

function providerError(message, statusCode, code) {
  return new MarketDataProviderError(message, { statusCode, code });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
