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
const manualCrypto = marketData.getManualScannerUniverse({ marketType: "crypto" });
const manualCommodities = marketData.getManualScannerUniverse({ marketType: "commodities" });
const autoMarkets = marketData.listAutoScannerPairs();

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const signalController = readFileSync(new URL("../src/modules/signals/signalController.js", import.meta.url), "utf8");
const signalService = readFileSync(new URL("../src/modules/signals/signalService.js", import.meta.url), "utf8");
const marketDataService = readFileSync(new URL("../src/modules/market-data/marketDataService.js", import.meta.url), "utf8");

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
  autoScanCryptoOnly:
    appConfig.autoScan.cryptoOnly === true &&
    autoMarkets.length > 0 &&
    autoMarkets.every((pair) => pair.category === "Crypto"),
  watcherDisabledDoesNotBlockManual:
    appConfig.autoScan.cryptoWatcherEnabled === false &&
    manualAll.markets.length > 0,
  noSilentTwentyFourCap:
    appConfig.manualScan.maxMarkets === 200 &&
    !signalService.includes("slice(0, 24)") &&
    !marketDataService.includes("slice(0, 24)") &&
    marketDataService.includes("appConfig.manualScan.maxMarkets"),
  skippedReasonsPresent:
    manualAll.skipped.every((item) => item.reasonCode && item.reason),
  providerRoutingPreserved:
    manualAll.markets
      .filter((pair) => pair.category === "Crypto")
      .every((pair) => pair.provider === "coinbase-exchange") &&
    manualAll.markets
      .filter((pair) => pair.category === "Commodities")
      .every((pair) => pair.provider === "twelve-data"),
  unsupportedMarketsNotReady:
    manualAll.skipped.some((item) => ["provider_not_configured", "market_type_excluded", "scanner_disabled"].includes(item.reasonCode)),
  frontendSelectorPresent:
    html.includes('id="scanner-market-type"') &&
    app.includes("getManualScanMarkets") &&
    app.includes("body: JSON.stringify({ marketType })"),
  summaryCountsPresent:
    html.includes('id="scan-summary-skipped"') &&
    html.includes('id="scan-summary-provider-errors"') &&
    html.includes('id="scan-summary-no-data"') &&
    app.includes("skippedMarkets") &&
    app.includes("scanUniverse"),
  backendReadsMarketType:
    signalController.includes("scanAllMarkets(req.user, body)") &&
    signalService.includes("scan-all:${universe.signature}") &&
    signalService.includes("manual_universe")
};

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(Boolean(passed), true, `Manual scanner market coverage check failed: ${name}`);
}

console.log(JSON.stringify({
  ...checks,
  manualSelected: manualAll.markets.length,
  cryptoSelected: manualCrypto.markets.length,
  commoditiesSelected: manualCommodities.markets.length,
  autoSelected: autoMarkets.length,
  skipped: manualAll.skipped.length
}, null, 2));
