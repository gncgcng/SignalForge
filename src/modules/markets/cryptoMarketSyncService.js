import { getProductsFromCoinbase } from "../market-data/coinbaseMarketDataProvider.js";
import { importCoinbaseCryptoProducts } from "./cryptoMarketService.js";
import { appConfig } from "../../config/appConfig.js";

let syncRunning = false;
let syncTimer = null;

export function startCoinbaseCryptoMarketSync() {
  if (syncTimer) return;
  if (!appConfig.cryptoMarkets.syncEnabled) {
    console.info("[market-sync] disabled by COINBASE_MARKET_SYNC_ENABLED=false");
    return;
  }
  setTimeout(() => syncCoinbaseCryptoMarkets().catch(logSyncFailure), 1000);
  syncTimer = setInterval(() => syncCoinbaseCryptoMarkets().catch(logSyncFailure), appConfig.cryptoMarkets.syncIntervalMs);
}

export async function syncCoinbaseCryptoMarkets() {
  if (syncRunning) {
    const error = new Error("A Coinbase market sync is already running.");
    error.statusCode = 409;
    throw error;
  }
  syncRunning = true;
  try {
    const products = await getProductsFromCoinbase();
    return await importCoinbaseCryptoProducts(products);
  } finally {
    syncRunning = false;
  }
}

function logSyncFailure(error) {
  console.warn(`[market-sync] failed reason=${String(error?.message || "unknown").replace(/[\r\n]+/g, " ").slice(0, 240)}`);
}
