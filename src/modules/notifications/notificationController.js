import { readJson, sendError, sendJson } from "../../shared/http.js";
import {
  connectTelegram,
  getNotificationSettings,
  toggleTelegramNotifications,
  updateTelegramSettings
} from "./notificationService.js";

export async function handleNotificationRoutes(req, res, pathname) {
  if (!pathname.startsWith("/api/notifications")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  try {
    if (pathname === "/api/notifications/telegram" && req.method === "GET") {
      return sendJson(res, 200, await getNotificationSettings(req.user));
    }

    if (pathname === "/api/notifications/telegram/connect" && req.method === "POST") {
      return sendJson(res, 200, await connectTelegram(req.user, await readJson(req)));
    }

    if (pathname === "/api/notifications/telegram/preferences" && req.method === "PUT") {
      return sendJson(res, 200, await updateTelegramSettings(req.user, await readJson(req)));
    }

    if (pathname === "/api/notifications/telegram/enabled" && req.method === "PUT") {
      const body = await readJson(req);
      return sendJson(res, 200, await toggleTelegramNotifications(req.user, body.enabled));
    }
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.message);
  }

  return false;
}
