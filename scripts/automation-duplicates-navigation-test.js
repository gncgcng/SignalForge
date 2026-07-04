import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appConfig = readFileSync(new URL("../src/config/appConfig.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const autoScan = readFileSync(new URL("../src/modules/alerts/autoScanService.js", import.meta.url), "utf8");
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const signalService = readFileSync(new URL("../src/modules/signals/signalService.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/022_signal_setup_key_idempotency.sql", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

const checks = {
  autoScanConfig:
    appConfig.includes("AUTO_SCAN_INTERVAL_MS") &&
    appConfig.includes("AUTO_SCAN_DUPLICATE_COOLDOWN_MS") &&
    appConfig.includes("intervalMs"),
  autoScanStarted:
    server.includes("startAutoCryptoAlertScanner") &&
    autoScan.includes("[auto-scan] started") &&
    autoScan.includes("[auto-scan] matched alert") &&
    autoScan.includes('const scope = settings.favoriteMarketsOnly ? "watchlist" : "all_crypto"') &&
    autoScan.includes("[auto-scan] scope=${scope}") &&
    autoScan.includes("[auto-scan] markets selected") &&
    autoScan.includes("[auto-scan] telegram alert sent") &&
    autoScan.includes("[auto-scan] markets scanned") &&
    autoScan.includes("[auto-scan] alerts created") &&
    autoScan.includes("[auto-scan] skipped duplicates"),
  cryptoOnlyAutoScan:
    autoScan.includes('pair?.category === "Crypto"') &&
    !autoScan.includes("Twelve") &&
    !autoScan.includes("Commodities"),
  preferenceScopedAutoScan:
    autoScan.includes("listAllEnabledAlertPreferences") &&
    autoScan.includes("listAllEnabledTelegramSettings") &&
    autoScan.includes("scanMarketSetupDetailed(user") &&
    autoScan.includes("preference.symbol") &&
    autoScan.includes("preference.timeframe"),
  alertDuplicateCooldown:
    repositories.includes("hasRecentDetectedAlert") &&
    repositories.includes("AND setup_id = $2") &&
    repositories.includes("idx_detected_alerts_cooldown") === false &&
    migration.includes("idx_detected_alerts_cooldown") &&
    autoScan.includes("hasRecentDetectedAlert"),
  unlockIdempotency:
    migration.includes("ADD COLUMN IF NOT EXISTS setup_key") &&
    migration.includes("idx_saved_signals_user_setup_key") &&
    repositories.includes("pg_advisory_xact_lock") &&
    repositories.includes("WHERE s.user_id = $1 AND s.setup_key = $2 LIMIT 1") &&
    repositories.includes("alreadyUnlocked = true") &&
    signalService.includes("!savedSignal?.alreadyUnlocked"),
  groupedNavigation:
    ["Trading", "Alerts", "Research", "Portfolio", "Growth", "Account"].every((label) => html.includes(`>${label}</button>`)) &&
    app.includes("NAV_SECTIONS_KEY") &&
    app.includes("renderNavSections()") &&
    css.includes(".nav-section.collapsed .nav-section-links") &&
    css.includes(".nav-section:has(a.active) .nav-section-toggle"),
  backtestingUxStates:
    html.includes('id="lab-empty-state"') &&
    html.includes('id="lab-loading-state"') &&
    html.includes('id="lab-results"') &&
    app.includes("labLoadingState.classList.remove(\"hidden\")") &&
    app.includes("labResults.classList.remove(\"hidden\")") &&
    css.includes(".lab-empty-state")
};

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(passed, true, `Automation/navigation check failed: ${name}`);
}

console.log(JSON.stringify(checks, null, 2));
