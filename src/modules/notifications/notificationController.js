import { readJson, sendError, sendJson } from "../../shared/http.js";
import {
  connectTelegram,
  disconnectTelegram,
  getNotificationSettings,
  sendTelegramTestAlert,
  toggleTelegramNotifications,
  updateTelegramSettings
} from "./notificationService.js";
import {
  getTelegramConnectionStatus,
  startTelegramConnection
} from "./telegramConnectionService.js";
import { assertPaidAccess } from "../subscriptions/subscriptionService.js";

// Telegram alerts are part of the paid plan. Reading the settings, turning alerts off and disconnecting stay open
// to everyone, so nobody is stuck with a connection they can't remove.
const PAID_TELEGRAM_ROUTES = new Set([
  "POST /api/notifications/telegram/connect",
  "POST /api/notifications/telegram/connect/start",
  "GET /api/notifications/telegram/connect/status",
  "POST /api/notifications/telegram/test",
  "PUT /api/notifications/telegram/preferences"
]);

export async function handleNotificationRoutes(req, res, pathname) {
  if (!pathname.startsWith("/api/notifications")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  try {
    if (PAID_TELEGRAM_ROUTES.has(`${req.method} ${pathname}`)) {
      assertPaidAccess(req.user, "Telegram alerts are part of the SignalForge plan. Start your 7-day free trial to turn them on.");
    }
    if (pathname === "/api/notifications/telegram" && req.method === "GET") {
      return sendJson(res, 200, await getNotificationSettings(req.user));
    }

    if (pathname === "/api/notifications/telegram" && req.method === "DELETE") {
      return sendJson(res, 200, await disconnectTelegram(req.user));
    }

    if (pathname === "/api/notifications/telegram/connect" && req.method === "POST") {
      return sendJson(res, 200, await connectTelegram(req.user, await readJson(req)));
    }

    if (pathname === "/api/notifications/telegram/connect/start" && req.method === "POST") {
      return sendJson(res, 200, await startTelegramConnection(req.user));
    }

    if (pathname === "/api/notifications/telegram/connect/status" && req.method === "GET") {
      return sendJson(res, 200, await getTelegramConnectionStatus(req.user));
    }

    if (pathname === "/api/notifications/telegram/test" && req.method === "POST") {
      return sendJson(res, 200, await sendTelegramTestAlert(req.user));
    }

    if (pathname === "/api/notifications/telegram/preferences" && req.method === "PUT") {
      return sendJson(res, 200, await updateTelegramSettings(req.user, await readJson(req)));
    }

    if (pathname === "/api/notifications/telegram/enabled" && req.method === "PUT") {
      const body = await readJson(req);
      if (body.enabled) {
        assertPaidAccess(req.user, "Telegram alerts are part of the SignalForge plan. Start your 7-day free trial to turn them on.");
      }
      return sendJson(res, 200, await toggleTelegramNotifications(req.user, body.enabled));
    }
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.message, error.code ? { code: error.code } : undefined);
  }

  return false;
}
