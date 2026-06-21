import { readJson, sendError, sendJson } from "../../shared/http.js";
import {
  decideTesterRequest,
  getAbuseDashboard,
  getPendingTesterRequests,
  getTesterAccessStatus,
  requestTesterAccess
} from "./testerAccessService.js";

export async function handleTesterAccessRoutes(req, res, pathname) {
  if (!pathname.startsWith("/api/tester-access") && !pathname.startsWith("/api/admin/")) {
    return false;
  }

  if (!req.user) {
    return sendError(res, 401, "Authentication required.");
  }

  try {
    if (pathname === "/api/tester-access" && req.method === "GET") {
      return sendJson(res, 200, await getTesterAccessStatus(req.user));
    }

    if (pathname === "/api/tester-access/request" && req.method === "POST") {
      return sendJson(res, 201, await requestTesterAccess(req.user));
    }

    if (pathname === "/api/admin/tester-access" && req.method === "GET") {
      return sendJson(res, 200, await getPendingTesterRequests(req.user));
    }

    if (pathname === "/api/admin/abuse" && req.method === "GET") {
      return sendJson(res, 200, await getAbuseDashboard(req.user));
    }

    const decisionMatch = pathname.match(/^\/api\/admin\/tester-access\/([^/]+)$/);

    if (decisionMatch && req.method === "POST") {
      const body = await readJson(req);
      return sendJson(
        res,
        200,
        await decideTesterRequest(req.user, decisionMatch[1], body.decision)
      );
    }
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.message);
  }

  return false;
}
