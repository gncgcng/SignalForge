import {
  getAdminOperationsDashboard,
  getAdminProductAnalytics,
  getSignalValidationDashboard,
  searchAdminUsers
} from "../../db/repositories.js";
import { sendError, sendJson } from "../../shared/http.js";
import { isAdminUser } from "../auth/authService.js";

export async function handleAdminAnalyticsRoutes(req, res, pathname) {
  if (pathname !== "/api/admin/analytics" && pathname !== "/api/admin/users/search") {
    return false;
  }

  if (!req.user) return sendError(res, 401, "Authentication required.");
  if (!isAdminUser(req.user)) return sendError(res, 403, "Admin access required.");

  if (pathname === "/api/admin/analytics" && req.method === "GET") {
    return sendJson(res, 200, {
      analytics: await getAdminProductAnalytics(),
      validation: await getSignalValidationDashboard(),
      dashboard: await getAdminOperationsDashboard()
    });
  }

  if (pathname === "/api/admin/users/search" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    return sendJson(res, 200, {
      users: await searchAdminUsers(url.searchParams.get("q"))
    });
  }

  return false;
}
