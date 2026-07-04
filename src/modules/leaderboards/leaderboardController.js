import { sendError, sendJson } from "../../shared/http.js";
import { getLeaderboards } from "./leaderboardService.js";

export async function handleLeaderboardRoutes(req, res, pathname) {
  if (pathname === "/api/leaderboards" && req.method === "GET") {
    try {
      return sendJson(res, 200, { leaderboards: await getLeaderboards() }, {
        "cache-control": "no-store"
      });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  return false;
}
