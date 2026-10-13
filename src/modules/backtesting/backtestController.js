import { hasPaidAccess } from "../subscriptions/subscriptionService.js";
import { readJson, sendError, sendJson } from "../../shared/http.js";
import { runHistoricalBacktest } from "./backtestService.js";

export async function handleBacktestRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/backtesting")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }
  // Paid plan only (trial, active or past due), checked on the server.
  if (!hasPaidAccess(req.user)) {
    return sendError(res, 402, "The backtesting lab is part of the SignalForge plan. Start your 7-day free trial to use it.", { code: "PAID_ACCESS_REQUIRED" });
  }

  if (pathname === "/api/backtesting" && req.method === "GET") {
    try {
      return sendJson(res, 200, {
        backtest: await runHistoricalBacktest(req.user, {
          symbol: url.searchParams.get("symbol") || "",
          timeframe: url.searchParams.get("timeframe") || ""
        })
      });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/backtesting/run" && req.method === "POST") {
    try {
      const body = await readJson(req);
      return sendJson(res, 200, {
        backtest: await runHistoricalBacktest(req.user, body)
      });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  return false;
}
