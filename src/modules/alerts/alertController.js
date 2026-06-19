import { readJson, sendError, sendJson } from "../../shared/http.js";
import {
  detectMatchingAlerts,
  favoriteMarket,
  getAlerts,
  getWatchlist,
  markAlertRead,
  saveAlertPreference,
  unfavoriteMarket
} from "./alertService.js";

export async function handleAlertRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/alerts") && !pathname.startsWith("/api/watchlist")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  try {
    if (pathname === "/api/watchlist" && req.method === "GET") {
      return sendJson(res, 200, await getWatchlist(req.user));
    }

    if (pathname === "/api/watchlist" && req.method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 200, await favoriteMarket(req.user, body.symbol));
    }

    if (pathname === "/api/watchlist" && req.method === "DELETE") {
      return sendJson(res, 200, await unfavoriteMarket(req.user, url.searchParams.get("symbol")));
    }

    if (pathname === "/api/alerts/preferences" && req.method === "PUT") {
      return sendJson(res, 200, await saveAlertPreference(req.user, await readJson(req)));
    }

    if (pathname === "/api/alerts" && req.method === "GET") {
      return sendJson(res, 200, await getAlerts(req.user));
    }

    if (pathname === "/api/alerts/detect" && req.method === "POST") {
      const body = await readJson(req);
      const detected = await detectMatchingAlerts(req.user, Array.isArray(body.setups) ? body.setups : []);
      return sendJson(res, 200, { detected });
    }

    const readMatch = pathname.match(/^\/api\/alerts\/([^/]+)\/read$/);

    if (readMatch && req.method === "POST") {
      return sendJson(res, 200, await markAlertRead(req.user, readMatch[1]));
    }
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.message);
  }

  return false;
}
