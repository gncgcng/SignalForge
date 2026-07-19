import { appConfig } from "../../config/appConfig.js";
import { query } from "../../db/client.js";
import { cryptoMarketUniverse, cryptoTimeframes, findCryptoMarket } from "./cryptoMarkets.js";

const establishedSymbols = new Set([
  "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "ADA-USD", "DOGE-USD",
  "LINK-USD", "AVAX-USD", "LTC-USD"
]);
export const legacyCryptoReplacements = Object.freeze({
  "MATIC-USD": "POL-USD",
  "RNDR-USD": "RENDER-USD"
});
const stableOrFiatBases = new Set(["USD", "USDC", "USDT", "DAI", "EURC", "EUR", "GBP"]);
const runtime = new Map(cryptoMarketUniverse.map((market) => [market.symbol, defaultState(market)]));
const loggedFailures = new Map();

export async function initializeCryptoMarketSettings() {
  for (const market of cryptoMarketUniverse) {
    const state = defaultState(market);
    await query(`INSERT INTO crypto_markets (
      symbol, display_symbol, provider_symbol, name, provider, liquidity_tier,
      enabled, scanner_enabled, paper_trading_enabled, watchlist_enabled,
      provider_status, supported_timeframes, base_asset, quote_asset, product_status,
      trading_enabled, market_status, verification_status, replacement_symbol
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    ON CONFLICT (symbol) DO UPDATE SET
      display_symbol = EXCLUDED.display_symbol,
      provider_symbol = EXCLUDED.provider_symbol,
      name = EXCLUDED.name,
      provider = EXCLUDED.provider,
      liquidity_tier = EXCLUDED.liquidity_tier,
      base_asset = COALESCE(crypto_markets.base_asset, EXCLUDED.base_asset),
      quote_asset = COALESCE(crypto_markets.quote_asset, EXCLUDED.quote_asset),
      updated_at = now()`, [
      state.symbol, state.displaySymbol, state.providerSymbol, state.name,
      state.provider, state.liquidityTier, state.enabled, state.scannerEnabled,
      state.paperTradingEnabled, state.watchlistEnabled, state.providerStatus,
      state.supportedTimeframes, state.baseAsset, state.quoteAsset, "legacy_seed",
      true, state.marketStatus, state.verificationStatus, state.replacementSymbol
    ]);
  }
  await reloadCryptoMarketSettings();
  console.info(`[crypto-markets] loaded=${runtime.size} scanner_ready=${listScannerCryptoMarkets().length}`);
  return listCryptoMarketSettings();
}

export async function reloadCryptoMarketSettings() {
  const result = await query("SELECT * FROM crypto_markets ORDER BY liquidity_tier, symbol");
  runtime.clear();
  for (const row of result.rows) runtime.set(row.symbol, mapRow(row));
  return listCryptoMarketSettings();
}

export function getCryptoMarketState(symbol) {
  const normalized = normalizeSymbol(symbol);
  const market = [...runtime.values()].find((item) =>
    [item.symbol, item.providerSymbol, item.displaySymbol].some((value) => normalizeSymbol(value) === normalized)
  ) || (findCryptoMarket(symbol) ? defaultState(findCryptoMarket(symbol)) : null);
  if (!market) return null;
  return { ...market, ...effectiveFlags(market) };
}

export function listCryptoMarketSettings() {
  return [...runtime.values()]
    .map((market) => ({ ...market, ...effectiveFlags(market) }))
    .sort((a, b) => tierOrder(a.liquidityTier) - tierOrder(b.liquidityTier) || a.symbol.localeCompare(b.symbol));
}

export function listScannerCryptoMarkets() {
  return listCryptoMarketSettings()
    .filter((market) => market.marketStatus === "active" && market.enabled && market.scannerEnabled && !isCoolingDown(market))
    .slice(0, appConfig.cryptoMarkets.maxActiveScannerPairs);
}

export function listPaperCryptoMarkets() {
  return listCryptoMarketSettings().filter((market) =>
    market.marketStatus === "active" && market.enabled && market.paperTradingEnabled && !isCoolingDown(market)
  );
}

export function listWatchlistCryptoMarkets() {
  return listCryptoMarketSettings().filter((market) =>
    market.marketStatus === "active" && market.enabled && market.watchlistEnabled && !isCoolingDown(market)
  );
}

export function canUseCryptoTimeframe(symbol, timeframe, capability = "market") {
  const market = getCryptoMarketState(symbol);
  if (!market || market.marketStatus !== "active" || !market.enabled || isCoolingDown(market)) return false;
  if (capability === "scanner" && !market.scannerEnabled) return false;
  if (capability === "paper" && !market.paperTradingEnabled) return false;
  if (capability === "watchlist" && !market.watchlistEnabled) return false;
  return market.supportedTimeframes.includes(timeframe);
}

export async function updateCryptoMarketSettings(symbol, changes) {
  const current = getCryptoMarketState(symbol);
  if (!current) throw marketError("Unknown crypto market.", 404);
  const enabled = booleanValue(changes.enabled, current.enabled);
  const scannerEnabled = booleanValue(changes.scannerEnabled, current.scannerEnabled);
  const paperTradingEnabled = booleanValue(changes.paperTradingEnabled, current.paperTradingEnabled);
  const watchlistEnabled = booleanValue(changes.watchlistEnabled, current.watchlistEnabled);
  if (enabled && current.verificationStatus === "legacy") {
    throw marketError(`Legacy market cannot be enabled. Use ${current.replacementSymbol || "its replacement"}.`, 409);
  }
  const marketStatus = !enabled
    ? "disabled"
    : current.verificationStatus === "verified" ? "active"
      : current.verificationStatus === "legacy" ? "legacy" : "pending";
  if (scannerEnabled && enabled && marketStatus !== "active") {
    throw marketError("Verify provider candle support before enabling this pair for scanning.", 409);
  }
  const result = await query(`UPDATE crypto_markets SET enabled=$2, scanner_enabled=$3,
    paper_trading_enabled=$4, watchlist_enabled=$5, market_status=$6, updated_at=now()
    WHERE symbol=$1 RETURNING *`, [current.symbol, enabled, scannerEnabled, paperTradingEnabled, watchlistEnabled, marketStatus]);
  runtime.set(current.symbol, mapRow(result.rows[0]));
  return getCryptoMarketState(current.symbol);
}

export async function importCoinbaseCryptoProducts(products) {
  const discovered = normalizeCoinbaseProducts(products);
  const discoveredSymbols = new Set(discovered.map((product) => product.providerSymbol));
  const existingResult = await query("SELECT provider_symbol FROM crypto_markets");
  const existing = new Set(existingResult.rows.map((row) => row.provider_symbol));
  let imported = 0;
  let updated = 0;
  for (const product of discovered) {
    const existed = existing.has(product.providerSymbol);
    await query(`INSERT INTO crypto_markets (
      symbol, display_symbol, provider_symbol, name, provider, liquidity_tier,
      enabled, scanner_enabled, paper_trading_enabled, watchlist_enabled,
      provider_status, base_asset, quote_asset, product_status, trading_enabled,
      market_status, verification_status
    ) VALUES ($1,$2,$3,$4,'coinbase-exchange',$5,true,false,true,true,'unchecked',$6,$7,$8,true,'pending','pending')
    ON CONFLICT (provider_symbol) DO UPDATE SET
      display_symbol=EXCLUDED.display_symbol, name=EXCLUDED.name,
      base_asset=EXCLUDED.base_asset, quote_asset=EXCLUDED.quote_asset,
      product_status=EXCLUDED.product_status, trading_enabled=EXCLUDED.trading_enabled,
      updated_at=now()`, [
      product.symbol, product.displaySymbol, product.providerSymbol, product.name,
      product.liquidityTier, product.baseAsset, product.quoteAsset, product.productStatus
    ]);
    if (existed) updated += 1;
    else imported += 1;
  }
  let missingLegacy = 0;
  if (discovered.length > 0) {
    const missing = await query(`UPDATE crypto_markets SET market_status='unavailable',
      verification_status='failed', provider_status='unavailable',
      last_error='Product no longer returned by Coinbase product sync.',
      failure_code='PRODUCT_NOT_RETURNED', cooldown_until=NULL, updated_at=now()
      WHERE provider='coinbase-exchange'
        AND enabled=true
        AND market_status NOT IN ('legacy', 'disabled')
        AND provider_symbol <> ALL($1::text[])
      RETURNING symbol`, [[...discoveredSymbols]]);
    missingLegacy = missing.rows.length;
  }
  await reloadCryptoMarketSettings();
  const skipped = Math.max(0, (Array.isArray(products) ? products.length : 0) - discovered.length);
  console.info(`[market-sync] discovered=${discovered.length} imported=${imported} updated=${updated} skipped=${skipped}`);
  return {
    productsFound: Array.isArray(products) ? products.length : 0,
    discovered: discovered.length,
    usdCryptoPairsImported: discovered.length,
    imported,
    new: imported,
    updated,
    missingLegacy,
    skipped,
    total: runtime.size
  };
}

export function normalizeCoinbaseProducts(products = []) {
  const unique = new Map();
  for (const raw of Array.isArray(products) ? products : []) {
    const providerSymbol = String(raw.id || raw.product_id || "").trim().toUpperCase();
    const baseAsset = String(raw.base_currency || raw.base || providerSymbol.split("-")[0] || "").trim().toUpperCase();
    const quoteAsset = String(raw.quote_currency || raw.quote || providerSymbol.split("-")[1] || "").trim().toUpperCase();
    const productStatus = String(raw.status || "online").trim().toLowerCase();
    const tradingEnabled = raw.trading_disabled !== true && !["offline", "delisted", "disabled"].includes(productStatus);
    if (!/^[A-Z0-9]{1,20}-USD$/.test(providerSymbol) || quoteAsset !== "USD" || !tradingEnabled || stableOrFiatBases.has(baseAsset)) continue;
    unique.set(providerSymbol, {
      symbol: providerSymbol,
      displaySymbol: providerSymbol.replace("-", ""),
      providerSymbol,
      name: cleanProductName(raw.display_name || raw.base_name || raw.name || baseAsset, baseAsset),
      baseAsset,
      quoteAsset,
      productStatus,
      liquidityTier: inferLiquidityTier(providerSymbol)
    });
  }
  return [...unique.values()];
}

export async function saveCryptoMarketVerification(symbol, checks, details = {}) {
  const current = getCryptoMarketState(symbol);
  if (!current) throw marketError("Unknown crypto market.", 404);
  const classification = classifyCryptoVerification(checks);
  const passed = checks.filter((check) => check.available);
  const supported = passed.map((check) => check.timeframe);
  const unsupported = checks.filter((check) => !check.available).map((check) => check.timeframe);
  const { enough, marketStatus, verificationStatus, providerStatus } = classification;
  const lastSuccess = passed.map((check) => check.lastCandleAt).filter(Boolean).sort().at(-1) || null;
  const lastFailure = checks.findLast?.((check) => !check.available) || [...checks].reverse().find((check) => !check.available);
  const lastError = enough && unsupported.length
    ? `Verified with ${supported.length}/${cryptoTimeframes.length} timeframes. Unsupported: ${unsupported.join(", ")}.`
    : lastFailure?.error || (enough ? null : "No candle data returned from provider.");
  const cooldownUntil = enough ? null : new Date(Date.now() + appConfig.cryptoMarkets.unavailableCooldownMs);
  const checkedAt = new Date();
  const verificationDetails = buildVerificationDetails(current, checks, {
    ...details,
    finalStatus: marketStatus,
    lastError,
    nextRetryAt: cooldownUntil?.toISOString() || null,
    lastVerificationAttempt: checkedAt.toISOString()
  });
  const result = await query(`UPDATE crypto_markets SET market_status=$2, verification_status=$3,
    provider_status=$4, supported_timeframes=$5, unsupported_timeframes=$6,
    last_successful_candle_at=$7, last_checked_at=$11, last_verified_at=$11,
    last_verification_attempt_at=$11,
    last_error=$8, failure_code=$9, cooldown_until=$10, verification_details=$12,
    consecutive_failures=CASE WHEN $2='active' THEN 0 ELSE consecutive_failures+1 END,
    updated_at=now() WHERE symbol=$1 RETURNING *`, [
    current.symbol, marketStatus, verificationStatus, providerStatus, supported, unsupported,
    lastSuccess, lastError, lastFailure?.code || null, cooldownUntil, checkedAt, verificationDetails
  ]);
  runtime.set(current.symbol, mapRow(result.rows[0]));
  if (marketStatus === "active") await markVerifiedLegacyReplacements(current.symbol);
  if (marketStatus !== "active") {
    console.warn(`[market-verify] ${current.providerSymbol} ${marketStatus} reason=${safeLogReason(lastError)}`);
  }
  return getCryptoMarketState(current.symbol);
}

export function classifyCryptoVerification(checks = []) {
  const supportedCount = checks.filter((check) => check.available).length;
  const providerErrorCount = checks.filter((check) => !check.available && isProviderErrorCode(check.code)).length;
  const enough = supportedCount >= Math.min(3, cryptoTimeframes.length);
  return {
    enough,
    marketStatus: enough ? "active" : providerErrorCount ? "provider_error" : "unavailable",
    verificationStatus: enough ? "verified" : providerErrorCount ? "error" : "failed",
    providerStatus: enough ? "available" : providerErrorCount ? "provider_issue" : "unavailable"
  };
}

export async function replaceLegacyCryptoMarket(symbol, replacementSymbol) {
  const current = getCryptoMarketState(symbol);
  const replacement = getCryptoMarketState(replacementSymbol);
  if (!current || !replacement) throw marketError("Both legacy and replacement markets must exist.", 404);
  const checkedAt = new Date();
  const details = {
    provider: "Coinbase",
    providerSymbol: current.providerSymbol,
    productExists: false,
    productTradingEnabled: false,
    productStatus: "legacy",
    candleChecks: {},
    latestCandleTime: null,
    lastVerifiedAt: checkedAt.toISOString(),
    lastVerificationAttempt: checkedAt.toISOString(),
    lastError: "Legacy Coinbase symbol. Use the replacement market.",
    nextRetryTime: null,
    finalStatus: "legacy"
  };
  const result = await query(`UPDATE crypto_markets SET market_status='legacy', verification_status='legacy',
    provider_status='unavailable', enabled=false, scanner_enabled=false, paper_trading_enabled=false,
    replacement_symbol=$2, last_error='Legacy Coinbase symbol. Use the replacement market.',
    last_checked_at=$3, last_verified_at=$3, last_verification_attempt_at=$3,
    verification_details=$4, updated_at=now()
    WHERE symbol=$1 RETURNING *`, [current.symbol, replacement.symbol, checkedAt, details]);
  runtime.set(current.symbol, mapRow(result.rows[0]));
  return getCryptoMarketState(current.symbol);
}

export async function resetCryptoMarketCooldown(symbol) {
  const current = getCryptoMarketState(symbol);
  if (!current) throw marketError("Unknown crypto market.", 404);
  const previouslyVerified = current.supportedTimeframes.length > 0;
  const next = { ...current,
    marketStatus: previouslyVerified ? "active" : "pending",
    verificationStatus: previouslyVerified ? "verified" : "pending",
    providerStatus: previouslyVerified ? "available" : "unchecked",
    cooldownUntil: null, lastError: null, failureCode: null
  };
  runtime.set(current.symbol, next);
  await query(`UPDATE crypto_markets SET market_status=CASE WHEN cardinality(supported_timeframes)>0 THEN 'active' ELSE 'pending' END,
    verification_status=CASE WHEN cardinality(supported_timeframes)>0 THEN 'verified' ELSE 'pending' END,
    provider_status=CASE WHEN cardinality(supported_timeframes)>0 THEN 'available' ELSE 'unchecked' END,
    cooldown_until=NULL, last_error=NULL, failure_code=NULL, updated_at=now() WHERE symbol=$1`, [current.symbol]).catch(() => {});
}

export async function recordCryptoMarketSuccess(symbol, timeframe, lastCandleAt) {
  const current = getCryptoMarketState(symbol);
  if (!current || !cryptoTimeframes.includes(timeframe)) return;
  const supported = [...new Set([...current.supportedTimeframes, timeframe])];
  const unsupported = current.unsupportedTimeframes.filter((item) => item !== timeframe);
  const checkedAt = new Date();
  const recentlyRecorded = current.marketStatus === "active" && current.supportedTimeframes.includes(timeframe) && current.lastCheckedAt && checkedAt.getTime() - new Date(current.lastCheckedAt).getTime() < 300000;
  const next = { ...current, marketStatus: "active", verificationStatus: "verified", providerStatus: "available", supportedTimeframes: supported, unsupportedTimeframes: unsupported, lastSuccessfulCandleAt: lastCandleAt, lastCheckedAt: checkedAt.toISOString(), lastVerifiedAt: checkedAt.toISOString(), lastError: null, failureCode: null, cooldownUntil: null, consecutiveFailures: 0 };
  runtime.set(current.symbol, next);
  loggedFailures.delete(`${current.symbol}:${timeframe}`);
  if (recentlyRecorded) return;
  await query(`UPDATE crypto_markets SET market_status='active', verification_status='verified', provider_status='available',
    supported_timeframes=$2, unsupported_timeframes=$3, last_successful_candle_at=$4, last_checked_at=$5,
    last_verified_at=$5, last_error=NULL, failure_code=NULL, cooldown_until=NULL,
    consecutive_failures=0, updated_at=now() WHERE symbol=$1`, [current.symbol, supported, unsupported, lastCandleAt, checkedAt]).catch(() => {});
}

export async function recordCryptoMarketFailure(symbol, timeframe, error) {
  const current = getCryptoMarketState(symbol);
  if (!current) return;
  const unavailable = ["PROVIDER_UNSUPPORTED_MARKET", "EMPTY_CANDLES", "BAD_CANDLES", "INSUFFICIENT_CANDLES", "STALE_CANDLES"].includes(error?.code);
  const marketStatus = unavailable ? "unavailable" : "provider_error";
  const verificationStatus = unavailable ? "failed" : "error";
  const providerStatus = unavailable ? "unavailable" : "provider_issue";
  const unsupported = unavailable ? [...new Set([...current.unsupportedTimeframes, timeframe])] : current.unsupportedTimeframes;
  const cooldownUntil = new Date(Date.now() + appConfig.cryptoMarkets.unavailableCooldownMs);
  const next = { ...current, marketStatus, verificationStatus, providerStatus, unsupportedTimeframes: unsupported, lastCheckedAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(), lastError: publicError(error), failureCode: error?.code || "PROVIDER_ERROR", cooldownUntil: cooldownUntil.toISOString(), consecutiveFailures: current.consecutiveFailures + 1 };
  runtime.set(current.symbol, next);
  await query(`UPDATE crypto_markets SET market_status=$2, verification_status=$3, provider_status=$4,
    unsupported_timeframes=$5, last_checked_at=now(), last_verified_at=now(), last_error=$6,
    failure_code=$7, cooldown_until=$8, consecutive_failures=consecutive_failures+1,
    updated_at=now() WHERE symbol=$1`, [current.symbol, marketStatus, verificationStatus, providerStatus, unsupported, next.lastError, next.failureCode, cooldownUntil]).catch(() => {});
  logCryptoMarketFailureOnce(current.symbol, timeframe, next);
}

export function logCryptoMarketFailureOnce(symbol, timeframe, state) {
  const key = `${symbol}:${timeframe}:${state.failureCode}`;
  const previous = loggedFailures.get(key) || 0;
  if (Date.now() - previous < appConfig.cryptoMarkets.unavailableCooldownMs) return false;
  loggedFailures.set(key, Date.now());
  console.warn(`[crypto-market] unavailable symbol=${symbol} timeframe=${timeframe} code=${state.failureCode} cooldown_until=${state.cooldownUntil}`);
  return true;
}

export function isCryptoMarketCoolingDown(symbol) {
  const market = getCryptoMarketState(symbol);
  return market ? isCoolingDown(market) : false;
}

function effectiveFlags(market) {
  const ready = market.marketStatus === "active" && market.enabled && !isCoolingDown(market);
  return {
    statusLabel: market.enabled === false ? "Disabled by admin" : statusLabel(market.marketStatus),
    effectiveScannerEnabled: Boolean(ready && market.scannerEnabled),
    effectivePaperTradingEnabled: Boolean(ready && market.paperTradingEnabled),
    effectiveWatchlistEnabled: Boolean(ready && market.watchlistEnabled)
  };
}

function defaultState(market) {
  const legacyReplacement = legacyCryptoReplacements[market.symbol] || null;
  const established = establishedSymbols.has(market.symbol);
  const marketStatus = legacyReplacement ? "legacy" : established ? "active" : "pending";
  return {
    ...market,
    baseAsset: market.symbol.split("-")[0], quoteAsset: "USD", productStatus: "legacy_seed",
    tradingEnabled: true, enabled: legacyReplacement ? false : market.enabled,
    scannerEnabled: legacyReplacement ? false : market.scannerEnabled,
    paperTradingEnabled: legacyReplacement ? false : market.paperTradingEnabled,
    providerStatus: legacyReplacement ? "unavailable" : established ? "available" : "unchecked",
    marketStatus, verificationStatus: legacyReplacement ? "legacy" : established ? "verified" : "pending",
    supportedTimeframes: established ? [...cryptoTimeframes] : [], unsupportedTimeframes: [],
    lastSuccessfulCandleAt: null, lastCheckedAt: null, lastVerifiedAt: null,
    lastError: legacyReplacement ? "Legacy Coinbase symbol. Use the replacement market." : null,
    failureCode: null, cooldownUntil: null, consecutiveFailures: 0,
    replacementSymbol: legacyReplacement, createdAt: null, updatedAt: null
  };
}

function mapRow(row) {
  return {
    symbol: row.symbol, displaySymbol: row.display_symbol, providerSymbol: row.provider_symbol,
    name: row.name, category: "Crypto", group: row.liquidity_tier === "major" ? "Major crypto" : "Altcoins",
    assetClass: "Crypto", venue: "Coinbase", provider: row.provider,
    liquidityTier: row.liquidity_tier, minTimeframesSupported: 1,
    baseAsset: row.base_asset, quoteAsset: row.quote_asset, productStatus: row.product_status,
    tradingEnabled: row.trading_enabled, enabled: row.enabled, scannerEnabled: row.scanner_enabled,
    paperTradingEnabled: row.paper_trading_enabled, watchlistEnabled: row.watchlist_enabled,
    providerStatus: row.provider_status, marketStatus: row.market_status || legacyProviderStatus(row),
    verificationStatus: row.verification_status || legacyVerificationStatus(row),
    supportedTimeframes: row.supported_timeframes || [], unsupportedTimeframes: row.unsupported_timeframes || [],
    lastSuccessfulCandleAt: row.last_successful_candle_at, lastCheckedAt: row.last_checked_at,
    lastVerificationAttemptAt: row.last_verification_attempt_at || row.last_checked_at,
    lastVerifiedAt: row.last_verified_at, lastError: row.last_error, failureCode: row.failure_code,
    cooldownUntil: row.cooldown_until, consecutiveFailures: Number(row.consecutive_failures || 0),
    replacementSymbol: row.replacement_symbol, verificationDetails: row.verification_details || {},
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function buildVerificationDetails(market, checks, details) {
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
      error: "Verification was not attempted.",
      code: "NOT_CHECKED"
    }];
  }));

  return {
    provider: "Coinbase",
    providerSymbol: market.providerSymbol,
    productExists: details.productExists ?? null,
    productTradingEnabled: details.productTradingEnabled ?? null,
    productStatus: details.productStatus || market.productStatus || null,
    candleChecks: byTimeframe,
    latestCandleTime: checks.map((check) => check.lastCandleAt).filter(Boolean).sort().at(-1) || null,
    lastVerifiedAt: details.lastVerificationAttempt || null,
    lastVerificationAttempt: details.lastVerificationAttempt || null,
    lastError: details.lastError || null,
    nextRetryTime: details.nextRetryAt || null,
    finalStatus: details.finalStatus || "pending"
  };
}

async function markVerifiedLegacyReplacements(replacementSymbol) {
  const legacy = Object.entries(legacyCryptoReplacements).find(([, replacement]) => replacement === replacementSymbol)?.[0];
  if (!legacy || !runtime.has(legacy)) return;
  await replaceLegacyCryptoMarket(legacy, replacementSymbol);
}

function statusLabel(status) {
  return ({ active: "Active", pending: "Pending verification", unavailable: "Unavailable", legacy: "Legacy / migrated", disabled: "Disabled by admin", provider_error: "Provider error" })[status] || "Pending verification";
}
function safeLogReason(value) { return String(value || "unknown").replace(/[\r\n]+/g, " ").slice(0, 160); }
function legacyProviderStatus(row) { return row.provider_status === "available" ? "active" : row.provider_status === "provider_issue" ? "provider_error" : row.provider_status === "unavailable" ? "unavailable" : "pending"; }
function legacyVerificationStatus(row) { return row.provider_status === "available" ? "verified" : row.provider_status === "provider_issue" ? "error" : row.provider_status === "unavailable" ? "failed" : "pending"; }
function normalizeSymbol(value) { return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function isCoolingDown(market) { return Boolean(market.cooldownUntil && new Date(market.cooldownUntil).getTime() > Date.now()); }
function booleanValue(value, fallback) { return typeof value === "boolean" ? value : fallback; }
function publicError(error) { return String(error?.message || "No candle data returned from provider.").slice(0, 300); }
function marketError(message, statusCode) { const error = new Error(message); error.statusCode = statusCode; return error; }
function tierOrder(tier) { return ({ major: 0, standard: 1, "high-volatility": 2 })[tier] ?? 3; }
function inferLiquidityTier(symbol) { return establishedSymbols.has(symbol) ? "major" : ["SHIB-USD", "PEPE-USD", "BONK-USD", "WIF-USD", "FLOKI-USD"].includes(symbol) ? "high-volatility" : "standard"; }
function cleanProductName(value, fallback) { return String(value || fallback).replace(/\s*[/|-]\s*USD$/i, "").trim() || fallback; }
function isProviderErrorCode(code) { return ["PROVIDER_UNAVAILABLE", "PROVIDER_RESPONSE_ERROR", "MARKET_DATA_TIMEOUT", "RATE_LIMITED", "BAD_PROVIDER_RESPONSE"].includes(code); }
