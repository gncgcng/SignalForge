import { hasPaidAccess } from "../subscriptions/subscriptionService.js";
import { sendError, sendJson } from "../../shared/http.js";
import { getPerformance } from "./performanceService.js";

export async function handlePerformanceRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/performance")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }
  // Paid plan only (trial, active or past due), checked on the server.
  if (!hasPaidAccess(req.user)) {
    return sendError(res, 402, "The performance page is part of the SignalForge plan. Start your 7-day free trial to use it.", { code: "PAID_ACCESS_REQUIRED" });
  }

  if (pathname === "/api/performance" && req.method === "GET") {
    try {
      return sendJson(res, 200, {
        performance: await getPerformance(req.user, {
          from: url.searchParams.get("from") || "",
          to: url.searchParams.get("to") || "",
          symbol: url.searchParams.get("symbol") || "",
          timeframe: url.searchParams.get("timeframe") || "",
          direction: url.searchParams.get("direction") || "",
          status: url.searchParams.get("status") || "",
          session: url.searchParams.get("session") || "",
          newsRisk: url.searchParams.get("newsRisk") || ""
        })
      });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  return false;
}
