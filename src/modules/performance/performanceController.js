import { sendError, sendJson } from "../../shared/http.js";
import { getPerformance } from "./performanceService.js";

export async function handlePerformanceRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/performance")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  if (pathname === "/api/performance" && req.method === "GET") {
    try {
      return sendJson(res, 200, {
        performance: await getPerformance(req.user, {
          from: url.searchParams.get("from") || "",
          to: url.searchParams.get("to") || "",
          symbol: url.searchParams.get("symbol") || "",
          timeframe: url.searchParams.get("timeframe") || ""
        })
      });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  return false;
}
