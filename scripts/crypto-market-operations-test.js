import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appConfig } from "../src/config/appConfig.js";
import { cryptoMarketMatchesSearch, cryptoMarketUniverse, findCryptoMarket } from "../src/modules/markets/cryptoMarkets.js";
import { runWithConcurrency } from "../src/modules/markets/cryptoMarketMonitor.js";
import {
  getCryptoMarketState,
  listPaperCryptoMarkets,
  listScannerCryptoMarkets,
  logCryptoMarketFailureOnce,
  recordCryptoMarketFailure,
  recordCryptoMarketSuccess,
  resetCryptoMarketCooldown
} from "../src/modules/markets/cryptoMarketService.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("migrations/044_crypto_market_operations.sql");
const detailsMigration = read("migrations/046_crypto_market_verification_details.sql");
const controller = read("src/modules/markets/cryptoMarketController.js");
const marketData = read("src/modules/market-data/marketDataService.js");
const provider = read("src/modules/market-data/coinbaseMarketDataProvider.js");
const signalService = read("src/modules/signals/signalService.js");
const validation = read("src/modules/signals/signalValidationService.js");
const paper = read("src/modules/paper-trading/paperTradingService.js");
const app = read("public/app.js");
const html = read("public/index.html");

const avalanche = findCryptoMarket("AVAXUSD");
assert.equal(avalanche.providerSymbol, "AVAX-USD");
assert.equal(cryptoMarketMatchesSearch(avalanche, "Avalanche"), true);
assert.equal(cryptoMarketMatchesSearch(avalanche, "Coinbase AVAX-USD"), true);
assert.equal(cryptoMarketMatchesSearch(findCryptoMarket("BTC-USD"), "BTC"), true);

await recordCryptoMarketSuccess("ATOM-USD", "15m", new Date().toISOString());
assert.equal(listScannerCryptoMarkets().some((market) => market.symbol === "ATOM-USD"), true);
await recordCryptoMarketFailure("ATOM-USD", "15m", { code: "EMPTY_CANDLES", message: "No candle data from provider" });
assert.equal(getCryptoMarketState("ATOM-USD").cooldownUntil != null, true);
assert.equal(getCryptoMarketState("ATOM-USD").lastError, null);
assert.equal(getCryptoMarketState("ATOM-USD").consecutiveFailures >= 1, true);
assert.equal(listScannerCryptoMarkets().some((market) => market.symbol === "ATOM-USD"), true);
assert.equal(listPaperCryptoMarkets().some((market) => market.symbol === "ATOM-USD"), true);

const state = { failureCode: "EMPTY_CANDLES", cooldownUntil: new Date(Date.now() + 10000).toISOString() };
assert.equal(logCryptoMarketFailureOnce("TEST-USD", "15m", state), true);
assert.equal(logCryptoMarketFailureOnce("TEST-USD", "15m", state), false);

let active = 0;
let peak = 0;
const concurrencyResults = await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
  active += 1; peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, 2));
  active -= 1;
  return value * 2;
});
assert.deepEqual(concurrencyResults, [2, 4, 6, 8, 10, 12, 14]);
assert.ok(peak <= 3);
assert.ok(listScannerCryptoMarkets().length <= appConfig.cryptoMarkets.maxActiveScannerPairs);
await resetCryptoMarketCooldown("ATOM-USD");

const checks = {
  starterUniverse: ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "ADA-USD", "DOGE-USD", "LINK-USD", "AVAX-USD", "LTC-USD", "BCH-USD", "DOT-USD", "UNI-USD", "AAVE-USD", "ATOM-USD", "ETC-USD", "NEAR-USD", "OP-USD", "ARB-USD", "INJ-USD", "ICP-USD", "SHIB-USD", "PEPE-USD", "BONK-USD"].every((symbol) => findCryptoMarket(symbol)),
  centralMetadata: cryptoMarketUniverse.every((market) => market.displaySymbol && market.providerSymbol && market.provider === "coinbase-exchange" && Array.isArray(market.supportedTimeframes)),
  migrationSafe: migration.includes("CREATE TABLE IF NOT EXISTS crypto_markets") && migration.includes("scanner_enabled") && migration.includes("cooldown_until") && migration.includes("unsupported_timeframes") && !migration.match(/DELETE FROM/i),
  verificationDetailsMigration: detailsMigration.includes("ADD COLUMN IF NOT EXISTS verification_details") && detailsMigration.includes("last_verification_attempt_at") && detailsMigration.includes("idx_crypto_markets_status_retry"),
  scannerUsesCapabilities: signalService.includes("getManualScannerUniverse") && marketData.includes("listManualScannerPairs") && marketData.includes("listAutoScannerPairs") && marketData.includes("listScannerCryptoMarkets"),
  providerLimited: provider.includes("maxConcurrentRequests") && provider.includes("acquireRequestSlot") && provider.includes("maxCandlesPerRequest"),
  cooldownRecorded: marketData.includes("recordCryptoMarketFailure") && marketData.includes("MARKET_COOLDOWN") && marketData.includes("STALE_CANDLES") && marketData.includes("INSUFFICIENT_CANDLES"),
  adminProtected: controller.includes("if (!req.user)") && controller.includes("if (!isAdminUser(req.user))") && controller.includes("updateCryptoMarketSettings") && controller.includes("verifyCryptoMarket"),
  adminUi: html.includes('id="admin-crypto-markets-view"') && html.includes('id="admin-crypto-markets-nav-link"') && html.includes('id="admin-crypto-diagnostics"') && app.includes("loadAdminCryptoMarkets") && app.includes("data-crypto-setting") && app.includes("Verification details"),
  paperRestricted: paper.includes("listPaperTradingPairs") && paper.includes("effectivePaperTradingEnabled"),
  validationPreserved: /Latest candle is stale/i.test(validation) && validation.includes("ATR unavailable") && validation.includes("Invalid volume data") && validation.includes("Risk/reward is below 1.5R")
};
for (const [name, passed] of Object.entries(checks)) assert.equal(Boolean(passed), true, `Crypto market operations check failed: ${name}`);

console.log(JSON.stringify({ ...checks, peakConcurrency: peak, scannerLimit: appConfig.cryptoMarkets.maxActiveScannerPairs }, null, 2));
