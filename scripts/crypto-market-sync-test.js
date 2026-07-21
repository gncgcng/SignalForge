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
import { normalizeCoinbaseProductCatalog } from "../src/modules/markets/cryptoMarketRebuildService.js";

const serviceSource = readFileSync(new URL("../src/modules/markets/cryptoMarketService.js", import.meta.url), "utf8");
const monitorSource = readFileSync(new URL("../src/modules/markets/cryptoMarketMonitor.js", import.meta.url), "utf8");
const controllerSource = readFileSync(new URL("../src/modules/markets/cryptoMarketController.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const verifyScript = readFileSync(new URL("../scripts/verify-pending-crypto-markets.js", import.meta.url), "utf8");
const singleMarketScript = readFileSync(new URL("../scripts/test-coinbase-market.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/045_crypto_market_sync.sql", import.meta.url), "utf8");
const detailsMigration = readFileSync(new URL("../migrations/046_crypto_market_verification_details.sql", import.meta.url), "utf8");
const statusMigration = readFileSync(new URL("../migrations/047_crypto_market_canonical_status.sql", import.meta.url), "utf8");
const activeStatusMigration = readFileSync(new URL("../migrations/048_crypto_market_active_status.sql", import.meta.url), "utf8");
const rebuildScript = readFileSync(new URL("../scripts/rebuild-active-crypto-markets.js", import.meta.url), "utf8");
const rebuildService = readFileSync(new URL("../src/modules/markets/cryptoMarketRebuildService.js", import.meta.url), "utf8");

const products = normalizeCoinbaseProducts([
  { id: "BTC-USD", base_currency: "BTC", quote_currency: "USD", display_name: "BTC/USD", status: "online" },
  { id: "BTC-USD", base_currency: "BTC", quote_currency: "USD", display_name: "Bitcoin / USD", status: "online" },
  { id: "NEW-USD", base_currency: "NEW", quote_currency: "USD", display_name: "New Coin / USD", status: "online" },
  { id: "USDC-USD", base_currency: "USDC", quote_currency: "USD", status: "online" },
  { id: "DOGE-USD", base_currency: "DOGE", quote_currency: "USD", status: "online", trading_disabled: true },
  { id: "ETH-EUR", base_currency: "ETH", quote_currency: "EUR", status: "online" }
]);
const rebuildCatalog = normalizeCoinbaseProductCatalog([
  { id: "BTC-USD", base_currency: "BTC", quote_currency: "USD", display_name: "BTC/USD", status: "online" },
  { id: "MATIC-USD", base_currency: "MATIC", quote_currency: "USD", status: "offline", trading_disabled: true },
  { id: "USDC-USD", base_currency: "USDC", quote_currency: "USD", status: "online" }
]);
const passedChecks = ["5m", "15m", "1h", "4h"].map((timeframe) => ({ timeframe, available: true }));
const emptyChecks = ["5m", "15m", "1h", "4h"].map((timeframe) => ({ timeframe, available: false, code: "EMPTY_CANDLES" }));
const providerChecks = ["5m", "15m", "1h", "4h"].map((timeframe) => ({ timeframe, available: false, code: "PROVIDER_UNAVAILABLE" }));
const timeoutChecks = ["5m", "15m", "1h", "4h"].map((timeframe) => ({ timeframe, available: false, code: "MARKET_DATA_TIMEOUT" }));
const sampleMarkets = [
  market("BTC-USD", "active", true, true, true),
  market("NEW-USD", "unavailable", true, false, true),
  market("OLD-USD", "unavailable", true, false, false),
  market("MATIC-USD", "legacy", false, false, false),
  market("OFF-USD", "disabled", false, false, false),
  market("ERR-USD", "provider_error", true, false, false)
];
const summary = summarizeCryptoMarkets(sampleMarkets);

const checks = {
  syncImportsUsdCrypto: products.some((product) => product.providerSymbol === "NEW-USD") && products.length === 2,
  syncDeduplicates: products.filter((product) => product.providerSymbol === "BTC-USD").length === 1,
  rebuildCatalogImportsUsdCrypto: rebuildCatalog.has("BTC-USD") && !rebuildCatalog.has("USDC-USD"),
  rebuildCatalogMarksInactive: rebuildCatalog.get("MATIC-USD")?.tradingEnabled === false,
  syncPreservesAdminSettings: serviceSource.includes("ON CONFLICT (provider_symbol) DO UPDATE SET") &&
    !serviceSource.slice(serviceSource.indexOf("ON CONFLICT (provider_symbol)"), serviceSource.indexOf("await reloadCryptoMarketSettings", serviceSource.indexOf("ON CONFLICT (provider_symbol)"))).includes("scanner_enabled=EXCLUDED"),
  pendingBecomesActive: classifyCryptoVerification(passedChecks).marketStatus === "active",
  emptyBecomesUnavailable: classifyCryptoVerification(emptyChecks).marketStatus === "unavailable",
  timeoutBecomesProviderError: classifyCryptoVerification(timeoutChecks).marketStatus === "provider_error",
  providerErrorStored: classifyCryptoVerification(providerChecks).marketStatus === "provider_error" && serviceSource.includes("last_error=$8"),
  verificationAlwaysTerminal: [passedChecks, emptyChecks, providerChecks].every((value) => classifyCryptoVerification(value).marketStatus !== "pending"),
  oneTimeframePassesReady: classifyCryptoVerification([{ timeframe: "15m", available: false, code: "EMPTY_CANDLES" }, { timeframe: "1h", available: true }]).marketStatus === "active",
  watcherIndependent: monitorSource.includes("verificationEnabled") && !monitorSource.includes("cryptoWatcherEnabled"),
  verificationDetailsStored: detailsMigration.includes("verification_details jsonb") && serviceSource.includes("verification_details=$12") && serviceSource.includes("buildVerificationDetails"),
  productCheckBeforeCandles: monitorSource.includes("getProductFromCoinbase") && monitorSource.includes("productTradingEnabled === false"),
  verifyAllProgressTerminal: monitorSource.includes("stillPending") && monitorSource.includes("complete ready="),
  slowReliableControls: monitorSource.includes("verificationDelayMs") && monitorSource.includes("verificationRetries") && monitorSource.includes("verificationTimeframes"),
  canonicalStatusSynced: activeStatusMigration.includes("status IN ('active', 'unavailable', 'provider_error', 'legacy', 'disabled')") &&
    activeStatusMigration.includes("status = 'pending'") &&
    serviceSource.includes("isReadyStatus(market.status || market.marketStatus)") &&
    serviceSource.includes("canonicalStatusFromMarketStatus"),
  rebuildScriptPresent: packageJson.includes('"market:rebuild-active"') &&
    rebuildScript.includes("rebuildActiveCryptoMarkets") &&
    rebuildService.includes("candleTestOrder") &&
    rebuildService.includes('"1h", "15m"') &&
    rebuildService.includes('"active"') &&
    rebuildService.includes('"unavailable"') &&
    rebuildService.includes("Legacy Coinbase symbol"),
  sharedTerminalVerifier: monitorSource.includes("export async function verifyPendingCryptoMarkets") &&
    controllerSource.includes("await verifyPendingCryptoMarkets()") &&
    verifyScript.includes("verifyPendingCryptoMarkets"),
  terminalScriptsPresent: packageJson.includes('"market:test"') &&
    packageJson.includes('"market:verify-pending"') &&
    packageJson.includes('"market:audit"') &&
    packageJson.includes('"market:audit-coinbase"') &&
    singleMarketScript.includes("getProductFromCoinbase") &&
    singleMarketScript.includes("getCandlesFromCoinbase"),
  countsSeparate: summary.totalDiscovered === 6 && summary.active === 1 && summary.unavailable === 2 && summary.legacy === 1 && summary.disabled === 1 && summary.providerError === 1 && summary.pending === undefined,
  scannerActiveOnly: listScannerCryptoMarkets().every((item) => item.status === "active" && item.marketStatus === "active" && item.scannerEnabled),
  paperActiveOnly: listPaperCryptoMarkets().every((item) => item.status === "active" && item.marketStatus === "active" && item.paperTradingEnabled),
  legacyReplacement: legacyCryptoReplacements["MATIC-USD"] === "POL-USD",
  adminFilters: filterCryptoMarkets(sampleMarkets, new URLSearchParams("status=unavailable")).map((item) => item.symbol).join() === "NEW-USD,OLD-USD",
  adminActionsPresent: controllerSource.includes("/rebuild-active") && html.includes("Rebuild active Coinbase markets") && html.includes("Check unresolved markets") && html.includes("Test Coinbase provider"),
  frontendRefreshes: appSource.includes("await loadAdminCryptoMarkets()") && appSource.includes("await loadPairs()") && appSource.includes("Rebuild complete") && appSource.includes("renderCryptoCandleCheck"),
  diagnosticsSamplePresent: monitorSource.includes("BTC-USD") && monitorSource.includes("AUDIO-USD") && monitorSource.includes("POL-USD"),
  migrationSafe: migration.includes("ADD COLUMN IF NOT EXISTS") && migration.includes("idx_crypto_markets_verification_queue") &&
    statusMigration.includes("CHECK (status IN") && activeStatusMigration.includes("DROP CONSTRAINT crypto_markets_status_check")
};

for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, `Crypto market sync check failed: ${name}`);
console.log(JSON.stringify(checks, null, 2));

function market(symbol, marketStatus, enabled, scannerEnabled, paperTradingEnabled) {
  const status = ({ active: "active", provider_error: "provider_error", unavailable: "unavailable", legacy: "legacy", disabled: "disabled" })[marketStatus] || "unavailable";
  return {
    symbol, displaySymbol: symbol.replace("-", ""), providerSymbol: symbol, name: symbol,
    status, marketStatus, verificationStatus: marketStatus === "active" ? "verified" : marketStatus === "provider_error" ? "error" : marketStatus === "legacy" ? "legacy" : "failed",
    enabled, scannerEnabled, paperTradingEnabled, effectiveScannerEnabled: enabled && status === "active" && scannerEnabled,
    effectivePaperTradingEnabled: enabled && status === "active" && paperTradingEnabled,
    liquidityTier: "standard"
  };
}
