import { sendError, sendJson } from "../../shared/http.js";
import { getMarketSnapshot, getOhlcv, listPairs } from "./marketDataService.js";

export async function handleMarketDataRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/market-data")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  if (pathname === "/api/market-data/pairs" && req.method === "GET") {
    return sendJson(res, 200, { pairs: listPairs(url.searchParams.get("q") || "") });
  }

  if (pathname === "/api/market-data/snapshot" && req.method === "GET") {
    try {
      return sendJson(res, 200, {
        snapshot: await getMarketSnapshot(
          url.searchParams.get("symbol") || "BTC-USD",
          url.searchParams.get("timeframe") || "15m"
        )
      });
    } catch (error) {
      return sendError(res, error.statusCode || 404, error.message);
    }
  }

  if (pathname === "/api/market-data/candles" && req.method === "GET") {
    try {
      return sendJson(res, 200, {
        marketData: await getOhlcv(
          url.searchParams.get("symbol") || "BTC-USD",
          url.searchParams.get("timeframe") || "15m"
        )
      });
    } catch (error) {
      return sendError(res, error.statusCode || 404, error.message);
    }
  }

  return false;
}
