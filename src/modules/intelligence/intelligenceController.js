import { sendError, sendJson } from "../../shared/http.js";
import { getMarketIntelligence } from "./intelligenceService.js";

export async function handleIntelligenceRoutes(req, res, pathname) {
  if (!pathname.startsWith("/api/intelligence")) return false;
  if (!req.user) return sendError(res, 401, "Authentication required.");

  if (pathname === "/api/intelligence" && req.method === "GET") {
    return sendJson(res, 200, {
      intelligence: await getMarketIntelligence(new Date())
    });
  }

  return false;
}
