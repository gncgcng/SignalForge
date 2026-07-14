import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { appConfig, logEmailConfiguration, logStripeConfiguration } from "./config/appConfig.js";
import { verifyDatabaseConnection } from "./db/client.js";
import { runPendingMigrations, verifySessionSchema } from "./db/migrations.js";
import { attachAuth } from "./middleware/authMiddleware.js";
import { handleAdminAnalyticsRoutes } from "./modules/admin/analyticsController.js";
import { handleAuthRoutes } from "./modules/auth/authController.js";
import { handleBacktestRoutes } from "./modules/backtesting/backtestController.js";
import { handleAlertRoutes } from "./modules/alerts/alertController.js";
import { startAutoCryptoAlertScanner } from "./modules/alerts/autoScanService.js";
import { handleAffiliateRoutes } from "./modules/affiliates/affiliateController.js";
import { handleMarketDataRoutes } from "./modules/market-data/marketDataController.js";
import { handleJournalRoutes } from "./modules/journal/journalController.js";
import { handleIntelligenceRoutes } from "./modules/intelligence/intelligenceController.js";
import { handleLeaderboardRoutes } from "./modules/leaderboards/leaderboardController.js";
import { recalculateLeaderboardStats } from "./modules/leaderboards/leaderboardService.js";
import { handleNotificationRoutes } from "./modules/notifications/notificationController.js";
import { handlePaperTradingRoutes } from "./modules/paper-trading/paperTradingController.js";
import { handlePerformanceRoutes } from "./modules/performance/performanceController.js";
import { handleProfileRoutes } from "./modules/profiles/profileController.js";
import { startTelegramNotificationQueue } from "./modules/notifications/notificationQueue.js";
import { startTelegramConnectionPoller } from "./modules/notifications/telegramConnectionService.js";
import { handleSignalRoutes } from "./modules/signals/signalController.js";
import { startSignalOutcomeTracker } from "./modules/signals/signalOutcomeService.js";
import { handleSubscriptionRoutes } from "./modules/subscriptions/subscriptionController.js";
import { handleSupportRoutes } from "./modules/support/supportController.js";
import { handleTesterAccessRoutes } from "./modules/tester-access/testerAccessController.js";
import { sendError, sendJson } from "./shared/http.js";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(rootDir, "public");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Static boot assets must never depend on PostgreSQL session availability.
  if (!url.pathname.startsWith("/api/")) {
    return serveStatic(url.pathname, res);
  }

  try {
    if (requiresAuthAttachment(url.pathname)) {
      try {
        await withTimeout(attachAuth(req), 2000, "auth_check_timeout");
      } catch (error) {
        console.warn(`[auth] Request authentication failed reason=${safeServerReason(error)}`);
        if (url.pathname === "/api/auth/session") {
          return sendJson(res, 500, { ok: false, error: "auth_check_failed" }, {
            "cache-control": "no-store, private"
          });
        }
        return sendError(res, 500, "Authentication check failed.");
      }
    } else {
      req.user = null;
      req.sessionId = null;
      req.sessionCookiePresent = false;
    }

    const handled =
      (await handleAuthRoutes(req, res, url.pathname)) ||
      (await handleAdminAnalyticsRoutes(req, res, url.pathname)) ||
      (await handleAffiliateRoutes(req, res, url.pathname)) ||
      (await handleAlertRoutes(req, res, url.pathname, url)) ||
      (await handleNotificationRoutes(req, res, url.pathname)) ||
      (await handlePaperTradingRoutes(req, res, url.pathname, url)) ||
      (await handleSubscriptionRoutes(req, res, url.pathname)) ||
      (await handleSupportRoutes(req, res, url.pathname, url)) ||
      (await handleTesterAccessRoutes(req, res, url.pathname)) ||
      (await handleMarketDataRoutes(req, res, url.pathname, url)) ||
      (await handleIntelligenceRoutes(req, res, url.pathname)) ||
      (await handleJournalRoutes(req, res, url.pathname, url)) ||
      (await handleBacktestRoutes(req, res, url.pathname, url)) ||
      (await handlePerformanceRoutes(req, res, url.pathname, url)) ||
      (await handleProfileRoutes(req, res, url.pathname)) ||
      (await handleLeaderboardRoutes(req, res, url.pathname)) ||
      (await handleSignalRoutes(req, res, url.pathname));

    if (handled !== false) {
      return;
    }

    return sendError(res, 404, "API route not found.");
  } catch (error) {
    return sendError(
      res,
      error.statusCode || 500,
      error.statusCode ? error.message : "Unexpected server error.",
      error.statusCode ? undefined : error.message
    );
  }
});

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    return sendError(res, 403, "Forbidden.");
  }

  try {
    const file = await readFile(filePath);
    const headers = {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream"
    };
    if (pathname === "/service-worker.js") {
      headers["cache-control"] = "no-cache, no-store, must-revalidate";
      headers["service-worker-allowed"] = "/";
    } else if ([".html", ".js", ".css"].includes(extname(filePath))) {
      headers["cache-control"] = "no-cache, no-store, must-revalidate";
    }
    res.writeHead(200, {
      ...headers
    });
    res.end(file);
  } catch {
    if (extname(pathname)) {
      return sendError(res, 404, "Static asset not found.");
    }
    const index = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, {
      "content-type": mimeTypes[".html"],
      "cache-control": "no-cache, no-store, must-revalidate"
    });
    res.end(index);
  }
}

function requiresAuthAttachment(pathname) {
  return ![
    "/api/auth/config",
    "/api/auth/login",
    "/api/auth/google/start",
    "/api/auth/google/callback",
    "/api/auth/demo",
    "/api/auth/restore",
    "/api/auth/verify-email",
    "/api/auth/password-reset/request",
    "/api/auth/password-reset/confirm"
  ].includes(pathname);
}

function withTimeout(promise, timeoutMs, code) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error("Operation timed out.");
      error.code = code;
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function safeServerReason(error) {
  return String(error?.code || error?.name || "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64);
}

logStripeConfiguration();
logEmailConfiguration();
await verifyDatabaseConnection();
await runPendingMigrations();
await verifySessionSchema();

server.listen(appConfig.port, () => {
  console.log(`${appConfig.appName} running at http://localhost:${appConfig.port}`);
  startSignalOutcomeTracker();
  startAutoCryptoAlertScanner();
  startTelegramNotificationQueue();
  startTelegramConnectionPoller();
  recalculateLeaderboardStats().catch((error) => {
    console.warn(`[leaderboard] recalculation failed: ${error.message}`);
  });
});
