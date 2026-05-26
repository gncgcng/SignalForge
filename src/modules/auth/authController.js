import { appConfig } from "../../config/appConfig.js";
import { readJson, sendError, sendJson, parseCookies } from "../../shared/http.js";
import { destroySession, registerOrLogin, toPublicUser } from "./authService.js";

export async function handleAuthRoutes(req, res, pathname) {
  if (pathname === "/api/auth/session" && req.method === "GET") {
    return sendJson(res, 200, { user: toPublicUser(req.user) });
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const result = await registerOrLogin(body);
      return sendJson(res, 200, { user: result.user }, {
        "set-cookie": `${appConfig.sessionCookieName}=${encodeURIComponent(result.sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
      });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const cookies = parseCookies(req.headers.cookie);
    await destroySession(cookies[appConfig.sessionCookieName]);
    return sendJson(res, 200, { ok: true }, {
      "set-cookie": `${appConfig.sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
    });
  }

  return false;
}
