import { readJson, sendError, sendJson } from "../../shared/http.js";
import { enterPaperTrade, getPaperPortfolio } from "./paperTradingService.js";

export async function handlePaperTradingRoutes(req, res, pathname) {
  if (!pathname.startsWith("/api/paper-trades")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  if (pathname === "/api/paper-trades" && req.method === "GET") {
    try {
      return sendJson(res, 200, await getPaperPortfolio(req.user));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/paper-trades" && req.method === "POST") {
    try {
      const body = await readJson(req);
      return sendJson(res, 201, await enterPaperTrade(req.user, body.signalId));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  return false;
}
