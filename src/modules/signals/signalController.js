import { readJson, sendError, sendJson } from "../../shared/http.js";
import { createSignal, listUserSignals, scanAllMarkets, scanMarketSetup } from "./signalService.js";

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
      return sendJson(res, 200, await scanMarketSetup(body));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/signals/scan-all" && req.method === "POST") {
    return sendJson(res, 200, await scanAllMarkets());
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
