import { readJson, sendError, sendJson } from "../../shared/http.js";
import { isAdminUser } from "../auth/authService.js";
import { getAdminGeneratedSignal, getAdminGeneratedSignals, updateAdminSignalGroupStatus } from "./generatedSignalService.js";

export async function handleAdminGeneratedSignalRoutes(req, res, pathname, url) {
  if (!pathname.startsWith("/api/admin/signals")) return false;
  if (!req.user) return sendError(res, 401, "Authentication required.");
  if (!isAdminUser(req.user)) return sendError(res, 403, "Admin access required.");

  if (pathname === "/api/admin/signals/quality/status" && req.method === "POST") {
    const body = await readJson(req);
    const groupKey = clean(body.groupKey, 160);
    if (!groupKey) return sendError(res, 400, "Performance group is required.");
    const status = clean(body.status, 40);
    const updated = await updateAdminSignalGroupStatus({
      groupKey,
      status,
      adminNote: clean(body.adminNote, 500),
      penaltyOverride: numberFromBody(body.penaltyOverride),
      confidenceCapOverride: numberFromBody(body.confidenceCapOverride)
    }, req.user);
    return sendJson(res, 200, { ok: true, status: updated });
  }

  if (req.method !== "GET") return sendError(res, 405, "Method not allowed.");

  if (pathname === "/api/admin/signals") {
    return sendJson(res, 200, await getAdminGeneratedSignals(parseFilters(url.searchParams)));
  }
  const match = pathname.match(/^\/api\/admin\/signals\/([^/]+)$/);
  if (match) {
    const signal = await getAdminGeneratedSignal(decodeURIComponent(match[1]));
    return signal ? sendJson(res, 200, { signal }) : sendError(res, 404, "Generated signal not found.");
  }
  return false;
}

function parseFilters(params) {
  const number = (key) => { if (!params.has(key) || params.get(key) === "") return undefined; const value = Number(params.get(key)); return Number.isFinite(value) ? value : undefined; };
  return {
    status: clean(params.get("status"), 32), pair: clean(params.get("pair"), 32), timeframe: clean(params.get("timeframe"), 8),
    direction: ["long", "short"].includes(params.get("direction")) ? params.get("direction") : "",
    strategy: clean(params.get("strategy"), 80), pattern: clean(params.get("pattern"), 80), source: clean(params.get("source"), 40),
    confidenceMin: number("confidenceMin"), confidenceMax: number("confidenceMax"), qualityMin: number("qualityMin"), qualityMax: number("qualityMax"),
    from: clean(params.get("from"), 40), to: clean(params.get("to"), 40), search: clean(params.get("search"), 120),
    performanceScope: ["current", "legacy", "all"].includes(params.get("performanceScope")) ? params.get("performanceScope") : "current",
    sort: clean(params.get("sort"), 20), page: number("page"), limit: number("limit")
  };
}
function clean(value, max) { return String(value || "").trim().slice(0, max); }
function numberFromBody(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
