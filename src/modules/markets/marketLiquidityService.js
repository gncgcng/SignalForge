import { appConfig } from "../../config/appConfig.js";
import { query } from "../../db/client.js";

// Coinbase 24h USD volume per crypto market (market_liquidity), used to rank the auto scanner within each tier and
// to keep illiquid markets from generating signals. Until one refresh has ever succeeded (in this process or an
// earlier one, i.e. the table has rows) ranking and the floor are inactive and behaviour is unchanged.
const REQUEST_INTERVAL_MS = 350; // at most ~3 requests per second
const liquidity = new Map();
let refreshSucceeded = false;
let warnedInactive = false;
let refreshTimer = null;
let refreshRunning = false;

export function getLiquidityFloorUsd() {
  return appConfig.cryptoMarkets.minVolume24hUsd;
}

export async function loadMarketLiquidity() {
  const result = await query("SELECT symbol, volume_24h_usd, last_price, updated_at FROM market_liquidity");
  for (const row of result.rows) {
    liquidity.set(row.symbol, {
      volume24hUsd: row.volume_24h_usd == null ? null : Number(row.volume_24h_usd),
      lastPrice: row.last_price == null ? null : Number(row.last_price),
      updatedAt: row.updated_at
    });
  }
  if (result.rows.length) refreshSucceeded = true;
  return liquidity.size;
}

// One GET /products/{id}/stats per market, sequential and throttled. volume_24h_usd = volume (base) x last.
// A product that fails keeps its previous row.
export async function refreshMarketLiquidity(symbols, { fetchImpl = fetch, sleep = defaultSleep, baseUrl = appConfig.marketData.baseUrl } = {}) {
  let updated = 0;
  const failed = [];
  for (const [index, symbol] of symbols.entries()) {
    if (index > 0) await sleep(REQUEST_INTERVAL_MS);
    try {
      const stats = await fetchStats(symbol, fetchImpl, baseUrl);
      const volume = Number(stats?.volume);
      const last = Number(stats?.last);
      if (!Number.isFinite(volume) || volume < 0 || !Number.isFinite(last) || last <= 0) throw new Error("malformed stats response");
      const row = { volume24hUsd: volume * last, lastPrice: last, updatedAt: new Date() };
      await query(`INSERT INTO market_liquidity (symbol, volume_24h_usd, last_price, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (symbol) DO UPDATE SET volume_24h_usd = EXCLUDED.volume_24h_usd,
          last_price = EXCLUDED.last_price, updated_at = EXCLUDED.updated_at`,
      [symbol, row.volume24hUsd, row.lastPrice, row.updatedAt]);
      liquidity.set(symbol, row);
      updated += 1;
    } catch (error) {
      failed.push({ symbol, error: error.message });
    }
  }
  if (updated > 0) refreshSucceeded = true;
  const belowFloor = symbols.filter((symbol) => evaluateLiquidityFloor(symbol).belowFloor).length;
  console.info(`[market-liquidity] refreshed=${updated} failed=${failed.length} requested=${symbols.length} below_floor=${belowFloor} floor_usd=${getLiquidityFloorUsd()}${failed.length ? ` failed_symbols=${failed.slice(0, 10).map((item) => item.symbol).join(",")}` : ""}`);
  return { requested: symbols.length, updated, failed, belowFloor };
}

export function isLiquidityRankingActive() {
  if (!refreshSucceeded && !warnedInactive) {
    warnedInactive = true;
    console.warn("[market-liquidity] no liquidity refresh has succeeded yet; volume ranking and the liquidity floor are inactive");
  }
  return refreshSucceeded;
}

export function getMarketLiquidity(symbol) {
  return liquidity.get(symbol) || null;
}

// After a successful refresh, a market with no row counts as below the floor.
export function evaluateLiquidityFloor(symbol) {
  const floorUsd = getLiquidityFloorUsd();
  if (!isLiquidityRankingActive()) return { active: false, belowFloor: false, volume24hUsd: null, floorUsd };
  const volume24hUsd = liquidity.get(symbol)?.volume24hUsd ?? null;
  const belowFloor = volume24hUsd == null || volume24hUsd < floorUsd;
  return {
    active: true,
    belowFloor,
    volume24hUsd,
    floorUsd,
    reason: belowFloor
      ? `Below liquidity floor (${volume24hUsd == null ? "no 24h volume data" : `${formatUsd(volume24hUsd)} 24h volume`})`
      : null
  };
}

// Higher 24h volume first, markets without data last. Neutral (0) until a refresh has succeeded.
export function compareByLiquidity(a, b) {
  if (!isLiquidityRankingActive()) return 0;
  const left = liquidity.get(a)?.volume24hUsd ?? null;
  const right = liquidity.get(b)?.volume24hUsd ?? null;
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return right - left;
}

export function startMarketLiquidityRefresh(listSymbols) {
  if (refreshTimer) return;
  if (!appConfig.cryptoMarkets.liquidityRefreshEnabled) {
    console.info("[market-liquidity] refresh disabled by MARKET_LIQUIDITY_REFRESH_ENABLED=false");
    return;
  }
  const run = async () => {
    if (refreshRunning) return;
    refreshRunning = true;
    try {
      await refreshMarketLiquidity(listSymbols());
    } catch (error) {
      console.warn(`[market-liquidity] refresh failed: ${error.message}`);
    } finally {
      refreshRunning = false;
    }
  };
  setTimeout(run, 2000);
  refreshTimer = setInterval(run, appConfig.cryptoMarkets.liquidityRefreshIntervalMs);
}

export function formatUsd(value) {
  const number = Number(value);
  if (number >= 1e9) return `$${(number / 1e9).toFixed(2)}B`;
  if (number >= 1e6) return `$${(number / 1e6).toFixed(2)}M`;
  if (number >= 1e3) return `$${(number / 1e3).toFixed(1)}K`;
  return `$${number.toFixed(0)}`;
}

async function fetchStats(symbol, fetchImpl, baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), appConfig.marketData.requestTimeoutMs);
  try {
    const response = await fetchImpl(new URL(`/products/${encodeURIComponent(symbol)}/stats`, baseUrl), {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "SignalForge/0.1" }
    });
    if (!response.ok) throw new Error(`Coinbase stats returned ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Coinbase stats request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function defaultSleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
