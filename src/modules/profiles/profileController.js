import { readJson, sendError, sendJson } from "../../shared/http.js";
import {
  getMyProfile,
  getPublicProfile,
  updateMyProfile
} from "./profileService.js";

export async function handleProfileRoutes(req, res, pathname) {
  if (pathname === "/api/profile/me" && req.method === "GET") {
    if (!req.user) return sendError(res, 401, "Authentication required.");
    try {
      return sendJson(res, 200, { profile: await getMyProfile(req.user) });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/profile/me" && req.method === "PUT") {
    if (!req.user) return sendError(res, 401, "Authentication required.");
    try {
      const body = await readJson(req);
      return sendJson(res, 200, { profile: await updateMyProfile(req.user, body) });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname.startsWith("/api/profiles/") && req.method === "GET") {
    try {
      const username = decodeURIComponent(pathname.slice("/api/profiles/".length));
      return sendJson(res, 200, { profile: await getPublicProfile(username) }, {
        "cache-control": "no-store"
      });
    } catch (error) {
      return sendError(res, error.statusCode || 404, error.message);
    }
  }

  return false;
}
