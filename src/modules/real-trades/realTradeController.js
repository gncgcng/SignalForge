import { readJson, sendError, sendJson } from "../../shared/http.js";
import {
  MAX_BODY_BYTES,
  createTrade,
  exportTradesCsv,
  listTrades,
  patchTrade,
  removeTrade
} from "./realTradeService.js";
import { assertPaidAccess } from "../subscriptions/subscriptionService.js";

// Adding and editing trades is part of the paid plan. Reading, exporting and deleting stay open to every account,
// so a user's history is never held hostage after a subscription ends.
const WRITE_LOCKED_MESSAGE = "Adding and editing trades is part of the SignalForge plan. Your trades stay readable and exportable.";

// "My trades" API. Signed-in users only; every query is scoped to req.user.id, and another user's trade id returns
// 404 so it doesn't reveal that the trade exists.
export async function handleRealTradeRoutes(req, res, pathname) {
  if (pathname !== "/api/trades" && !pathname.startsWith("/api/trades/")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  try {
    if (pathname === "/api/trades" && req.method === "GET") {
      return sendJson(res, 200, await listTrades(req.user), { "cache-control": "no-store, private" });
    }

    if (pathname === "/api/trades" && req.method === "POST") {
      assertPaidAccess(req.user, WRITE_LOCKED_MESSAGE);
      const body = await readJson(req, { maxBytes: MAX_BODY_BYTES });
      return sendJson(res, 201, await createTrade(req.user, body));
    }

    if (pathname === "/api/trades/export.csv" && req.method === "GET") {
      const csv = await exportTradesCsv(req.user);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=\"my-trades.csv\"",
        "cache-control": "no-store, private",
        "x-content-type-options": "nosniff"
      });
      res.end(csv);
      return true;
    }

    const match = pathname.match(/^\/api\/trades\/([A-Za-z0-9_-]{1,64})$/);
    if (match && req.method === "PATCH") {
      assertPaidAccess(req.user, WRITE_LOCKED_MESSAGE);
      const body = await readJson(req, { maxBytes: MAX_BODY_BYTES });
      return sendJson(res, 200, await patchTrade(req.user, match[1], body));
    }
    if (match && req.method === "DELETE") {
      return sendJson(res, 200, await removeTrade(req.user, match[1]));
    }
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error("[real-trades] request failed", error.message);
    return sendError(res, status, status >= 500 ? "Could not save your trade. Please try again." : error.message,
      error.code ? { code: error.code } : undefined);
  }

  return sendError(res, 404, "Trade not found.");
}
