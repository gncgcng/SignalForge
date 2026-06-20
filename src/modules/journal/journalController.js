import { readJson, sendError, sendJson } from "../../shared/http.js";
import { getTradeJournal, saveTradeJournal } from "./journalService.js";

export async function handleJournalRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/journal")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  if (pathname === "/api/journal" && req.method === "GET") {
    try {
      return sendJson(res, 200, await getTradeJournal(req.user, {
        symbol: url.searchParams.get("symbol") || "",
        timeframe: url.searchParams.get("timeframe") || "",
        from: url.searchParams.get("from") || "",
        to: url.searchParams.get("to") || "",
        emotion: url.searchParams.get("emotion") || ""
      }));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  const match = pathname.match(/^\/api\/journal\/([^/]+)$/);
  if (match && req.method === "PUT") {
    try {
      const body = await readJson(req);
      return sendJson(res, 200, await saveTradeJournal(req.user, match[1], body));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  return false;
}
