import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "production";
process.env.DATABASE_URL = "postgres://user:password@postgres.railway.internal:5432/railway";

const { appConfig, resolveSessionMaxAgeSeconds } = await import("../src/config/appConfig.js");
const { buildClearCookies, buildSessionCookie } = await import("../src/modules/auth/authController.js");

const authController = readFileSync(
  new URL("../src/modules/auth/authController.js", import.meta.url),
  "utf8"
);
const authService = readFileSync(
  new URL("../src/modules/auth/authService.js", import.meta.url),
  "utf8"
);
const middleware = readFileSync(
  new URL("../src/middleware/authMiddleware.js", import.meta.url),
  "utf8"
);
const repositories = readFileSync(
  new URL("../src/db/repositories.js", import.meta.url),
  "utf8"
);
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/019_persistent_sessions.sql", import.meta.url),
  "utf8"
);
const serviceWorker = readFileSync(
  new URL("../public/service-worker.js", import.meta.url),
  "utf8"
);

const cookie = buildSessionCookie("sess_persistent");
const clearCookies = buildClearCookies();

const result = {
  persistentCookie:
    appConfig.sessionMaxAgeSeconds >= 60 * 60 * 24 * 30 &&
    resolveSessionMaxAgeSeconds("bad-value") === 60 * 60 * 24 * 180 &&
    resolveSessionMaxAgeSeconds("999") === 60 * 60 * 24 * 365 &&
    cookie.includes("HttpOnly") &&
    cookie.includes("Secure") &&
    cookie.includes("SameSite=Lax") &&
    cookie.includes(`Max-Age=${appConfig.sessionMaxAgeSeconds}`),
  noFrontendTokenStorage:
    !app.includes("localStorage.setItem(\"token") &&
    !app.includes("sessionStorage.setItem(\"token") &&
    !app.includes("Authorization"),
  explicitSameOriginCredentials:
    app.includes('credentials: "same-origin"') &&
    app.includes('cache: "no-store"'),
  sessionRestoreOnLaunch:
    app.includes('api.request("/api/auth/session")') &&
    app.includes("setSplashStatus(\"Restoring your session\")") &&
    html.includes('id="app-splash-status"'),
  rollingRefresh:
    authController.includes("refreshSessionExpiry(req.sessionId)") &&
    authController.includes("buildSessionCookie(req.sessionId)") &&
    authService.includes("refreshSession(sessionId, expiresAt)") &&
    repositories.includes("UPDATE sessions") &&
    repositories.includes("SET expires_at = $2"),
  legacyCookieFallback:
    middleware.includes("cookies[appConfig.sessionCookieName] ||") &&
    middleware.includes("cookies[appConfig.legacySessionCookieName]"),
  logoutStillClearsSessions:
    authController.includes("destroySession(sessionId)") &&
    clearCookies.some((item) => item.startsWith("__Host-signalforge_session=")) &&
    clearCookies.some((item) => item.startsWith("signalforge_session=")),
  migrationExtendsActiveSessions:
    migration.includes("ALTER COLUMN expires_at SET DEFAULT") &&
    migration.includes("interval '180 days'") &&
    migration.includes("WHERE expires_at > now()"),
  pwaCacheBumped: serviceWorker.includes("signalforge-static-v9")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Session persistence check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
