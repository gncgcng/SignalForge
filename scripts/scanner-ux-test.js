import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const marketDataService = readFileSync(
  new URL("../src/modules/market-data/marketDataService.js", import.meta.url),
  "utf8"
);
const coinbaseProvider = readFileSync(
  new URL("../src/modules/market-data/coinbaseMarketDataProvider.js", import.meta.url),
  "utf8"
);

const expandedSymbols = [
  "BCH-USD",
  "DOT-USD",
  "UNI-USD",
  "AAVE-USD",
  "MKR-USD",
  "ATOM-USD",
  "ETC-USD",
  "FIL-USD",
  "ICP-USD",
  "NEAR-USD",
  "ARB-USD",
  "OP-USD",
  "APT-USD",
  "SUI-USD",
  "SEI-USD",
  "INJ-USD",
  "HBAR-USD",
  "PEPE-USD",
  "SHIB-USD",
  "BONK-USD",
  "WIF-USD",
  "FLOKI-USD",
  "ENA-USD",
  "TIA-USD",
  "JUP-USD",
  "RNDR-USD",
  "RUNE-USD",
  "GRT-USD",
  "ALGO-USD",
  "XLM-USD",
  "MATIC-USD",
  "COMP-USD",
  "SAND-USD",
  "MANA-USD"
];

const checks = {
  expandedCryptoCatalog:
    expandedSymbols.every((symbol) => marketDataService.includes(`symbol: "${symbol}"`)) &&
    expandedSymbols.every((symbol) => coinbaseProvider.includes(`"${symbol}"`)),
  unsupportedPairsHandled:
    coinbaseProvider.includes("PROVIDER_UNSUPPORTED_MARKET") &&
    coinbaseProvider.includes("Coinbase does not support") &&
    app.includes("renderScanResults(result.setups, result.errors, result.diagnostics, result.scanSummary)"),
  scanSummaryVisible:
    html.includes('id="scan-summary-panel"') &&
    html.includes('id="view-opportunities-button"') &&
    app.includes("renderScanSummary(setups.length") &&
    css.includes(".scan-summary-panel"),
  compactCards:
    app.includes("compact-signal-card") &&
    app.includes("data-unlock-symbol") &&
    app.includes("data-signal-details") &&
    app.includes("renderScanCard(setup)"),
  viewDetailsExpandsOne:
    app.includes("state.expandedSignalKeys.has(key) ? new Set() : new Set([key])") &&
    app.includes("scrollToSignalKey(key)") &&
    app.includes('data-signal-key="${key}"'),
  unlockExpandsUnlockedSignal:
    app.includes("state.expandedSignalKeys = new Set([unlockedKey])") &&
    app.includes('navigateTo("signals"') &&
    app.includes("renderUnlockReveal()") &&
    app.includes("if (key) highlightSignalKey(key)") &&
    app.includes("Signal unlocked"),
  basicAdvancedModePersists:
    html.includes('id="scanner-mode-toggle"') &&
    app.includes("SCANNER_MODE_KEY") &&
    app.includes("getStoredScannerMode()") &&
    app.includes("localStorage.setItem(SCANNER_MODE_KEY, state.scannerMode)") &&
    app.includes("renderModeDetails(signal"),
  mobileAccordionLayout:
    css.includes("@media (max-width: 767px)") &&
    css.includes(".signals-grid") &&
    css.includes("grid-template-columns: 1fr") &&
    css.includes(".compact-actions"),
  creditsNotDeductedForScanning:
    app.includes("No unlock credits used yet") &&
    app.includes("No credits used") &&
    app.includes("Unlocking one will use a trial credit."),
  tradingViewSymbolDisplay:
    marketDataService.includes("displaySymbol") &&
    marketDataService.includes('pair.symbol.replace("-", "")') &&
    marketDataService.includes("providerLabel") &&
    app.includes("getDisplaySymbol(pair)") &&
    app.includes("getProviderSymbolLabel(pair)")
};

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(passed, true, `Scanner UX check failed: ${name}`);
}

console.log(JSON.stringify(checks, null, 2));
