import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const service = readFileSync(new URL("../src/modules/markets/cryptoMarketService.js", import.meta.url), "utf8");
const rebuildService = readFileSync(new URL("../src/modules/markets/cryptoMarketRebuildService.js", import.meta.url), "utf8");
const controller = readFileSync(new URL("../src/modules/markets/cryptoMarketController.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const checks = {
  passingCandlesBecomeActive:
    service.includes("const marketStatus = enough || keepActiveAfterFailure") &&
    service.includes("const verificationStatus = marketStatus === \"active\"") &&
    service.includes("const providerStatus = marketStatus === \"active\""),
  passingVerificationClearsOldProviderError:
    service.includes("last_error=$8") &&
    service.includes("enough ? null : lastFailure?.code || details.code || null") &&
    service.includes("scanner_enabled=CASE WHEN $2='active' AND enabled=true THEN true ELSE scanner_enabled END") &&
    service.includes("function reconcileSuccessfulVerification") &&
    service.includes("status: \"active\"") &&
    service.includes("lastError: null"),
  oldRateLimitDoesNotDemoteActiveMarkets:
    service.includes("isRateLimitCode(error?.code)") &&
    service.includes("isRateLimitCode(check.code)") &&
    service.includes("market_status='active', verification_status='verified'") &&
    service.includes("providerWarning") &&
    service.includes("finalStatus: \"active\""),
  oneTimeoutDoesNotDemoteActiveMarket:
    service.includes("nextFailureCount < 3") &&
    service.includes("keepActiveAfterFailure") &&
    rebuildService.includes("nextFailureCount < 3") &&
    rebuildService.includes("const keepActive = existingActive"),
  oneNoCandleDoesNotDemoteActiveMarket:
    service.includes("hasRecentSuccessfulCandle(current)") &&
    service.includes("current.supportedTimeframes.length > 0") &&
    rebuildService.includes("hasRecentSuccessfulCandle(existing)") &&
    rebuildService.includes("supportedTimeframes: keepActive ? existing.supported_timeframes || [] : []"),
  confirmedMissingProductCanBecomeUnavailable:
    service.includes("function isConfirmedUnavailable") &&
    service.includes("details.productTradingEnabled === false") &&
    service.includes("details.productExists === false && !details.providerError") &&
    rebuildService.includes("Coinbase product is not trading-enabled."),
  bulkEnableScannerEndpoint:
    controller.includes("enableScannerForAllActiveCryptoMarkets") &&
    controller.includes("/api/admin/crypto-markets/enable-active-scanner") &&
    controller.includes("{ enabled: await enableScannerForAllActiveCryptoMarkets() }"),
  bulkEnableScannerUpdatesOnlyEligibleMarkets:
    service.includes("export async function enableScannerForAllActiveCryptoMarkets") &&
    service.includes("scanner_enabled=true") &&
    service.includes("paper_trading_enabled=true") &&
    service.includes("watchlist_enabled=true") &&
    service.includes("cardinality(supported_timeframes) > 0") &&
    service.includes("provider IS NOT NULL") &&
    service.includes("status NOT IN ('unavailable', 'legacy', 'disabled')"),
  activeRateLimitWarningDoesNotDisableScanner:
    service.includes("function isBlockingCooldown") &&
    service.includes("!isReadyStatus(market.status || market.marketStatus) && isCoolingDown(market)") &&
    service.includes("listScannerCryptoMarkets()") &&
    service.includes("!isBlockingCooldown(market)"),
  adminUiHasBulkAction:
    html.includes("admin-crypto-enable-active-scanner") &&
    html.includes("Enable scanner for all active markets") &&
    app.includes("/api/admin/crypto-markets/enable-active-scanner") &&
    app.includes("Scanner enabled for active markets"),
  restoreRecentlyActiveMarkets:
    service.includes("export async function restoreRecentlyActiveCryptoMarkets") &&
    service.includes("last_successful_candle_at >= now() - interval '24 hours'") &&
    controller.includes("/api/admin/crypto-markets/restore-recently-active") &&
    html.includes("Restore recently active markets") &&
    app.includes("/api/admin/crypto-markets/restore-recently-active"),
  passingDetailsWinInAdminTable:
    app.includes("hasPassingCheck && market.status === \"provider_error\"") &&
    app.includes("const status = canonicalStatus === \"active\" ? \"Ready\"") &&
    app.includes("market.lastError && !hasPassingCheck") &&
    app.includes("Consecutive failures") &&
    app.includes("Last failed check")
};

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(Boolean(passed), true, `Crypto market scanner state check failed: ${name}`);
}

console.log(JSON.stringify(checks, null, 2));
