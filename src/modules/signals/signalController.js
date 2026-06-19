import { readJson, sendError, sendJson } from "../../shared/http.js";
import { detectMatchingAlerts } from "../alerts/alertService.js";
import { enqueueMatchingTelegramNotifications } from "../notifications/notificationService.js";
import {
  createSignal,
  listUserSignals,
  scanAllMarketsDetailed,
  scanMarketSetupDetailed
} from "./signalService.js";

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
      const result = await scanMarketSetupDetailed(body);

      if (result.fullSetup) {
        await enqueueMatchingTelegramNotifications(req.user, [result.fullSetup]);
      }

      return sendJson(res, 200, result.publicResult);
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/signals/scan-all" && req.method === "POST") {
    const result = await scanAllMarketsDetailed();
    const detectedAlerts = await detectMatchingAlerts(req.user, result.publicResult.setups);
    const queuedTelegramAlerts = await enqueueMatchingTelegramNotifications(req.user, result.fullSetups);
    return sendJson(res, 200, {
      ...result.publicResult,
      detectedAlerts,
      queuedTelegramAlerts: queuedTelegramAlerts.length
    });
  }

  if (pathname === "/api/signals/generate" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const result = await createSignal(req.user, body);
      return sendJson(res, result.signal ? 201 : 200, result);
    } catch (error) {
      return sendError(res, error.code === "TRIAL_LIMIT" ? 402 : error.statusCode || 400, error.message, {
        subscription: error.subscription
      });
    }
  }

  return false;
}
