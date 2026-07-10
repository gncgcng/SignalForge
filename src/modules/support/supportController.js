import { readJson, sendError, sendJson } from "../../shared/http.js";
import {
  getAdminSupportTicket,
  getAdminSupportTickets,
  getMySupportTicket,
  getMySupportTickets,
  submitSupportTicket,
  updateAdminSupportTicket
} from "./supportService.js";

export async function handleSupportRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/support") && !pathname.startsWith("/api/admin/support")) return false;
  if (!req.user) return sendError(res, 401, "Authentication required.");

  try {
    if (pathname === "/api/support" && req.method === "GET") {
      return sendJson(res, 200, await getMySupportTickets(req.user), { "cache-control": "no-store" });
    }
    if (pathname === "/api/support" && req.method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 201, await submitSupportTicket(req.user, body, {
        userAgent: req.headers["user-agent"] || ""
      }));
    }
    const userMatch = pathname.match(/^\/api\/support\/([^/]+)$/);
    if (userMatch && req.method === "GET") {
      return sendJson(res, 200, await getMySupportTicket(req.user, userMatch[1]), { "cache-control": "no-store" });
    }

    if (pathname === "/api/admin/support" && req.method === "GET") {
      return sendJson(res, 200, await getAdminSupportTickets(req.user, {
        status: url.searchParams.get("status") || "",
        topic: url.searchParams.get("topic") || "",
        priority: url.searchParams.get("priority") || "",
        from: url.searchParams.get("from") || "",
        to: url.searchParams.get("to") || "",
        search: url.searchParams.get("search") || "",
        limit: url.searchParams.get("limit") || 100
      }), { "cache-control": "no-store" });
    }
    const adminMatch = pathname.match(/^\/api\/admin\/support\/([^/]+)$/);
    if (adminMatch && req.method === "GET") {
      return sendJson(res, 200, await getAdminSupportTicket(req.user, adminMatch[1]), { "cache-control": "no-store" });
    }
    if (adminMatch && req.method === "PUT") {
      return sendJson(res, 200, await updateAdminSupportTicket(req.user, adminMatch[1], await readJson(req)));
    }
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.message);
  }
  return false;
}
