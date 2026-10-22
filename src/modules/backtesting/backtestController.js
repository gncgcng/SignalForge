import { hasPaidAccess } from "../subscriptions/subscriptionService.js";
import { readJson, sendError, sendJson } from "../../shared/http.js";
import { listBacktestMarkets, runHistoricalBacktest } from "./backtestService.js";
import { hasFeatureRequest, recordFeatureRequest } from "./featureRequestService.js";

export async function handleBacktestRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/backtesting")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  // "Want stocks & ETFs? Tell us": any signed-in user, counted once per user.
  if (pathname === "/api/backtesting/stocks-request") {
    if (req.method === "GET") {
      return sendJson(res, 200, { requested: await hasFeatureRequest(req.user.id) });
    }
    if (req.method === "POST") {
      return sendJson(res, 200, await recordFeatureRequest(req.user.id));
    }
    return false;
  }

  // Paid plan only (trial, active or past due), checked on the server.
  if (!hasPaidAccess(req.user)) {
    return sendError(res, 402, "The backtesting lab is part of the SignalForge plan. Start your 7-day free trial to use it.", { code: "PAID_ACCESS_REQUIRED" });
  }

  if (pathname === "/api/backtesting/markets" && req.method === "GET") {
    return sendJson(res, 200, {
      markets: listBacktestMarkets(),
      stocksRequested: await hasFeatureRequest(req.user.id)
    });
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

  // With "accept: application/x-ndjson" the run streams one line per candle load ({"type":"progress","loaded","total"})
  // and ends with {"type":"result","backtest"} or {"type":"error"}. Errors raised before the first load (bad input,
  // too many pairs, busy) keep their HTTP status. The steady output also keeps the proxy's idle timeout away.
  if (pathname === "/api/backtesting/run" && req.method === "POST") {
    const stream = String(req.headers?.accept || "").includes("application/x-ndjson");
    let streaming = false;
    const writeLine = (line) => res.write(`${JSON.stringify(line)}\n`);
    try {
      const body = await readJson(req);
      const onProgress = stream ? (progress) => {
        if (!streaming) {
          streaming = true;
          res.writeHead(200, {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no"
          });
        }
        writeLine({ type: "progress", ...progress });
      } : undefined;
      const backtest = await runHistoricalBacktest(req.user, body, { onProgress });
      if (!streaming) return sendJson(res, 200, { backtest });
      writeLine({ type: "result", backtest });
      res.end();
      return true;
    } catch (error) {
      if (!streaming) return sendError(res, error.statusCode || 400, error.message);
      writeLine({ type: "error", statusCode: error.statusCode || 400, message: error.message });
      res.end();
      return true;
    }
  }

  return false;
}
