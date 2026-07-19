import { appConfig } from "../../config/appConfig.js";
import { query } from "../../db/client.js";
import { cryptoMarketUniverse, cryptoTimeframes, findCryptoMarket } from "./cryptoMarkets.js";

const establishedSymbols = new Set([
  "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "ADA-USD", "DOGE-USD",
  "LINK-USD", "AVAX-USD", "LTC-USD"
]);
const runtime = new Map(cryptoMarketUniverse.map((market) => [market.symbol, defaultState(market)]));
const loggedFailures = new Map();

export async function initializeCryptoMarketSettings() {
  for (const market of cryptoMarketUniverse) {
    await query(`INSERT INTO crypto_markets (
      symbol, display_symbol, provider_symbol, name, provider, liquidity_tier,
      enabled, scanner_enabled, paper_trading_enabled, watchlist_enabled,
      provider_status, supported_timeframes
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (symbol) DO UPDATE SET
      display_symbol = EXCLUDED.display_symbol,
      provider_symbol = EXCLUDED.provider_symbol,
      name = EXCLUDED.name,
      provider = EXCLUDED.provider,
      liquidity_tier = EXCLUDED.liquidity_tier,
      updated_at = now()`, [
      market.symbol, market.displaySymbol, market.providerSymbol, market.name,
      market.provider, market.liquidityTier, market.enabled, market.scannerEnabled,
      market.paperTradingEnabled, market.watchlistEnabled,
      establishedSymbols.has(market.symbol) ? "available" : "unchecked",
      establishedSymbols.has(market.symbol) ? [...cryptoTimeframes] : []
    ]);
  }
  const result = await query("SELECT * FROM crypto_markets ORDER BY liquidity_tier, symbol");
  for (const row of result.rows) runtime.set(row.symbol, mapRow(row));
  console.info(`[crypto-markets] loaded=${result.rows.length} scanner_ready=${listScannerCryptoMarkets().length}`);
  return listCryptoMarketSettings();
}

export function getCryptoMarketState(symbol) {
  const market = findCryptoMarket(symbol);
  if (!market) return null;
  return { ...market, ...(runtime.get(market.symbol) || defaultState(market)), ...effectiveFlags(market.symbol) };
}

export function listCryptoMarketSettings() {
  return cryptoMarketUniverse.map((market) => getCryptoMarketState(market.symbol));
}

export function listScannerCryptoMarkets() {
  return listCryptoMarketSettings()
    .filter((market) => market.enabled && market.scannerEnabled && market.providerStatus === "available" && !isCoolingDown(market))
    .slice(0, appConfig.cryptoMarkets.maxActiveScannerPairs);
}

export function listPaperCryptoMarkets() {
  return listCryptoMarketSettings().filter((market) => market.enabled && market.paperTradingEnabled && market.providerStatus === "available" && !isCoolingDown(market));
}

export function canUseCryptoTimeframe(symbol, timeframe, capability = "market") {
  const market = getCryptoMarketState(symbol);
  if (!market || !market.enabled || isCoolingDown(market)) return false;
  if (capability === "scanner" && !market.effectiveScannerEnabled) return false;
  if (capability === "paper" && !market.effectivePaperTradingEnabled) return false;
  if (capability === "market") return !market.unsupportedTimeframes.includes(timeframe);
  return market.supportedTimeframes.includes(timeframe);
}

export async function updateCryptoMarketSettings(symbol, changes) {
  const market = findCryptoMarket(symbol);
  if (!market) throw marketError("Unknown crypto market.", 404);
  const current = getCryptoMarketState(market.symbol);
  const next = {
    enabled: booleanValue(changes.enabled, current.enabled),
    scannerEnabled: booleanValue(changes.scannerEnabled, current.scannerEnabled),
    paperTradingEnabled: booleanValue(changes.paperTradingEnabled, current.paperTradingEnabled),
    watchlistEnabled: booleanValue(changes.watchlistEnabled, current.watchlistEnabled)
  };
  if (next.scannerEnabled && current.providerStatus !== "available") {
    throw marketError("Verify provider candle support before enabling this pair for scanning.", 409);
  }
  const result = await query(`UPDATE crypto_markets SET enabled=$2, scanner_enabled=$3,
    paper_trading_enabled=$4, watchlist_enabled=$5, updated_at=now()
    WHERE symbol=$1 RETURNING *`, [market.symbol, next.enabled, next.scannerEnabled, next.paperTradingEnabled, next.watchlistEnabled]);
  runtime.set(market.symbol, mapRow(result.rows[0]));
  return getCryptoMarketState(market.symbol);
}

export async function resetCryptoMarketCooldown(symbol) {
  const market = findCryptoMarket(symbol);
  if (!market) throw marketError("Unknown crypto market.", 404);
  const current = runtime.get(market.symbol) || defaultState(market);
  runtime.set(market.symbol, {
    ...current,
    providerStatus: current.supportedTimeframes.length ? "available" : "unchecked",
    unsupportedTimeframes: [],
    cooldownUntil: null,
    lastError: null,
    failureCode: null
  });
  await query("UPDATE crypto_markets SET provider_status=CASE WHEN cardinality(supported_timeframes)>0 THEN 'available' ELSE 'unchecked' END, unsupported_timeframes=ARRAY[]::text[], cooldown_until=NULL, last_error=NULL, failure_code=NULL, updated_at=now() WHERE symbol=$1", [market.symbol]).catch(() => {});
}

export async function recordCryptoMarketSuccess(symbol, timeframe, lastCandleAt) {
  const market = findCryptoMarket(symbol);
  if (!market || !cryptoTimeframes.includes(timeframe)) return;
  const current = runtime.get(market.symbol) || defaultState(market);
  const supported = [...new Set([...current.supportedTimeframes, timeframe])];
  const unsupported = current.unsupportedTimeframes.filter((item) => item !== timeframe);
  const checkedAt = new Date();
  const recentlyRecorded = current.providerStatus === "available" && current.supportedTimeframes.includes(timeframe) && current.lastCheckedAt && checkedAt.getTime() - new Date(current.lastCheckedAt).getTime() < 300000;
  const next = { ...current, providerStatus: "available", supportedTimeframes: supported, unsupportedTimeframes: unsupported, lastSuccessfulCandleAt: lastCandleAt, lastCheckedAt: checkedAt.toISOString(), lastError: null, failureCode: null, cooldownUntil: null, consecutiveFailures: 0 };
  runtime.set(market.symbol, next);
  loggedFailures.delete(`${market.symbol}:${timeframe}`);
  if (recentlyRecorded) return;
  await query(`UPDATE crypto_markets SET provider_status='available',
    supported_timeframes=$2, unsupported_timeframes=$3, last_successful_candle_at=$4, last_checked_at=$5,
    last_error=NULL, failure_code=NULL, cooldown_until=NULL,
    consecutive_failures=0, updated_at=now() WHERE symbol=$1`, [market.symbol, supported, unsupported, lastCandleAt, checkedAt]).catch(() => {});
}

export async function recordCryptoMarketFailure(symbol, timeframe, error) {
  const market = findCryptoMarket(symbol);
  if (!market) return;
  const current = runtime.get(market.symbol) || defaultState(market);
  const permanentForTimeframe = ["PROVIDER_UNSUPPORTED_MARKET", "EMPTY_CANDLES", "BAD_CANDLES"].includes(error?.code);
  const supported = permanentForTimeframe ? current.supportedTimeframes.filter((item) => item !== timeframe) : current.supportedTimeframes;
  const unsupported = permanentForTimeframe ? [...new Set([...current.unsupportedTimeframes, timeframe])] : current.unsupportedTimeframes;
  const cooldownUntil = new Date(Date.now() + appConfig.cryptoMarkets.unavailableCooldownMs);
  const next = { ...current, providerStatus: permanentForTimeframe && !supported.length ? "unavailable" : permanentForTimeframe ? "available" : "provider_issue", supportedTimeframes: supported, unsupportedTimeframes: unsupported, lastCheckedAt: new Date().toISOString(), lastError: publicError(error), failureCode: error?.code || "PROVIDER_ERROR", cooldownUntil: cooldownUntil.toISOString(), consecutiveFailures: current.consecutiveFailures + 1 };
  runtime.set(market.symbol, next);
  await query(`UPDATE crypto_markets SET provider_status=$2, supported_timeframes=$3, unsupported_timeframes=$4,
    last_checked_at=now(), last_error=$5, failure_code=$6, cooldown_until=$7,
    consecutive_failures=consecutive_failures+1, updated_at=now() WHERE symbol=$1`, [market.symbol, next.providerStatus, supported, unsupported, next.lastError, next.failureCode, cooldownUntil]).catch(() => {});
  logCryptoMarketFailureOnce(market.symbol, timeframe, next);
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

function effectiveFlags(symbol) {
  const state = runtime.get(symbol);
  const ready = state?.providerStatus === "available" && !isCoolingDown(state);
  return {
    effectiveScannerEnabled: Boolean(state?.enabled && state?.scannerEnabled && ready),
    effectivePaperTradingEnabled: Boolean(state?.enabled && state?.paperTradingEnabled && ready),
    effectiveWatchlistEnabled: Boolean(state?.enabled && state?.watchlistEnabled)
  };
}
function defaultState(market) { const established = establishedSymbols.has(market.symbol); return { enabled: market.enabled, scannerEnabled: market.scannerEnabled, paperTradingEnabled: market.paperTradingEnabled, watchlistEnabled: market.watchlistEnabled, providerStatus: established ? "available" : "unchecked", supportedTimeframes: established ? [...cryptoTimeframes] : [], unsupportedTimeframes: [], lastSuccessfulCandleAt: null, lastCheckedAt: null, lastError: null, failureCode: null, cooldownUntil: null, consecutiveFailures: 0 }; }
function mapRow(row) { return { enabled: row.enabled, scannerEnabled: row.scanner_enabled, paperTradingEnabled: row.paper_trading_enabled, watchlistEnabled: row.watchlist_enabled, providerStatus: row.provider_status, supportedTimeframes: row.supported_timeframes || [], unsupportedTimeframes: row.unsupported_timeframes || [], lastSuccessfulCandleAt: row.last_successful_candle_at, lastCheckedAt: row.last_checked_at, lastError: row.last_error, failureCode: row.failure_code, cooldownUntil: row.cooldown_until, consecutiveFailures: Number(row.consecutive_failures || 0) }; }
function isCoolingDown(market) { return Boolean(market.cooldownUntil && new Date(market.cooldownUntil).getTime() > Date.now()); }
function booleanValue(value, fallback) { return typeof value === "boolean" ? value : fallback; }
function publicError(error) { return String(error?.message || "No candle data from provider").slice(0, 300); }
function marketError(message, statusCode) { const error = new Error(message); error.statusCode = statusCode; return error; }
