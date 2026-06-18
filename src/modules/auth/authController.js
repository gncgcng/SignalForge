import { appConfig } from "../../config/appConfig.js";
import { readJson, sendError, sendJson, parseCookies } from "../../shared/http.js";
import { createDemoSession, destroySession, registerOrLogin, toPublicUser } from "./authService.js";

export async function handleAuthRoutes(req, res, pathname) {
  if (pathname === "/api/auth/session" && req.method === "GET") {
    return sendJson(res, 200, { user: toPublicUser(req.user) }, authResponseHeaders());
  }

  if (pathname === "/api/auth/config" && req.method === "GET") {
    return sendJson(res, 200, { demoEnabled: appConfig.demoEnabled }, {
      "cache-control": "no-store"
    });
  }

  if (pathname === "/api/auth/demo" && req.method === "POST") {
    try {
      const result = await createDemoSession();
      return sendJson(res, 200, { user: result.user }, {
        ...authResponseHeaders(),
        "set-cookie": buildSessionCookie(result.sessionId)
      });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const result = await registerOrLogin(body);
      return sendJson(res, 200, { user: result.user }, {
        ...authResponseHeaders(),
        "set-cookie": buildSessionCookie(result.sessionId)
      });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const cookies = parseCookies(req.headers.cookie);
    const sessionIds = new Set([
      cookies[appConfig.sessionCookieName],
      cookies[appConfig.legacySessionCookieName]
    ].filter(Boolean));

    await Promise.all([...sessionIds].map((sessionId) => destroySession(sessionId)));
    return sendJson(res, 200, { ok: true }, {
      ...authResponseHeaders(),
      "set-cookie": buildClearCookies()
    });
  }

  return false;
}

function authResponseHeaders() {
  return {
    "cache-control": "no-store, private",
    vary: "Cookie"
  };
}

export function buildSessionCookie(sessionId) {
  const secure = appConfig.isProduction ? "; Secure" : "";
  return `${appConfig.sessionCookieName}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${appConfig.sessionMaxAgeSeconds}${secure}`;
}

export function buildClearCookies() {
  const names = new Set([appConfig.sessionCookieName, appConfig.legacySessionCookieName]);

  return [...names].flatMap((name) => {
    const cookies = [
      `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      `${name}=; SameSite=Lax; Path=/; Max-Age=0`
    ];

    if (appConfig.isProduction) {
      cookies.push(`${name}=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0`);
      cookies.push(`${name}=; SameSite=Lax; Secure; Path=/; Max-Age=0`);
    }

    return cookies;
  });
}
