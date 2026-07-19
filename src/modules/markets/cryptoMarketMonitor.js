import { appConfig } from "../../config/appConfig.js";
import { getCandlesFromCoinbase } from "../market-data/coinbaseMarketDataProvider.js";
import { cryptoTimeframes } from "./cryptoMarkets.js";
import { getCryptoMarketState, listCryptoMarketSettings, resetCryptoMarketCooldown, saveCryptoMarketVerification } from "./cryptoMarketService.js";

let monitorTimer = null;
let monitorRunning = false;
let verificationJob = idleJob();

export function startCryptoMarketAvailabilityMonitor() {
  if (monitorTimer) return;
  if (!appConfig.cryptoMarkets.verificationEnabled) {
    console.info("[market-verify] disabled by MARKET_VERIFICATION_ENABLED=false");
    return;
  }
  const intervalMs = appConfig.cryptoMarkets.verificationIntervalMs;
  setTimeout(() => verifyNextCryptoMarkets().catch(logVerificationFailure), 3000);
  monitorTimer = setInterval(() => verifyNextCryptoMarkets().catch(logVerificationFailure), intervalMs);
}

export async function verifyNextCryptoMarkets() {
  if (monitorRunning || verificationJob.running) return emptySummary();
  monitorRunning = true;
  try {
    const markets = listCryptoMarketSettings()
      .filter((market) => market.enabled && (
        market.verificationStatus === "pending" ||
        market.marketStatus === "provider_error" && (!market.cooldownUntil || new Date(market.cooldownUntil).getTime() <= Date.now())
      ))
      .slice(0, appConfig.cryptoMarkets.verificationPairsPerCycle);
    const results = await runWithConcurrency(markets, appConfig.cryptoMarkets.maxConcurrentRequests, (market) => verifyCryptoMarket(market.symbol));
    const summary = summarizeVerification(results, markets.length);
    logSummary(summary);
    return summary;
  } finally {
    monitorRunning = false;
  }
}

export async function verifyCryptoMarket(symbol, options = {}) {
  const before = getCryptoMarketState(symbol);
  if (!before) throw marketError("Unknown crypto market.", 404);
  if (before.marketStatus === "legacy" && !options.allowLegacy) {
    return { symbol: before.symbol, available: false, checked: [], market: before };
  }
  if (options.force) await resetCryptoMarketCooldown(before.symbol);
  const checked = [];
  for (const timeframe of cryptoTimeframes) {
    try {
      const data = await getCandlesFromCoinbase(before.providerSymbol, timeframe);
      const latestCandleAt = validateCandles(data.candles, timeframe);
      checked.push({ timeframe, available: true, candles: data.candles.length, lastCandleAt: latestCandleAt });
    } catch (error) {
      checked.push({ timeframe, available: false, error: safeProviderError(error), code: error.code || "PROVIDER_ERROR" });
    }
  }
  const market = await saveCryptoMarketVerification(before.symbol, checked);
  return { symbol: market.symbol, available: market.marketStatus === "active", checked, market };
}

export function startPendingCryptoVerification() {
  if (verificationJob.running) return { ...verificationJob };
  const pending = listCryptoMarketSettings().filter((market) => market.enabled && market.verificationStatus === "pending");
  verificationJob = {
    id: `verify_${Date.now()}`,
    running: true,
    total: pending.length,
    completed: 0,
    active: 0,
    unavailable: 0,
    providerError: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null
  };
  void runPendingVerificationJob(pending);
  return { ...verificationJob };
}

export function getPendingCryptoVerificationJob() {
  return { ...verificationJob };
}

async function runPendingVerificationJob(markets) {
  try {
    await runWithConcurrency(markets, appConfig.cryptoMarkets.maxConcurrentRequests, async (market) => {
      try {
        const result = await verifyCryptoMarket(market.symbol, { force: true });
        if (result.market.marketStatus === "active") verificationJob.active += 1;
        else if (result.market.marketStatus === "provider_error") verificationJob.providerError += 1;
        else verificationJob.unavailable += 1;
      } catch (error) {
        verificationJob.providerError += 1;
        verificationJob.error = safeProviderError(error);
      } finally {
        verificationJob.completed += 1;
      }
    });
  } finally {
    verificationJob.running = false;
    verificationJob.finishedAt = new Date().toISOString();
    logSummary({
      pending: markets.length,
      checked: verificationJob.completed,
      active: verificationJob.active,
      unavailable: verificationJob.unavailable,
      providerError: verificationJob.providerError,
      legacy: listCryptoMarketSettings().filter((market) => market.marketStatus === "legacy").length
    });
  }
}

export async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function validateCandles(candles, timeframe) {
  if (!Array.isArray(candles) || candles.length === 0) throw verificationError("No candle data returned from provider.", "EMPTY_CANDLES");
  if (candles.length < 60) throw verificationError("Insufficient candle data returned from provider.", "INSUFFICIENT_CANDLES");
  const latest = candles[candles.length - 1];
  const latestMs = Number(latest?.time) * 1000;
  const expectedMs = ({ "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 })[timeframe];
  if (!Number.isFinite(latestMs) || Date.now() - latestMs > expectedMs * 2.5) throw verificationError("Latest candle is stale.", "STALE_CANDLES");
  return new Date(latestMs).toISOString();
}

function summarizeVerification(results, pending) {
  return {
    pending,
    checked: results.length,
    active: results.filter((result) => result?.market?.marketStatus === "active").length,
    unavailable: results.filter((result) => result?.market?.marketStatus === "unavailable").length,
    providerError: results.filter((result) => result?.market?.marketStatus === "provider_error").length,
    legacy: listCryptoMarketSettings().filter((market) => market.marketStatus === "legacy").length
  };
}
function emptySummary() { return { pending: 0, checked: 0, active: 0, unavailable: 0, providerError: 0, legacy: 0 }; }
function idleJob() { return { id: null, running: false, total: 0, completed: 0, active: 0, unavailable: 0, providerError: 0, startedAt: null, finishedAt: null, error: null }; }
function logSummary(summary) { console.info(`[market-verify] pending=${summary.pending} active=${summary.active} unavailable=${summary.unavailable} provider_error=${summary.providerError} legacy=${summary.legacy}`); }
function logVerificationFailure(error) { console.warn(`[market-verify] failed reason=${safeProviderError(error)}`); }
function safeProviderError(error) { return String(error?.message || "Provider verification failed.").replace(/[\r\n]+/g, " ").slice(0, 240); }
function verificationError(message, code) { const error = new Error(message); error.code = code; return error; }
function marketError(message, statusCode) { const error = new Error(message); error.statusCode = statusCode; return error; }
