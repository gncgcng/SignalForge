import { getAdminProductAnalytics } from "../../db/repositories.js";
import { sendError, sendJson } from "../../shared/http.js";
import { isAdminUser } from "../auth/authService.js";

export async function handleAdminAnalyticsRoutes(req, res, pathname) {
  if (pathname !== "/api/admin/analytics") {
    return false;
  }

  if (!req.user) return sendError(res, 401, "Authentication required.");
  if (!isAdminUser(req.user)) return sendError(res, 403, "Admin access required.");

  if (req.method === "GET") {
    return sendJson(res, 200, {
      analytics: await getAdminProductAnalytics()
    });
  }

  return false;
}
