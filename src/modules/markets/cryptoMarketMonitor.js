import { appConfig } from "../../config/appConfig.js";
import { getCandlesFromCoinbase, getProductFromCoinbase } from "../market-data/coinbaseMarketDataProvider.js";
import { cryptoTimeframes } from "./cryptoMarkets.js";
import {
  getCryptoMarketState,
  legacyCryptoReplacements,
  listCryptoMarketSettings,
  reloadCryptoMarketSettings,
  replaceLegacyCryptoMarket,
  resetCryptoMarketCooldown,
  saveCryptoMarketVerification
} from "./cryptoMarketService.js";

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
    if (!markets.length) return emptySummary();
    if (markets.length) console.info(`[market-verify] started pending=${markets.length}`);
    const results = await runWithConcurrency(markets, appConfig.cryptoMarkets.verificationConcurrency, (market) => verifyCryptoMarket(market.symbol));
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
  const replacement = legacyCryptoReplacements[before.symbol] || legacyCryptoReplacements[before.providerSymbol];
  if (replacement && !options.allowLegacy) {
    try {
      const market = await replaceLegacyCryptoMarket(before.symbol, replacement);
      return { symbol: market.symbol, available: false, checked: [], product: { productExists: false, productTradingEnabled: false, productStatus: "legacy", error: `Legacy Coinbase symbol. Use ${replacement}.`, code: "LEGACY_MARKET" }, market };
    } catch {
      return { symbol: before.symbol, available: false, checked: [], product: { productExists: false, productTradingEnabled: false, productStatus: "legacy", error: `Legacy Coinbase symbol. Use ${replacement}.`, code: "LEGACY_MARKET" }, market: before };
    }
  }
  if (before.marketStatus === "legacy" && !options.allowLegacy) {
    return { symbol: before.symbol, available: false, checked: [], market: before };
  }
  if (options.force) await resetCryptoMarketCooldown(before.symbol);
  const checked = [];
  const product = await withRetries(() => withTimeout(
    verifyCoinbaseProduct(before.providerSymbol),
    appConfig.cryptoMarkets.verificationTimeoutMs,
    "MARKET_DATA_TIMEOUT"
  ), appConfig.cryptoMarkets.verificationRetries);
  if (!product.exists || product.providerError || product.productTradingEnabled === false) {
    const code = product.code || "PROVIDER_UNSUPPORTED_MARKET";
    const error = product.error || "Product not found on Coinbase.";
    for (const timeframe of cryptoTimeframes) {
      checked.push({ timeframe, available: false, error, code });
    }
    const market = await saveCryptoMarketVerification(before.symbol, checked, product);
    return { symbol: market.symbol, available: false, checked, product, market };
  }

  for (const timeframe of verificationTimeframes()) {
    try {
      const data = await withRetries(() => withTimeout(
        getCandlesFromCoinbase(before.providerSymbol, timeframe),
        appConfig.cryptoMarkets.verificationTimeoutMs,
        "MARKET_DATA_TIMEOUT"
      ), appConfig.cryptoMarkets.verificationRetries);
      const latestCandleAt = validateCandles(data.candles, timeframe);
      checked.push({ timeframe, available: true, candles: data.candles.length, lastCandleAt: latestCandleAt });
    } catch (error) {
      checked.push({ timeframe, available: false, error: safeProviderError(error), code: error.code || "PROVIDER_ERROR" });
    }
  }
  const market = await saveCryptoMarketVerification(before.symbol, checked, product);
  return { symbol: market.symbol, available: market.marketStatus === "active", checked, product, market };
}

export async function verifyPendingCryptoMarkets(options = {}) {
  const logger = options.logger || console;
  await reloadCryptoMarketSettings();
  const targets = selectVerificationTargets(listCryptoMarketSettings(), options);
  const before = summarizeMarkets(listCryptoMarketSettings());
  const summary = createVerificationSummary(targets.length, before);
  logger.info?.(`[market-verify] start pending=${before.pending}`);

  const results = [];
  await runWithConcurrency(targets, appConfig.cryptoMarkets.verificationConcurrency, async (market, index) => {
    if (index > 0 && appConfig.cryptoMarkets.verificationDelayMs > 0) {
      await sleep(appConfig.cryptoMarkets.verificationDelayMs);
    }
    logger.info?.(`[market-verify] checking symbol=${market.providerSymbol}`);
    try {
      const result = await verifyCryptoMarket(market.symbol, { force: true });
      results.push(result);
      addVerificationResult(summary, result.market);
      const status = terminalStatusLabel(result.market.marketStatus);
      const reason = result.market.lastError ? ` reason=${safeLogValue(result.market.lastError)}` : "";
      logger.info?.(`[market-verify] result symbol=${result.market.providerSymbol || result.market.symbol} status=${status}${reason}`);
    } catch (error) {
      const result = await resolveVerificationException(market, error, options);
      results.push(result);
      addVerificationResult(summary, result.market);
      logger.warn?.(`[market-verify] result symbol=${market.providerSymbol} status=provider_error reason=${safeLogValue(result.market.lastError || error.message)}`);
    }
  });

  await reloadCryptoMarketSettings();
  const after = summarizeMarkets(listCryptoMarketSettings());
  summary.before = before;
  summary.after = after;
  summary.changed = diffSummaries(before, after);
  summary.stillPending = after.pending;
  summary.remainingPending = listCryptoMarketSettings().filter(isPendingVerificationMarket).slice(0, 50).map(pendingMarketReport);
  logger.info?.(`[market-verify] complete checked=${summary.checked} ready=${summary.ready} unavailable=${summary.unavailable} provider_error=${summary.providerError} legacy=${summary.legacy} still_pending=${summary.stillPending}`);
  return { ok: true, ...summary, active: summary.ready, results };
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
    legacy: 0,
    stillPending: 0,
    currentSymbol: null,
    lastResult: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null
  };
  console.info(`[market-verify] started pending=${pending.length}`);
  void runPendingVerificationJob(pending);
  return { ...verificationJob };
}

export function getPendingCryptoVerificationJob() {
  return { ...verificationJob };
}

async function runPendingVerificationJob(markets) {
  try {
    await runWithConcurrency(markets, appConfig.cryptoMarkets.verificationConcurrency, async (market, index) => {
      try {
        if (index > 0 && appConfig.cryptoMarkets.verificationDelayMs > 0) await sleep(appConfig.cryptoMarkets.verificationDelayMs);
        verificationJob.currentSymbol = market.symbol;
        const result = await verifyCryptoMarket(market.symbol, { force: true });
        if (result.market.marketStatus === "active") verificationJob.active += 1;
        else if (result.market.marketStatus === "provider_error") verificationJob.providerError += 1;
        else if (result.market.marketStatus === "legacy") verificationJob.legacy += 1;
        else if (result.market.marketStatus === "pending") verificationJob.stillPending += 1;
        else verificationJob.unavailable += 1;
        verificationJob.lastResult = {
          symbol: result.market.symbol,
          status: result.market.marketStatus,
          error: result.market.lastError || null
        };
      } catch (error) {
        verificationJob.providerError += 1;
        verificationJob.error = safeProviderError(error);
        verificationJob.lastResult = { symbol: market.symbol, status: "provider_error", error: verificationJob.error };
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
      legacy: verificationJob.legacy,
      stillPending: verificationJob.stillPending
    });
  }
}

export async function testCoinbaseProviderDiagnostics() {
  const symbols = ["BTC-USD", "ETH-USD", "SOL-USD", "SEI-USD", "PEPE-USD", "AUDIO-USD", "AAVE-USD", "MATIC-USD", "POL-USD"];
  const results = await runWithConcurrency(symbols, appConfig.cryptoMarkets.verificationConcurrency, async (symbol, index) => {
    if (index > 0 && appConfig.cryptoMarkets.verificationDelayMs > 0) await sleep(appConfig.cryptoMarkets.verificationDelayMs);
    const product = await verifyCoinbaseProduct(symbol);
    const checks = [];
    if (product.exists && !product.providerError && product.productTradingEnabled !== false) {
      for (const timeframe of verificationTimeframes()) {
        try {
          const data = await getCandlesFromCoinbase(symbol, timeframe);
          checks.push({ timeframe, available: true, candles: data.candles.length, lastCandleAt: validateCandles(data.candles, timeframe) });
        } catch (error) {
          checks.push({ timeframe, available: false, error: safeProviderError(error), code: error.code || "PROVIDER_ERROR" });
        }
      }
    }
    const finalStatus = !product.exists || product.productTradingEnabled === false ? "unavailable"
      : product.providerError ? "provider_error"
        : checks.filter((check) => check.available).length >= Math.min(3, cryptoTimeframes.length) ? "active"
          : checks.some((check) => isProviderErrorCode(check.code)) ? "provider_error" : "unavailable";
    return { symbol, product, checks, finalStatus, latestCandleTime: checks.map((check) => check.lastCandleAt).filter(Boolean).sort().at(-1) || null };
  });
  return { testedAt: new Date().toISOString(), results };
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
    legacy: results.filter((result) => result?.market?.marketStatus === "legacy").length,
    stillPending: results.filter((result) => result?.market?.marketStatus === "pending").length
  };
}
function selectVerificationTargets(markets, options = {}) {
  let targets = markets.filter((market) => {
    if (options.symbol) return matchesSymbol(market, options.symbol);
    if (isPendingVerificationMarket(market)) return true;
    return Boolean(options.includeErrors) && market.status === "provider_error";
  });
  const limit = Number(options.limit || 0);
  if (Number.isFinite(limit) && limit > 0) targets = targets.slice(0, limit);
  return targets;
}
function isPendingVerificationMarket(market) {
  const values = [market.status, market.marketStatus, market.verificationStatus, market.statusLabel]
    .map((value) => String(value || "").trim().toLowerCase());
  return market.enabled !== false && values.some((value) =>
    ["pending", "pending verification", "unverified", "unknown"].includes(value)
  );
}
function summarizeMarkets(markets) {
  return {
    total: markets.length,
    ready: markets.filter((market) => market.status === "ready").length,
    pending: markets.filter((market) => market.status === "pending" || isPendingVerificationMarket(market)).length,
    unavailable: markets.filter((market) => market.status === "unavailable").length,
    providerError: markets.filter((market) => market.status === "provider_error").length,
    legacy: markets.filter((market) => market.status === "legacy").length,
    disabled: markets.filter((market) => market.status === "disabled" || market.enabled === false && market.status !== "legacy").length,
    scannerEnabled: markets.filter((market) => market.effectiveScannerEnabled).length,
    paperTradingEnabled: markets.filter((market) => market.effectivePaperTradingEnabled).length
  };
}
function createVerificationSummary(total, before = {}) {
  return { pending: total, checked: 0, ready: 0, unavailable: 0, providerError: 0, legacy: 0, disabled: 0, stillPending: before.pending || total, before, after: null, changed: null, remainingPending: [] };
}
function addVerificationResult(summary, market) {
  summary.checked += 1;
  if (market.status === "ready") summary.ready += 1;
  else if (market.status === "provider_error") summary.providerError += 1;
  else if (market.status === "legacy") summary.legacy += 1;
  else if (market.status === "disabled") summary.disabled += 1;
  else summary.unavailable += 1;
}
function terminalStatusLabel(status) {
  return ({ active: "ready", ready: "ready", provider_error: "provider_error", unavailable: "unavailable", legacy: "legacy", disabled: "disabled" })[status] || "unavailable";
}
async function resolveVerificationException(market, error, options = {}) {
  const checks = verificationTimeframes().map((timeframe) => ({
    timeframe,
    available: false,
    error: options.forceResolvePending ? "Verification incomplete after retries." : safeProviderError(error),
    code: error.code || "PROVIDER_UNAVAILABLE"
  }));
  const resolved = await saveCryptoMarketVerification(market.symbol, checks, {
    productExists: null,
    productTradingEnabled: null,
    productStatus: "unknown",
    error: safeProviderError(error),
    code: error.code || "PROVIDER_UNAVAILABLE"
  });
  return { symbol: resolved.symbol, available: false, checked: checks, product: null, market: resolved };
}
function verificationTimeframes() {
  return ["15m", "1h", "4h", "5m"];
}
function diffSummaries(before, after) {
  return Object.fromEntries(["ready", "pending", "unavailable", "providerError", "legacy", "disabled"].map((key) => [
    key,
    Number(after[key] || 0) - Number(before[key] || 0)
  ]));
}
function pendingMarketReport(market) {
  return {
    displaySymbol: market.displaySymbol,
    providerSymbol: market.providerSymbol,
    status: market.status,
    marketStatus: market.marketStatus,
    verificationStatus: market.verificationStatus,
    lastVerifiedAt: market.lastVerifiedAt,
    lastVerificationAttemptAt: market.lastVerificationAttemptAt,
    lastError: market.lastError
  };
}
function matchesSymbol(market, symbol) {
  const normalized = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return [market.symbol, market.providerSymbol, market.displaySymbol].some((value) =>
    String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === normalized
  );
}
async function withRetries(operation, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(250 * (attempt + 1));
    }
  }
  throw lastError;
}
function withTimeout(promise, timeoutMs, code) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error("Verification timed out.");
      error.code = code;
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function safeLogValue(value) {
  return String(value || "unknown").replace(/[\r\n]+/g, " ").slice(0, 180);
}
async function verifyCoinbaseProduct(providerSymbol) {
  try {
    const product = await getProductFromCoinbase(providerSymbol);
    const status = String(product.status || "online").toLowerCase();
    const productTradingEnabled = product.trading_disabled !== true && !["offline", "delisted", "disabled"].includes(status);
    if (!productTradingEnabled) {
      return {
        productExists: true,
        exists: true,
        productTradingEnabled: false,
        productStatus: status,
        error: "Coinbase product is not trading-enabled.",
        code: "PRODUCT_TRADING_DISABLED"
      };
    }
    return {
      productExists: true,
      exists: true,
      productTradingEnabled: true,
      productStatus: status
    };
  } catch (error) {
    const code = error.code || "PROVIDER_ERROR";
    return {
      productExists: isProviderErrorCode(code) ? null : false,
      exists: false,
      providerError: isProviderErrorCode(code),
      productTradingEnabled: null,
      productStatus: null,
      error: safeProviderError(error),
      code
    };
  }
}

function emptySummary() { return { pending: 0, checked: 0, active: 0, unavailable: 0, providerError: 0, legacy: 0, stillPending: 0 }; }
function idleJob() { return { id: null, running: false, total: 0, completed: 0, active: 0, unavailable: 0, providerError: 0, legacy: 0, stillPending: 0, currentSymbol: null, lastResult: null, startedAt: null, finishedAt: null, error: null }; }
function logSummary(summary) { console.info(`[market-verify] complete ready=${summary.active} unavailable=${summary.unavailable} provider_error=${summary.providerError} legacy=${summary.legacy} still_pending=${summary.stillPending || 0}`); }
function logVerificationFailure(error) { console.warn(`[market-verify] failed reason=${safeProviderError(error)}`); }
function safeProviderError(error) { return String(error?.message || "Provider verification failed.").replace(/[\r\n]+/g, " ").slice(0, 240); }
function verificationError(message, code) { const error = new Error(message); error.code = code; return error; }
function marketError(message, statusCode) { const error = new Error(message); error.statusCode = statusCode; return error; }
function isProviderErrorCode(code) { return ["PROVIDER_UNAVAILABLE", "PROVIDER_RESPONSE_ERROR", "MARKET_DATA_TIMEOUT", "RATE_LIMITED", "BAD_PROVIDER_RESPONSE"].includes(code); }
