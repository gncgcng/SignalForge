import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { filterCryptoMarkets, summarizeCryptoMarkets } from "../src/modules/markets/cryptoMarketController.js";
import {
  classifyCryptoVerification,
  legacyCryptoReplacements,
  listPaperCryptoMarkets,
  listScannerCryptoMarkets,
  normalizeCoinbaseProducts
} from "../src/modules/markets/cryptoMarketService.js";

const serviceSource = readFileSync(new URL("../src/modules/markets/cryptoMarketService.js", import.meta.url), "utf8");
const monitorSource = readFileSync(new URL("../src/modules/markets/cryptoMarketMonitor.js", import.meta.url), "utf8");
const controllerSource = readFileSync(new URL("../src/modules/markets/cryptoMarketController.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/045_crypto_market_sync.sql", import.meta.url), "utf8");

const products = normalizeCoinbaseProducts([
  { id: "BTC-USD", base_currency: "BTC", quote_currency: "USD", display_name: "BTC/USD", status: "online" },
  { id: "BTC-USD", base_currency: "BTC", quote_currency: "USD", display_name: "Bitcoin / USD", status: "online" },
  { id: "NEW-USD", base_currency: "NEW", quote_currency: "USD", display_name: "New Coin / USD", status: "online" },
  { id: "USDC-USD", base_currency: "USDC", quote_currency: "USD", status: "online" },
  { id: "DOGE-USD", base_currency: "DOGE", quote_currency: "USD", status: "online", trading_disabled: true },
  { id: "ETH-EUR", base_currency: "ETH", quote_currency: "EUR", status: "online" }
]);
const passedChecks = ["5m", "15m", "1h", "4h"].map((timeframe) => ({ timeframe, available: true }));
const emptyChecks = ["5m", "15m", "1h", "4h"].map((timeframe) => ({ timeframe, available: false, code: "EMPTY_CANDLES" }));
const providerChecks = ["5m", "15m", "1h", "4h"].map((timeframe) => ({ timeframe, available: false, code: "PROVIDER_UNAVAILABLE" }));
const sampleMarkets = [
  market("BTC-USD", "active", true, true, true),
  market("NEW-USD", "pending", true, false, true),
  market("OLD-USD", "unavailable", true, false, false),
  market("MATIC-USD", "legacy", false, false, false),
  market("OFF-USD", "disabled", false, false, false),
  market("ERR-USD", "provider_error", true, false, false)
];
const summary = summarizeCryptoMarkets(sampleMarkets);

const checks = {
  syncImportsUsdCrypto: products.some((product) => product.providerSymbol === "NEW-USD") && products.length === 2,
  syncDeduplicates: products.filter((product) => product.providerSymbol === "BTC-USD").length === 1,
  syncPreservesAdminSettings: serviceSource.includes("ON CONFLICT (provider_symbol) DO UPDATE SET") &&
    !serviceSource.slice(serviceSource.indexOf("ON CONFLICT (provider_symbol)"), serviceSource.indexOf("await reloadCryptoMarketSettings", serviceSource.indexOf("ON CONFLICT (provider_symbol)"))).includes("scanner_enabled=EXCLUDED"),
  pendingBecomesActive: classifyCryptoVerification(passedChecks).marketStatus === "active",
  emptyBecomesUnavailable: classifyCryptoVerification(emptyChecks).marketStatus === "unavailable",
  providerErrorStored: classifyCryptoVerification(providerChecks).marketStatus === "provider_error" && serviceSource.includes("last_error=$8"),
  verificationAlwaysTerminal: [passedChecks, emptyChecks, providerChecks].every((value) => classifyCryptoVerification(value).marketStatus !== "pending"),
  watcherIndependent: monitorSource.includes("verificationEnabled") && !monitorSource.includes("cryptoWatcherEnabled"),
  countsSeparate: summary.totalDiscovered === 6 && summary.active === 1 && summary.pending === 1 && summary.unavailable === 1 && summary.legacy === 1 && summary.disabled === 1 && summary.providerError === 1,
  scannerActiveOnly: listScannerCryptoMarkets().every((item) => item.marketStatus === "active" && item.scannerEnabled),
  paperActiveOnly: listPaperCryptoMarkets().every((item) => item.marketStatus === "active" && item.paperTradingEnabled),
  legacyReplacement: legacyCryptoReplacements["MATIC-USD"] === "POL-USD",
  adminFilters: filterCryptoMarkets(sampleMarkets, new URLSearchParams("status=pending")).map((item) => item.symbol).join() === "NEW-USD",
  adminActionsPresent: controllerSource.includes("/sync") && controllerSource.includes("/verify-pending") && html.includes("Sync Coinbase markets") && html.includes("Verify all pending"),
  frontendRefreshes: appSource.includes("pollCryptoVerificationJob") && appSource.includes("await loadAdminCryptoMarkets()") && appSource.includes("await loadPairs()"),
  migrationSafe: migration.includes("ADD COLUMN IF NOT EXISTS") && migration.includes("idx_crypto_markets_verification_queue")
};

for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, `Crypto market sync check failed: ${name}`);
console.log(JSON.stringify(checks, null, 2));

function market(symbol, marketStatus, enabled, scannerEnabled, paperTradingEnabled) {
  return {
    symbol, displaySymbol: symbol.replace("-", ""), providerSymbol: symbol, name: symbol,
    marketStatus, verificationStatus: marketStatus === "active" ? "verified" : "pending",
    enabled, scannerEnabled, paperTradingEnabled, effectiveScannerEnabled: enabled && marketStatus === "active" && scannerEnabled,
    effectivePaperTradingEnabled: enabled && marketStatus === "active" && paperTradingEnabled,
    liquidityTier: "standard"
  };
}
