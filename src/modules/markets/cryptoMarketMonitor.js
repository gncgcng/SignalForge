import { appConfig } from "../../config/appConfig.js";
import { getOhlcv } from "../market-data/marketDataService.js";
import { cryptoTimeframes } from "./cryptoMarkets.js";
import { getCryptoMarketState, listCryptoMarketSettings, resetCryptoMarketCooldown } from "./cryptoMarketService.js";

let monitorTimer = null;
let monitorRunning = false;

export function startCryptoMarketAvailabilityMonitor() {
  if (monitorTimer) return;
  const intervalMs = Math.max(900000, Number(appConfig.autoScan.intervalMs || 900000));
  setTimeout(() => verifyNextCryptoMarkets().catch((error) => console.warn(`[crypto-markets] verification_failed reason=${error.message}`)), 5000);
  monitorTimer = setInterval(() => verifyNextCryptoMarkets().catch((error) => console.warn(`[crypto-markets] verification_failed reason=${error.message}`)), intervalMs);
}

export async function verifyNextCryptoMarkets() {
  if (monitorRunning) return { checked: 0, available: 0, unavailable: 0 };
  monitorRunning = true;
  try {
    const markets = listCryptoMarketSettings()
      .filter((market) => market.enabled && (market.providerStatus !== "available" || market.supportedTimeframes.length < cryptoTimeframes.length) && (!market.cooldownUntil || new Date(market.cooldownUntil).getTime() <= Date.now()))
      .slice(0, appConfig.cryptoMarkets.verificationPairsPerCycle);
    const results = await runWithConcurrency(markets, appConfig.cryptoMarkets.maxConcurrentRequests, (market) => verifyCryptoMarket(market.symbol));
    const available = results.filter((result) => result.available).length;
    console.info(`[crypto-markets] verification checked=${results.length} available=${available} unavailable=${results.length - available}`);
    return { checked: results.length, available, unavailable: results.length - available };
  } finally {
    monitorRunning = false;
  }
}

export async function verifyCryptoMarket(symbol, options = {}) {
  let before = getCryptoMarketState(symbol);
  if (!before) throw new Error("Unknown crypto market.");
  if (options.force) {
    await resetCryptoMarketCooldown(before.symbol);
    before = getCryptoMarketState(symbol);
  }
  const checked = [];
  for (const timeframe of cryptoTimeframes) {
    if (before.unsupportedTimeframes.includes(timeframe)) continue;
    try {
      const data = await getOhlcv(before.symbol, timeframe);
      checked.push({ timeframe, available: true, candles: data.candles.length });
    } catch (error) {
      checked.push({ timeframe, available: false, error: error.message, code: error.code });
      break;
    }
  }
  const market = getCryptoMarketState(symbol);
  return { symbol: market.symbol, available: market.providerStatus === "available" && market.supportedTimeframes.length >= market.minTimeframesSupported, checked, market };
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
