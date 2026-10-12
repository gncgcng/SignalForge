import { sendJson } from "../../shared/http.js";
import { getTrackRecords } from "./trackRecordService.js";

// Read-only, the same for every viewer, and changes only with a deploy.
export async function handleTrackRecordRoutes(req, res, pathname) {
  if (pathname !== "/api/track-records") return false;
  if (req.method !== "GET") return false;
  return sendJson(res, 200, getTrackRecords(), { "cache-control": "public, max-age=300" });
}
