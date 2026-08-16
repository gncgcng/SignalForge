import { readJson, sendError, sendJson } from "../../shared/http.js";
import {
  cancelPendingPaperOrder,
  closePaperPosition,
  enterPaperTrade,
  getPaperPortfolio,
  getPaperTradingTerminal,
  placePaperOrder,
  resetPaperTradingAccount
} from "./paperTradingService.js";
import { getSignalReview } from "../signal-review/signalReviewService.js";

export async function handlePaperTradingRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/paper-trades")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  const reviewMatch = pathname.match(/^\/api\/paper-trades\/signal-review\/([^/]+)$/);
  if (reviewMatch && req.method === "GET") {
    try {
      return sendJson(res, 200, await getSignalReview(req.user, decodeURIComponent(reviewMatch[1])));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/paper-trades" && req.method === "GET") {
    try {
      return sendJson(res, 200, await getPaperPortfolio(req.user));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/paper-trades/terminal" && req.method === "GET") {
    try {
      return sendJson(res, 200, await getPaperTradingTerminal(req.user, {
        symbol: url?.searchParams.get("symbol"),
        timeframe: url?.searchParams.get("timeframe"),
        reviewOnly: url?.searchParams.get("reviewOnly") === "1"
      }));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/paper-trades/orders" && req.method === "POST") {
    try {
      return sendJson(res, 201, await placePaperOrder(req.user, await readJson(req)));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  const closeMatch = pathname.match(/^\/api\/paper-trades\/orders\/([^/]+)\/close$/);
  if (closeMatch && req.method === "POST") {
    try {
      return sendJson(res, 200, await closePaperPosition(req.user, decodeURIComponent(closeMatch[1])));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  const cancelMatch = pathname.match(/^\/api\/paper-trades\/orders\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    try {
      return sendJson(res, 200, await cancelPendingPaperOrder(req.user, decodeURIComponent(cancelMatch[1])));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/paper-trades/reset" && req.method === "POST") {
    try {
      const body = await readJson(req);
      return sendJson(res, 200, await resetPaperTradingAccount(req.user, body.confirmation));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/paper-trades" && req.method === "POST") {
    try {
      const body = await readJson(req);
      return sendJson(res, 201, await enterPaperTrade(req.user, body.signalId, {
        accountSize: body.accountSize,
        riskPercent: body.riskPercent
      }));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  return false;
}
