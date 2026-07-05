import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repositories = readFileSync(
  new URL("../src/db/repositories.js", import.meta.url),
  "utf8"
);
const analyticsController = readFileSync(
  new URL("../src/modules/admin/analyticsController.js", import.meta.url),
  "utf8"
);
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

const result = {
  backendDashboardAggregate:
    repositories.includes("getAdminOperationsDashboard") &&
    repositories.includes("signalMonitor") &&
    repositories.includes("strategyAnalytics") &&
    repositories.includes("marketAnalytics") &&
    repositories.includes("telegram_notification_queue") &&
    repositories.includes("stripe_webhook_events") &&
    repositories.includes("buildAdminHealth"),
  backendUserSearch:
    repositories.includes("searchAdminUsers") &&
    repositories.includes("unlock_credits_balance") &&
    repositories.includes("telegram_connected_at") &&
    repositories.includes("public_profile_enabled") &&
    !repositories.includes("password_hash AS") &&
    !repositories.includes("sessions.id AS"),
  adminOnlyRoutes:
    analyticsController.includes('pathname !== "/api/admin/analytics"') &&
    analyticsController.includes('pathname !== "/api/admin/users/search"') &&
    analyticsController.includes("if (!req.user)") &&
    analyticsController.includes("if (!isAdminUser(req.user))") &&
    analyticsController.includes("getAdminOperationsDashboard()") &&
    analyticsController.includes("searchAdminUsers"),
  overviewUi:
    html.includes("SignalForge Admin Dashboard") &&
    html.includes('id="admin-health-grid"') &&
    html.includes('id="admin-overview-users"') &&
    html.includes('id="admin-overview-revenue"') &&
    html.includes('id="admin-overview-signals"') &&
    html.includes('id="admin-overview-system"'),
  monitorAndAnalyticsUi:
    html.includes('id="admin-signal-monitor"') &&
    html.includes('id="admin-rejection-pie"') &&
    html.includes('id="admin-strategy-analytics"') &&
    html.includes('id="admin-market-analytics"') &&
    app.includes("renderAdminSignalMonitor") &&
    app.includes("renderAdminStrategyAnalytics") &&
    app.includes("renderAdminMarketAnalytics"),
  telegramAffiliateStripeUi:
    html.includes('id="admin-telegram-metrics"') &&
    html.includes('id="admin-affiliate-metrics"') &&
    html.includes('id="admin-stripe-metrics"') &&
    html.includes('id="admin-error-logs"') &&
    app.includes("renderAdminTelegram") &&
    app.includes("renderAdminAffiliates") &&
    app.includes("renderAdminStripe") &&
    app.includes("renderAdminErrorLogs"),
  userSearchUi:
    html.includes('id="admin-user-search-form"') &&
    html.includes('id="admin-user-search-results"') &&
    app.includes("/api/admin/users/search") &&
    app.includes("renderAdminUserSearchResults"),
  mobileSafeStyling:
    css.includes(".admin-health-grid") &&
    css.includes(".admin-table-row") &&
    css.includes(".admin-user-result-grid") &&
    css.includes("@media (max-width: 760px)") &&
    css.includes(".admin-table-head") &&
    css.includes("grid-template-columns: 1fr"),
  sensitiveDataNotRendered:
    !html.includes("password_hash") &&
    !html.includes("restore_token") &&
    !app.includes("passwordHash") &&
    !app.includes("restoreTokenHash") &&
    !app.includes("session_id")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Admin dashboard check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
