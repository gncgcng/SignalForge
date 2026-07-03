import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../migrations/021_product_analytics.sql", import.meta.url),
  "utf8"
);
const repositories = readFileSync(
  new URL("../src/db/repositories.js", import.meta.url),
  "utf8"
);
const analyticsService = readFileSync(
  new URL("../src/modules/analytics/productAnalyticsService.js", import.meta.url),
  "utf8"
);
const analyticsController = readFileSync(
  new URL("../src/modules/admin/analyticsController.js", import.meta.url),
  "utf8"
);
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const authService = readFileSync(
  new URL("../src/modules/auth/authService.js", import.meta.url),
  "utf8"
);
const googleOAuth = readFileSync(
  new URL("../src/modules/auth/googleOAuthService.js", import.meta.url),
  "utf8"
);
const signalService = readFileSync(
  new URL("../src/modules/signals/signalService.js", import.meta.url),
  "utf8"
);
const stripeService = readFileSync(
  new URL("../src/modules/subscriptions/stripeService.js", import.meta.url),
  "utf8"
);
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

const result = {
  migrationCreatesAggregateEvents:
    migration.includes("CREATE TABLE IF NOT EXISTS product_analytics_events") &&
    migration.includes("'signup'") &&
    migration.includes("'checkout_completed'") &&
    !migration.includes("email text") &&
    !migration.includes("ip_hash") &&
    !migration.includes("device_fingerprint"),
  repositoryWritesAndSummarizes:
    repositories.includes("recordProductAnalyticsEvent") &&
    repositories.includes("getAdminProductAnalytics") &&
    repositories.includes("monthly_recurring_revenue_cents") &&
    repositories.includes("mostScannedMarkets") &&
    repositories.includes("mostUnlockedMarkets"),
  safeTrackingWrapper:
    analyticsService.includes("trackProductEvent") &&
    analyticsService.includes("recordProductAnalyticsEvent(event)") &&
    analyticsService.includes("Event write failed"),
  signupTracking:
    authService.includes('eventType: "signup"') &&
    authService.includes('authProvider: "email"') &&
    googleOAuth.includes('eventType: "signup"') &&
    googleOAuth.includes('authProvider: "google"'),
  scanAndUnlockTracking:
    signalService.includes('eventType: "scan"') &&
    signalService.includes('eventType: "unlock"') &&
    signalService.includes("trackScanAllAnalytics") &&
    signalService.includes('mode: "scan_all"'),
  stripeTracking:
    stripeService.includes('eventType: "checkout_started"') &&
    stripeService.includes('eventType: "checkout_completed"') &&
    stripeService.includes('eventType: "subscription"') &&
    stripeService.includes('eventType: "affiliate_conversion"'),
  adminEndpointProtected:
    analyticsController.includes('pathname !== "/api/admin/analytics"') &&
    analyticsController.includes("isAdminUser(req.user)") &&
    server.includes("handleAdminAnalyticsRoutes"),
  adminDashboard:
    html.includes("Product analytics") &&
    html.includes('id="analytics-total-users"') &&
    html.includes('id="analytics-most-scanned"') &&
    app.includes('api.request("/api/admin/analytics")') &&
    app.includes("function renderAdminAnalytics()") &&
    css.includes(".admin-analytics-grid"),
  sensitiveDataMinimized:
    !migration.includes("payload") &&
    !repositories.includes("u.email AS") &&
    !app.includes("analytics-email")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Product analytics check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
