import { readJson, sendError, sendJson } from "../../shared/http.js";
import { detectMatchingAlerts } from "../alerts/alertService.js";
import { enqueueMatchingTelegramNotifications } from "../notifications/notificationService.js";
import {
  createSignal,
  listUserSignals,
  scanAllMarkets,
  scanMarketSetup
} from "./signalService.js";

// scanMarketSetupDetailed stays service-private so Telegram receives full setups
// without exposing locked price levels in scan responses.

export async function handleSignalRoutes(req, res, pathname) {
  if (!pathname.startsWith("/api/signals")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  if (pathname === "/api/signals" && req.method === "GET") {
    return sendJson(res, 200, await listUserSignals(req.user));
  }

  if (pathname === "/api/signals/scan" && req.method === "POST") {
    try {
      const body = await readJson(req);
      return sendJson(res, 200, await scanMarketSetup(req.user, body));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message, {
        subscription: error.subscription
      });
    }
  }

  if (pathname === "/api/signals/scan-all" && req.method === "POST") {
    try {
      const result = await scanAllMarkets(req.user);
      const detectedAlerts = await detectMatchingAlerts(req.user, result.setups);
      const queuedTelegramAlerts = await enqueueMatchingTelegramNotifications(
        req.user,
        result.fullSetups
      );
      const { fullSetups, ...publicResult } = result;
      return sendJson(res, 200, {
        ...publicResult,
        detectedAlerts,
        queuedTelegramAlerts: queuedTelegramAlerts.length
      });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message, {
        subscription: error.subscription
      });
    }
  }

  if (pathname === "/api/signals/generate" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const result = await createSignal(req.user, body);
      return sendJson(res, result.signal ? 201 : 200, result);
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message, {
        subscription: error.subscription
      });
    }
  }

  return false;
}
