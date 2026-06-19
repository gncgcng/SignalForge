import { readFileSync } from "node:fs";
import { preferenceMatchesSetup } from "../src/modules/alerts/alertService.js";

const migration = readFileSync(new URL("../migrations/004_watchlists_and_alerts.sql", import.meta.url), "utf8");
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const preference = {
  symbol: "XAU/USD",
  timeframe: "4h",
  direction: "both",
  minimum_confidence: 80
};
const matchingSetup = {
  id: "sig_match",
  symbol: "XAU/USD",
  timeframe: "4h",
  direction: "long",
  confidenceScore: 86
};

const result = {
  persistentTablesCreated: ["watchlist_markets", "alert_preferences", "detected_alerts"]
    .every((table) => migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`)),
  userScopedKeys: migration.includes("PRIMARY KEY (user_id, symbol)") &&
    migration.includes("UNIQUE (user_id, symbol)") &&
    migration.includes("UNIQUE (user_id, preference_id, setup_id)"),
  repositoriesScopeByUser: repositories.includes("WHERE w.user_id = $1") &&
    repositories.includes("WHERE user_id = $1") &&
    repositories.includes("WHERE id = $1 AND user_id = $2"),
  matchingPreferenceDetected: preferenceMatchesSetup(preference, matchingSetup),
  confidenceThresholdEnforced: !preferenceMatchesSetup(preference, {
    ...matchingSetup,
    confidenceScore: 79
  }),
  timeframeEnforced: !preferenceMatchesSetup(preference, {
    ...matchingSetup,
    timeframe: "1h"
  }),
  directionEnforced: !preferenceMatchesSetup({ ...preference, direction: "short" }, matchingSetup),
  scanAllCreatesAlerts: app.includes("/api/signals/scan-all") &&
    signalControllerIncludesAlertDetection(),
  creditsOnlyUsedOnUnlock: !app.slice(
    app.indexOf("scanAllButton.addEventListener"),
    app.indexOf("generateButton.addEventListener")
  ).includes("/api/signals/generate"),
  unreadSidebarCount: html.includes("unread-alert-count") && app.includes("renderUnreadAlertCount"),
  watchlistAndAlertsViews: html.includes('data-view="watchlist"') && html.includes('data-view="alerts"'),
  bothAssetClassesRemainAvailable: app.includes("state.marketCatalog.filter((pair) => pair.status === \"active\")")
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}

function signalControllerIncludesAlertDetection() {
  const controller = readFileSync(
    new URL("../src/modules/signals/signalController.js", import.meta.url),
    "utf8"
  );
  return controller.includes("detectMatchingAlerts") &&
    controller.includes("enqueueMatchingTelegramNotifications");
}
