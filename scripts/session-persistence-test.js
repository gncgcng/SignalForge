import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "production";
process.env.DATABASE_URL = "postgres://user:password@postgres.railway.internal:5432/railway";
process.env.APP_URL = "https://signalforge-app.xyz";

const {
  appConfig,
  resolveCookieDomain,
  resolveSessionMaxAgeSeconds
} = await import("../src/config/appConfig.js");
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
const authBootstrap = readFileSync(new URL("../public/auth-bootstrap.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/019_persistent_sessions.sql", import.meta.url),
  "utf8"
);
const restoreMigration = readFileSync(
  new URL("../migrations/020_persistent_auth_restore_tokens.sql", import.meta.url),
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
    resolveCookieDomain("https://signalforge-app.xyz", "production") === "signalforge-app.xyz" &&
    resolveCookieDomain("http://localhost:4173", "production") === "" &&
    cookie.startsWith("__Secure-signalforge_session=") &&
    cookie.includes("HttpOnly") &&
    cookie.includes("Secure") &&
    cookie.includes("SameSite=Lax") &&
    cookie.includes("Domain=signalforge-app.xyz") &&
    !cookie.includes("Domain=localhost") &&
    cookie.includes("Expires=") &&
    cookie.includes(`Max-Age=${appConfig.sessionMaxAgeSeconds}`),
  noJwtOrUserStorage:
    app.includes('const RESTORE_TOKEN_KEY = "signalforge-restore-token"') &&
    app.includes("localStorage.setItem(RESTORE_TOKEN_KEY, restore.token)") &&
    !app.includes("const RESTORE_TOKEN_COOKIE") &&
    !app.includes("localStorage.setItem(\"token") &&
    !app.includes("sessionStorage.setItem(\"token") &&
    !app.includes("localStorage.setItem(\"user") &&
    !app.includes("Authorization"),
  explicitSameOriginCredentials:
    app.includes('credentials: "same-origin"') &&
    app.includes('cache: "no-store"'),
  sessionRestoreOnLaunch:
    app.includes("async function loadStartupSession({ signal, operationId } = {})") &&
    app.includes('api.request("/api/auth/session", { signal })') &&
    app.includes("setSplashStatus(\"Restoring your session\")") &&
    html.includes('id="app-splash-status"'),
  centralizedPersistentAuthStorage:
    authBootstrap.includes("saveAuthSession: function (session)") &&
    authBootstrap.includes("getAuthSession: function ()") &&
    authBootstrap.includes("clearAuthSession: function ()") &&
    authBootstrap.includes('var RESTORE_EXPIRES_AT_KEY = "signalforge-restore-expires-at"') &&
    app.includes("const saved = authStorage?.saveAuthSession") &&
    app.includes("const stored = authStorage?.getAuthSession?.() || {}"),
  authRouteWaitsForRestore:
    !app.includes('if (isPublicAuthRoute()) {\n    const authConfig = await loadAuthConfig();') &&
    app.includes('} else if (isPublicAuthRoute()) {\n    setSplashStatus("Opening sign in");') &&
    app.includes("const AUTH_RESTORE_TIMEOUT_MS = 8000"),
  signInUsesLoginOnlyFields:
    app.includes('const signupMode = getHashRoute() === "#signup"') &&
    app.includes('["name", "username", "publicProfileEnabled"]') &&
    app.includes('input.disabled = !signupMode') &&
    app.includes('heading.textContent = signupMode ? "Create your account" : "Sign in"'),
  loginRefreshStillLoggedIn:
    app.includes("if (session.user)") &&
    app.includes("console.info(\"[auth] Cookie session restored.\")") &&
    app.includes("state.user = user;") &&
    app.includes("if (user)") &&
    app.includes("await bootDashboard();"),
  dashboardBootFailureDoesNotLogout:
    app.includes("Promise.allSettled([") &&
    app.includes("reportDashboardLoadFailures(dashboardLoads)") &&
    app.includes("Dashboard restored, but") &&
    app.includes("if (state.user)") &&
    app.includes("dashboard.classList.remove(\"hidden\")") &&
    !app.includes("await Promise.all([\n    loadPairs()"),
  normalCookieRestoreFirst:
    app.indexOf('api.request("/api/auth/session", { signal })') <
    app.indexOf("restoreSavedSession({ signal, cookieFailure, operationId })") &&
    authController.includes("refreshSessionExpiry(req.sessionId)") &&
    authController.includes("createPersistentRestoreToken("),
  pwaCookieLossFallback:
    app.includes("async function restoreSavedSession({ signal, cookieFailure = null, operationId } = {})") &&
    app.includes('api.request("/api/auth/restore"') &&
    app.includes("No cookie session found; checking persistent restore token.") &&
    app.includes("function isPermanentRestoreFailure(error)") &&
    authController.includes('pathname === "/api/auth/restore"') &&
    authController.includes("restoreSessionFromToken({"),
  temporarySessionFailureDoesNotLogout:
    app.includes("Cookie session check failed; trying persistent restore token.") &&
    app.includes("isPermanentRestoreFailure(error)") &&
    app.includes("[400, 401, 403, 404, 410].includes(error.statusCode)") &&
    app.includes("error.statusCode = response.status") &&
    app.includes("Startup session restore failed before login state was confirmed") &&
    !app.includes("clearRestoreToken();\n    console.warn(`[auth] Persistent restore token failed"),
  validSessionSurvivesAuxiliaryRefreshFailure:
    authController.includes("Session expiry refresh failed") &&
    authController.includes("Session restore-token rotation failed") &&
    authController.includes("user: toPublicUser(req.user)") &&
    !authController.includes("Session endpoint failed reason="),
  restoreTokenDeviceBoundAndHashed:
    restoreMigration.includes("CREATE TABLE IF NOT EXISTS auth_restore_tokens") &&
    restoreMigration.includes("token_hash text NOT NULL UNIQUE") &&
    restoreMigration.includes("device_fingerprint_hash text NOT NULL") &&
    restoreMigration.includes("CREATE INDEX IF NOT EXISTS idx_auth_restore_tokens_user_device_active") &&
    !restoreMigration.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_restore_tokens_user_device_active") &&
    !restoreMigration.includes(" token text") &&
    repositories.includes("storeAuthRestoreToken") &&
    repositories.includes("findAuthRestoreToken(tokenHash, deviceFingerprintHash)") &&
    authService.includes("hashRestoreToken(token)") &&
    authService.includes("await revokeAuthRestoreToken(hashRestoreToken(token));") &&
    authService.includes("getSignupContext(req, deviceFingerprint).deviceHash"),
  invalidRestoreFailsSafely:
    authService.includes('throw restoreError("Saved session expired. Please sign in again.")') &&
    authService.includes("statusCode = 401") &&
    app.includes("console.warn(`[auth] restore:failed reason=${safeAuthFailureReason(error)}`)") &&
    app.includes('clearSavedAuthStorage("invalid_or_expired_restore_token")') &&
    app.includes("return null"),
  loginSetsPersistentCookie:
    authController.includes('pathname === "/api/auth/login"') &&
    authController.includes("registerOrLogin({") &&
    authController.includes('"set-cookie": buildSessionCookie(result.sessionId)'),
  safeCookieLogging:
    authController.includes("logSessionCookieIssued(\"login\")") &&
    authController.includes("Set-Cookie issued context=") &&
    authController.includes("httpOnly=true") &&
    authController.includes("domain=${appConfig.sessionCookieDomain || \"host-only\"}") &&
    !authController.includes("console.info(sessionId"),
  googleLoginRefreshUsesCookieSession:
    authController.includes('pathname === "/api/auth/google/callback"') &&
    authController.includes("completeGoogleOAuth({") &&
    authController.includes("buildSessionCookie(result.sessionId)") &&
    authController.includes('pathname === "/api/auth/session"') &&
    authController.includes("user: toPublicUser(req.user)"),
  sessionPersistedInPostgres:
    authService.includes("createSessionRecord({ id: sessionId, userId: user.id, expiresAt })") &&
    authService.includes("PostgreSQL session inserted") &&
    repositories.includes("INSERT INTO sessions") &&
    repositories.includes("findSessionUser(sessionId)") &&
    middleware.includes("findSessionUser(sessionId)"),
  cookieMissingLoggedOut:
    middleware.includes("if (!sessionId)") &&
    middleware.includes("req.user = null") &&
    middleware.includes("req.sessionId = null"),
  expiredSessionLoggedOut:
    repositories.includes("WHERE id = $1 AND expires_at > now()") &&
    middleware.includes("req.sessionId = user ? sessionId : null"),
  rollingRefresh:
    authController.includes("refreshSessionExpiry(req.sessionId)") &&
    authController.includes("buildSessionCookie(req.sessionId)") &&
    authService.includes("refreshSession(sessionId, expiresAt)") &&
    repositories.includes("UPDATE sessions") &&
    repositories.includes("SET expires_at = $2"),
  legacyCookieFallback:
    middleware.includes("getSessionCookieNames()") &&
    middleware.includes(".map((name) => cookies[name])") &&
    middleware.includes("appConfig.legacySessionCookieNames"),
  logoutStillClearsSessions:
    authController.includes("destroySession(sessionId)") &&
    authController.includes("revokePersistentRestoreToken({") &&
    authService.includes("revokeAuthRestoreToken(hashRestoreToken(token))") &&
    authService.includes("revokeAuthRestoreTokensForUserDevice(user.id, deviceHash)") &&
    app.includes("body: JSON.stringify({ restoreToken: getAuthSession().restoreToken })") &&
    app.includes('clearAuthSession("logout")') &&
    clearCookies.some((item) => item.startsWith("__Secure-signalforge_session=")) &&
    clearCookies.some((item) => item.startsWith("__Host-signalforge_session=")) &&
    clearCookies.some((item) => item.startsWith("signalforge_session=")) &&
    clearCookies.some((item) => item.includes("Domain=signalforge-app.xyz")) &&
    clearCookies.every((item) => item.includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT")) &&
    app.includes("Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax"),
  migrationExtendsActiveSessions:
    migration.includes("ALTER COLUMN expires_at SET DEFAULT") &&
    migration.includes("interval '180 days'") &&
    migration.includes("WHERE expires_at > now()"),
  pwaCacheBumped: /signalforge-static-v\d+/.test(serviceWorker) &&
    !serviceWorker.includes("signalforge-static-v10")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Session persistence check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
