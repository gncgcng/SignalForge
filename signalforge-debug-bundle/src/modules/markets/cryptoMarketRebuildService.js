import { appConfig } from "../../config/appConfig.js";
import { query } from "../../db/client.js";
import { getCandlesFromCoinbase, getProductsFromCoinbase } from "../market-data/coinbaseMarketDataProvider.js";
import { cryptoTimeframes } from "./cryptoMarkets.js";
import { legacyCryptoReplacements, reloadCryptoMarketSettings } from "./cryptoMarketService.js";
import { runWithConcurrency } from "./cryptoMarketMonitor.js";

const stableOrFiatBases = new Set(["USD", "USDC", "USDT", "DAI", "EURC", "EUR", "GBP"]);
const candleTestOrder = ["1h", "15m"];

export async function rebuildActiveCryptoMarkets(options = {}) {
  const logger = options.logger || console;
  const products = await getProductsFromCoinbase();
  const productCatalog = normalizeCoinbaseProductCatalog(products);
  const tradableUsdProducts = [...productCatalog.values()].filter((product) => product.usdCrypto && product.tradingEnabled);
  const discoveredProviderSymbols = new Set([...productCatalog.keys()]);
  const existing = await loadExistingMarkets();
  const existingByProvider = new Map(existing.map((market) => [market.provider_symbol, market]));
  const summary = {
    ok: true,
    productsFound: Array.isArray(products) ? products.length : 0,
    usdCryptoProducts: tradableUsdProducts.length,
    active: 0,
    unavailable: 0,
    providerError: 0,
    legacy: 0,
    disabled: 0,
    disabledPreserved: 0,
    totalDiscovered: 0,
    unavailableExamples: [],
    results: []
  };

  logger.info?.(`[market-rebuild] started products=${summary.productsFound} usd_crypto=${summary.usdCryptoProducts}`);
  await ensureProductRows(tradableUsdProducts, existingByProvider);

  const results = await runWithConcurrency(
    tradableUsdProducts,
    appConfig.cryptoMarkets.verificationConcurrency,
    async (product, index) => {
      if (index > 0 && appConfig.cryptoMarkets.verificationDelayMs > 0) {
        await sleep(appConfig.cryptoMarkets.verificationDelayMs);
      }
      return rebuildProduct(product, existingByProvider.get(product.providerSymbol));
    }
  );

  for (const result of results) {
    summary.results.push(result);
    countResult(summary, result);
    if (result.status !== "active" && result.status !== "disabled" && summary.unavailableExamples.length < 20) {
      summary.unavailableExamples.push({
        providerSymbol: result.providerSymbol,
        productFound: result.productFound,
        candleTestResult: result.candleTestResult,
        reason: result.reason,
        status: result.status
      });
    }
  }

  const cleanup = await cleanRemovedLegacyAndPendingMarkets(discoveredProviderSymbols, productCatalog);
  summary.legacy += cleanup.legacy;
  summary.unavailable += cleanup.unavailable;
  summary.providerError += cleanup.providerError;
  summary.disabled += cleanup.disabled;
  summary.disabledPreserved += cleanup.disabled;
  summary.totalDiscovered = await countCryptoMarkets();

  logger.info?.(`[market-rebuild] complete active=${summary.active} unavailable=${summary.unavailable} provider_error=${summary.providerError} legacy=${summary.legacy} disabled=${summary.disabled} total=${summary.totalDiscovered}`);
  return summary;
}

export function normalizeCoinbaseProductCatalog(products = []) {
  const catalog = new Map();
  for (const raw of Array.isArray(products) ? products : []) {
    const providerSymbol = String(raw.id || raw.product_id || "").trim().toUpperCase();
    const baseAsset = String(raw.base_currency || raw.base || providerSymbol.split("-")[0] || "").trim().toUpperCase();
    const quoteAsset = String(raw.quote_currency || raw.quote || providerSymbol.split("-")[1] || "").trim().toUpperCase();
    const productStatus = String(raw.status || "online").trim().toLowerCase();
    const tradingEnabled = raw.trading_disabled !== true &&
      raw.cancel_only !== true &&
      raw.limit_only !== true &&
      raw.post_only !== true &&
      !["offline", "delisted", "disabled", "cancel_only", "limit_only", "post_only"].includes(productStatus);
    const usdCrypto = /^[A-Z0-9]{1,20}-USD$/.test(providerSymbol) &&
      quoteAsset === "USD" &&
      !stableOrFiatBases.has(baseAsset);
    if (!providerSymbol || !usdCrypto) continue;
    catalog.set(providerSymbol, {
      symbol: providerSymbol,
      displaySymbol: providerSymbol.replace("-", ""),
      providerSymbol,
      name: cleanProductName(raw.display_name || raw.base_name || raw.name || baseAsset, baseAsset),
      baseAsset,
      quoteAsset,
      productStatus,
      tradingEnabled,
      usdCrypto,
      liquidityTier: inferLiquidityTier(providerSymbol)
    });
  }
  return catalog;
}

async function ensureProductRows(products, existingByProvider) {
  for (const product of products) {
    await query(`INSERT INTO crypto_markets (
      symbol, display_symbol, provider_symbol, name, provider, liquidity_tier,
      enabled, scanner_enabled, paper_trading_enabled, watchlist_enabled,
      provider_status, base_asset, quote_asset, product_status, trading_enabled,
      market_status, verification_status, status
    ) VALUES ($1,$2,$3,$4,'coinbase-exchange',$5,true,false,false,false,'unavailable',$6,$7,$8,$9,'unavailable','failed','unavailable')
    ON CONFLICT (provider_symbol) DO UPDATE SET
      display_symbol=EXCLUDED.display_symbol,
      name=EXCLUDED.name,
      provider='coinbase-exchange',
      liquidity_tier=COALESCE(crypto_markets.liquidity_tier, EXCLUDED.liquidity_tier),
      base_asset=EXCLUDED.base_asset,
      quote_asset=EXCLUDED.quote_asset,
      product_status=EXCLUDED.product_status,
      trading_enabled=EXCLUDED.trading_enabled,
      updated_at=now()`, [
      product.symbol, product.displaySymbol, product.providerSymbol, product.name,
      product.liquidityTier, product.baseAsset, product.quoteAsset, product.productStatus,
      product.tradingEnabled
    ]);
    if (!existingByProvider.has(product.providerSymbol)) {
      existingByProvider.set(product.providerSymbol, { provider_symbol: product.providerSymbol, enabled: true });
    }
  }
}

async function rebuildProduct(product, existing = {}) {
  const adminDisabled = existing.enabled === false;
  if (adminDisabled) {
    await updateMarket(product, {
      status: "disabled",
      marketStatus: "disabled",
      verificationStatus: "failed",
      providerStatus: "unavailable",
      enabled: false,
      scannerEnabled: false,
      paperTradingEnabled: false,
      watchlistEnabled: false,
      supportedTimeframes: [],
      unsupportedTimeframes: [...candleTestOrder],
      lastSuccessfulCandleAt: null,
      lastError: "Disabled by admin.",
      failureCode: "ADMIN_DISABLED",
      verificationDetails: details(product, [], {
        productExists: true,
        productTradingEnabled: true,
        finalStatus: "disabled",
        lastError: "Disabled by admin."
      })
    });
    return result(product, "disabled", "disabled by admin", "not_checked", true);
  }

  const checks = [];
  for (const timeframe of candleTestOrder) {
    try {
      const data = await getCandlesFromCoinbase(product.providerSymbol, timeframe);
      const latestCandleAt = validateCandles(data.candles, timeframe);
      checks.push({ timeframe, available: true, candles: data.candles.length, lastCandleAt: latestCandleAt });
      await updateMarket(product, {
        status: "active",
        marketStatus: "active",
        verificationStatus: "verified",
        providerStatus: "available",
        enabled: true,
        scannerEnabled: shouldEnableCapability(existing, "scanner_enabled"),
        paperTradingEnabled: shouldEnableCapability(existing, "paper_trading_enabled"),
        watchlistEnabled: shouldEnableCapability(existing, "watchlist_enabled"),
        supportedTimeframes: [timeframe],
        unsupportedTimeframes: checks.filter((check) => !check.available).map((check) => check.timeframe),
        lastSuccessfulCandleAt: latestCandleAt,
        lastError: null,
        failureCode: null,
        resetFailures: true,
        verificationDetails: details(product, checks, {
          productExists: true,
          productTradingEnabled: true,
          finalStatus: "active",
          lastError: null
        })
      });
      return result(product, "active", `${timeframe} candles returned`, `${timeframe}:pass`, true);
    } catch (error) {
      checks.push({ timeframe, available: false, error: safeReason(error), code: error.code || "PROVIDER_ERROR" });
    }
  }

  const nextFailureCount = Number(existing.consecutive_failures || 0) + 1;
  const existingActive = existing.status === "active" || existing.market_status === "active";
  const recentSuccess = hasRecentSuccessfulCandle(existing);
  const previouslyUsable = existingActive ||
    recentSuccess ||
    (Array.isArray(existing.supported_timeframes) && existing.supported_timeframes.length > 0);
  const providerError = checks.some((check) => isProviderErrorCode(check.code));
  const keepActive = previouslyUsable;
  const status = keepActive ? "active" : providerError ? "provider_error" : "unavailable";
  const reason = checks.at(-1)?.error || "No candle data returned from provider.";
  const cooldownUntil = new Date(Date.now() + appConfig.cryptoMarkets.unavailableCooldownMs);
  await updateMarket(product, {
    status,
    marketStatus: status,
    verificationStatus: status === "active" ? "verified" : status === "provider_error" ? "error" : "failed",
    providerStatus: status === "active" ? "available" : status === "provider_error" ? "provider_issue" : "unavailable",
    enabled: true,
    scannerEnabled: keepActive ? shouldEnableCapability(existing, "scanner_enabled") : false,
    paperTradingEnabled: keepActive ? shouldEnableCapability(existing, "paper_trading_enabled") : false,
    watchlistEnabled: keepActive ? shouldEnableCapability(existing, "watchlist_enabled") : false,
    supportedTimeframes: keepActive ? existing.supported_timeframes || [] : [],
    unsupportedTimeframes: candleTestOrder,
    lastSuccessfulCandleAt: keepActive ? existing.last_successful_candle_at : null,
    lastError: keepActive ? null : reason,
    failureCode: checks.at(-1)?.code || (providerError ? "PROVIDER_ERROR" : "NO_CANDLES"),
    cooldownUntil,
    resetFailures: false,
    verificationDetails: details(product, checks, {
      productExists: true,
      productTradingEnabled: true,
      finalStatus: status,
      lastError: keepActive ? null : reason,
      providerWarning: keepActive ? `Temporary provider warning: ${reason}` : null,
      nextRetryTime: cooldownUntil.toISOString(),
      lastFailedCheck: {
        error: reason,
        code: checks.at(-1)?.code || (providerError ? "PROVIDER_ERROR" : "NO_CANDLES"),
        at: new Date().toISOString(),
        consecutiveFailures: nextFailureCount
      }
    })
  });
  return result(product, status, reason, checks.map((check) => `${check.timeframe}:${check.code || "fail"}`).join(","), true);
}

async function updateMarket(product, state) {
  const checkedAt = new Date();
  await query(`UPDATE crypto_markets SET
    display_symbol=$2, name=$3, provider='coinbase-exchange', liquidity_tier=$4,
    base_asset=$5, quote_asset=$6, product_status=$7, trading_enabled=$8,
    enabled=$9, scanner_enabled=$10, paper_trading_enabled=$11, watchlist_enabled=$12,
    provider_status=$13, supported_timeframes=$14, unsupported_timeframes=$15,
    last_successful_candle_at=$16, last_checked_at=$17, last_verified_at=$17,
    last_verification_attempt_at=$17, last_error=$18, failure_code=$19,
    cooldown_until=$24, consecutive_failures=CASE WHEN $25 THEN 0 ELSE consecutive_failures+1 END,
    market_status=$21, verification_status=$22, status=$20,
    verification_details=$23, updated_at=now()
    WHERE provider_symbol=$1`, [
    product.providerSymbol, product.displaySymbol, product.name, product.liquidityTier,
    product.baseAsset, product.quoteAsset, product.productStatus, product.tradingEnabled,
    state.enabled, state.scannerEnabled, state.paperTradingEnabled, state.watchlistEnabled,
    state.providerStatus, state.supportedTimeframes, state.unsupportedTimeframes,
    state.lastSuccessfulCandleAt, checkedAt, state.lastError, state.failureCode,
    state.status, state.marketStatus, state.verificationStatus, state.verificationDetails,
    state.cooldownUntil || null, state.resetFailures === true
  ]);
}

async function cleanRemovedLegacyAndPendingMarkets(discoveredProviderSymbols, productCatalog) {
  const checkedAt = new Date();
  const summary = { legacy: 0, unavailable: 0, providerError: 0, disabled: 0 };
  const inactiveProducts = [...productCatalog.values()].filter((product) => product.usdCrypto && !product.tradingEnabled);
  for (const product of inactiveProducts) {
    const inactive = await query(`UPDATE crypto_markets SET market_status='unavailable',
      verification_status='failed', status='unavailable', provider_status='unavailable',
      product_status=$2, trading_enabled=false, scanner_enabled=false, paper_trading_enabled=false,
      watchlist_enabled=false, last_error='Coinbase product is not trading-enabled.',
      failure_code='PRODUCT_TRADING_DISABLED', cooldown_until=NULL,
      last_checked_at=$3, last_verified_at=$3, last_verification_attempt_at=$3,
      verification_details=$4, updated_at=now()
      WHERE provider_symbol=$1 AND enabled=true AND status <> 'legacy'
      RETURNING symbol`, [
      product.providerSymbol,
      product.productStatus,
      checkedAt,
      details(product, [], {
        productExists: true,
        productTradingEnabled: false,
        finalStatus: "unavailable",
        lastError: "Coinbase product is not trading-enabled."
      })
    ]);
    summary.unavailable += inactive.rows.length;
  }

  for (const [legacySymbol, replacementSymbol] of Object.entries(legacyCryptoReplacements)) {
    const detailsJson = details({
      providerSymbol: legacySymbol,
      productStatus: productCatalog.get(legacySymbol)?.productStatus || "legacy",
      tradingEnabled: false
    }, [], {
      productExists: productCatalog.has(legacySymbol),
      productTradingEnabled: false,
      finalStatus: "legacy",
      lastError: `Legacy Coinbase symbol. Use ${replacementSymbol}.`
    });
    const legacy = await query(`UPDATE crypto_markets SET market_status='legacy', verification_status='legacy',
      status='legacy', provider_status='unavailable', enabled=false, scanner_enabled=false,
      paper_trading_enabled=false, watchlist_enabled=false, replacement_symbol=$2,
      last_error=$3, failure_code='LEGACY_MARKET', cooldown_until=NULL,
      last_checked_at=$4, last_verified_at=$4, last_verification_attempt_at=$4,
      verification_details=$5, updated_at=now()
      WHERE provider_symbol=$1 AND status <> 'legacy'
      RETURNING symbol`, [legacySymbol, replacementSymbol, `Legacy Coinbase symbol. Use ${replacementSymbol}.`, checkedAt, detailsJson]);
    summary.legacy += legacy.rows.length;
  }

  const unavailable = await query(`UPDATE crypto_markets SET market_status='unavailable',
    verification_status='failed', status='unavailable', provider_status='unavailable',
    scanner_enabled=false, paper_trading_enabled=false, watchlist_enabled=false,
    last_error=COALESCE(NULLIF(last_error, ''), 'Product not returned by Coinbase active-market rebuild.'),
    failure_code=COALESCE(NULLIF(failure_code, ''), 'PRODUCT_NOT_RETURNED'),
    cooldown_until=NULL, last_checked_at=$2, last_verified_at=$2,
    last_verification_attempt_at=$2, updated_at=now()
    WHERE provider='coinbase-exchange'
      AND enabled=true
      AND status NOT IN ('legacy', 'disabled')
      AND provider_symbol <> ALL($1::text[])
    RETURNING symbol`, [[...discoveredProviderSymbols], checkedAt]);
  summary.unavailable += unavailable.rows.length;

  const pendingCleanup = await query(`UPDATE crypto_markets SET market_status='unavailable',
    verification_status='failed', status='unavailable', provider_status='unavailable',
    scanner_enabled=false, paper_trading_enabled=false, watchlist_enabled=false,
    last_error=COALESCE(NULLIF(last_error, ''), 'Pending verification retired. Run market:rebuild-active for fresh provider checks.'),
    failure_code=COALESCE(NULLIF(failure_code, ''), 'PENDING_RETIRED'),
    cooldown_until=NULL, last_checked_at=$1, last_verified_at=$1,
    last_verification_attempt_at=$1, updated_at=now()
    WHERE provider='coinbase-exchange'
      AND enabled=true
      AND (status='pending' OR market_status='pending' OR verification_status='pending')
    RETURNING symbol`, [checkedAt]);
  summary.unavailable += pendingCleanup.rows.length;

  const disabled = await query(`UPDATE crypto_markets SET status='disabled', market_status='disabled',
    verification_status='failed', scanner_enabled=false, paper_trading_enabled=false,
    watchlist_enabled=false, updated_at=now()
    WHERE provider='coinbase-exchange'
      AND enabled=false
      AND status NOT IN ('legacy', 'disabled')
    RETURNING symbol`);
  summary.disabled += disabled.rows.length;

  await reloadCryptoMarketSettings();
  return summary;
}

async function loadExistingMarkets() {
  const result = await query(`SELECT symbol, provider_symbol, enabled, scanner_enabled,
    paper_trading_enabled, watchlist_enabled, status, market_status,
    supported_timeframes, last_successful_candle_at, consecutive_failures
    FROM crypto_markets WHERE provider='coinbase-exchange'`);
  return result.rows;
}

function shouldEnableCapability(existing = {}, key) {
  const wasActive = existing.status === "active" || existing.market_status === "active";
  if (wasActive && existing[key] === false) return false;
  return true;
}

async function countCryptoMarkets() {
  const result = await query("SELECT count(*)::int AS count FROM crypto_markets WHERE provider='coinbase-exchange'");
  return Number(result.rows[0]?.count || 0);
}

function validateCandles(candles, timeframe) {
  if (!Array.isArray(candles) || candles.length === 0) throw error("No candle data returned from provider.", "EMPTY_CANDLES");
  if (candles.length < 60) throw error("Insufficient candle data returned from provider.", "INSUFFICIENT_CANDLES");
  const latest = candles[candles.length - 1];
  const latestMs = Number(latest?.time) * 1000;
  const expectedMs = ({ "15m": 900000, "1h": 3600000 })[timeframe] || 3600000;
  if (!Number.isFinite(latestMs) || Date.now() - latestMs > expectedMs * 2.5) {
    throw error("Latest candle is stale.", "STALE_CANDLES");
  }
  return new Date(latestMs).toISOString();
}

function details(product, checks, extra) {
  const byTimeframe = Object.fromEntries(cryptoTimeframes.map((timeframe) => {
    const check = checks.find((item) => item.timeframe === timeframe);
    return [timeframe, check ? {
      pass: Boolean(check.available),
      candles: Number(check.candles || 0),
      latestCandleAt: check.lastCandleAt || null,
      error: check.error || null,
      code: check.code || null
    } : {
      pass: false,
      candles: 0,
      latestCandleAt: null,
      error: candleTestOrder.includes(timeframe) ? "Not checked yet." : "Not checked by active-market rebuild.",
      code: "NOT_CHECKED"
    }];
  }));
  const now = new Date().toISOString();
  return {
    provider: "Coinbase",
    providerSymbol: product.providerSymbol,
    productExists: extra.productExists,
    productTradingEnabled: extra.productTradingEnabled,
    productStatus: product.productStatus || null,
    candleChecks: byTimeframe,
    latestCandleTime: checks.map((check) => check.lastCandleAt).filter(Boolean).sort().at(-1) || null,
    lastVerifiedAt: now,
    lastVerificationAttempt: now,
    lastError: extra.lastError || null,
    warning: extra.providerWarning || null,
    providerWarning: extra.providerWarning || null,
    lastFailedCheck: extra.lastFailedCheck || null,
    nextRetryTime: extra.nextRetryTime || null,
    finalStatus: extra.finalStatus
  };
}

function result(product, status, reason, candleTestResult, productFound) {
  return {
    providerSymbol: product.providerSymbol,
    displaySymbol: product.displaySymbol,
    status,
    reason,
    candleTestResult,
    productFound
  };
}

function countResult(summary, item) {
  if (item.status === "active") summary.active += 1;
  else if (item.status === "provider_error") summary.providerError += 1;
  else if (item.status === "legacy") summary.legacy += 1;
  else if (item.status === "disabled") {
    summary.disabled += 1;
    summary.disabledPreserved += 1;
  } else summary.unavailable += 1;
}

function inferLiquidityTier(symbol) {
  const major = new Set(["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "ADA-USD", "DOGE-USD", "LINK-USD", "AVAX-USD", "LTC-USD", "BCH-USD", "DOT-USD", "UNI-USD", "AAVE-USD", "ATOM-USD", "ETC-USD", "NEAR-USD", "OP-USD", "ARB-USD", "INJ-USD", "ICP-USD"]);
  const highVolatility = new Set(["SHIB-USD", "PEPE-USD", "BONK-USD", "WIF-USD", "FLOKI-USD"]);
  if (major.has(symbol)) return "major";
  if (highVolatility.has(symbol)) return "high-volatility";
  return "standard";
}

function cleanProductName(value, fallback) {
  return String(value || fallback).replace(/\s*[/|-]\s*USD$/i, "").trim() || fallback;
}

function safeReason(value) {
  return String(value?.message || value || "Provider check failed.").replace(/[\r\n]+/g, " ").slice(0, 240);
}

function isProviderErrorCode(code) {
  return ["PROVIDER_UNAVAILABLE", "PROVIDER_RESPONSE_ERROR", "MARKET_DATA_TIMEOUT", "RATE_LIMITED", "BAD_PROVIDER_RESPONSE"].includes(code);
}

function hasRecentSuccessfulCandle(existing = {}, windowMs = 24 * 60 * 60 * 1000) {
  if (!existing.last_successful_candle_at) return false;
  const age = Date.now() - new Date(existing.last_successful_candle_at).getTime();
  return Number.isFinite(age) && age >= 0 && age <= windowMs;
}

function isRateLimitCode(code) {
  return String(code || "").toUpperCase() === "RATE_LIMITED";
}

function error(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
