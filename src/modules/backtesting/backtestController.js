import { readJson, sendError, sendJson } from "../../shared/http.js";
import { runHistoricalBacktest } from "./backtestService.js";

export async function handleBacktestRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/backtesting")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
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
