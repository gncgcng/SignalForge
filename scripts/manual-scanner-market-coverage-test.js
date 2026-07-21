import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY || "test-key";
process.env.TWELVEDATA_MANUAL_SCAN_ENABLED = "true";
process.env.AUTO_SCAN_CRYPTO_ONLY = "true";
process.env.CRYPTO_WATCHER_ENABLED = "false";
process.env.MANUAL_SCAN_MAX_MARKETS = "200";

const marketData = await import("../src/modules/market-data/marketDataService.js");
const { appConfig } = await import("../src/config/appConfig.js");

const manualAll = marketData.getManualScannerUniverse({ marketType: "all" });
const manualDefault = marketData.getManualScannerUniverse();
const manualCapitalizedCrypto = marketData.getManualScannerUniverse({ marketType: "Crypto" });
const manualCrypto = marketData.getManualScannerUniverse({ marketType: "crypto" });
const manualCommodities = marketData.getManualScannerUniverse({ marketType: "commodities" });
const autoMarkets = marketData.listAutoScannerPairs();

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const signalController = readFileSync(new URL("../src/modules/signals/signalController.js", import.meta.url), "utf8");
const signalService = readFileSync(new URL("../src/modules/signals/signalService.js", import.meta.url), "utf8");
const marketDataService = readFileSync(new URL("../src/modules/market-data/marketDataService.js", import.meta.url), "utf8");
const appConfigSource = readFileSync(new URL("../src/config/appConfig.js", import.meta.url), "utf8");

const checks = {
  manualIncludesCryptoAndCommodities:
    manualAll.markets.some((pair) => pair.category === "Crypto") &&
    manualAll.markets.some((pair) => pair.category === "Commodities"),
  cryptoFilterOnlyCrypto:
    manualCrypto.markets.length > 0 &&
    manualCrypto.markets.every((pair) => pair.category === "Crypto"),
  commoditiesFilterOnlyCommodities:
    manualCommodities.markets.length > 0 &&
    manualCommodities.markets.every((pair) => pair.category === "Commodities"),
  defaultMarketTypeIsAll:
    manualDefault.marketType === "all" &&
    manualDefault.markets.some((pair) => pair.category === "Crypto") &&
    manualDefault.markets.some((pair) => pair.category === "Commodities"),
  marketTypeCapitalizationDoesNotExcludeCrypto:
    manualCapitalizedCrypto.marketType === "crypto" &&
    manualCapitalizedCrypto.markets.some((pair) => pair.symbol === "BTC-USD" || pair.symbol === "ETH-USD" || pair.symbol === "SOL-USD"),
  statusCapitalizationSupported:
    marketDataService.includes("function isReadyStatus") &&
    marketDataService.includes("\"ready\"") &&
    readFileSync(new URL("../src/modules/markets/cryptoMarketService.js", import.meta.url), "utf8").includes("function isReadyStatus"),
  autoScanCryptoOnly:
    appConfig.autoScan.cryptoOnly === true &&
    autoMarkets.length > 0 &&
    autoMarkets.every((pair) => pair.category === "Crypto"),
  watcherDisabledDoesNotBlockManual:
    appConfig.autoScan.cryptoWatcherEnabled === false &&
    manualAll.markets.length > 0,
  noSilentTwentyFourCap:
    appConfig.manualScan.maxMarkets === 200 &&
    appConfigSource.includes("Math.max(200, Number(process.env.MANUAL_SCAN_MAX_MARKETS || 200))") &&
    !signalService.includes("slice(0, 24)") &&
    !marketDataService.includes("slice(0, 24)") &&
    marketDataService.includes("appConfig.manualScan.maxMarkets"),
  selectedAndScannedCountsReported:
    Number(manualAll.summary.selectedMarkets) >= Number(manualAll.summary.scannedMarkets) &&
    "skippedByReason" in manualAll.summary &&
    signalService.includes("[manual-scan] scannedMarkets") &&
    signalService.includes("[manual-scan] skippedReasons") &&
    app.includes("selected ·") &&
    app.includes("scanned ·"),
  skippedReasonsPresent:
    manualAll.skipped.every((item) => item.reasonCode && item.reason),
  providerRoutingPreserved:
    manualAll.markets
      .filter((pair) => pair.category === "Crypto")
      .every((pair) => pair.provider === "coinbase-exchange") &&
    manualAll.markets
      .filter((pair) => pair.category === "Commodities")
      .every((pair) => pair.provider === "twelve-data"),
  providerExamplesPreserved:
    ["BTC-USD", "ETH-USD", "SOL-USD"].some((symbol) =>
      manualAll.markets.find((pair) => pair.symbol === symbol)?.provider === "coinbase-exchange"
    ) &&
    manualAll.markets.find((pair) => pair.symbol === "XAG/USD")?.provider === "twelve-data",
  unsupportedMarketsNotReady:
    manualAll.skipped.some((item) => ["provider_not_configured", "market_type_excluded", "scanner_disabled"].includes(item.reasonCode)),
  frontendSelectorPresent:
    html.includes('id="scanner-market-type"') &&
    app.includes("getManualScanMarkets") &&
    app.includes("body: JSON.stringify({ marketType })"),
  progressDenominatorUsesSelectedMarkets:
    app.includes("const total = markets.length") &&
    app.includes("Selected markets: Crypto"),
  summaryCountsPresent:
    html.includes('id="scan-summary-skipped"') &&
    html.includes('id="scan-summary-provider-errors"') &&
    html.includes('id="scan-summary-no-data"') &&
    app.includes("skippedMarkets") &&
    app.includes("scanUniverse"),
  adminDebugPanelPresent:
    app.includes("renderAdminScannerUniverseDebug") &&
    app.includes("Admin scanner debug") &&
    marketDataService.includes("firstSymbols") &&
    marketDataService.includes("autoScan"),
  backendReadsMarketType:
    signalController.includes("scanAllMarkets(req.user, body)") &&
    signalService.includes("scan-all:${universe.signature}") &&
    signalService.includes("manual_universe"),
  manualScanProofLogsPresent:
    signalService.includes("[manual-scan] selectedFilter=") &&
    signalService.includes("[manual-scan] activeMarkets") &&
    signalService.includes("[manual-scan] scannerEnabled") &&
    signalService.includes("[manual-scan] selectedMarkets") &&
    signalService.includes("[manual-scan] firstSymbols=") &&
    signalService.includes("provider=${market.provider")
};

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(Boolean(passed), true, `Manual scanner market coverage check failed: ${name}`);
}

console.log(JSON.stringify({
  ...checks,
  manualSelected: manualAll.markets.length,
  manualDefaultSelected: manualDefault.markets.length,
  cryptoSelected: manualCrypto.markets.length,
  capitalizedCryptoSelected: manualCapitalizedCrypto.markets.length,
  commoditiesSelected: manualCommodities.markets.length,
  autoSelected: autoMarkets.length,
  skipped: manualAll.skipped.length
}, null, 2));
