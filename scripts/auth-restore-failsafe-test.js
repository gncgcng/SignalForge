import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "production";
process.env.DATABASE_URL = "postgres://user:password@postgres.railway.internal:5432/railway";
process.env.APP_URL = "https://signalforge-app.xyz";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const controller = readFileSync(new URL("../src/modules/auth/authController.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");
const { handleAuthRoutes } = await import("../src/modules/auth/authController.js");

function createResponseRecorder() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body || "";
    }
  };
}

const missingSessionResponse = createResponseRecorder();
await handleAuthRoutes({
  method: "GET",
  headers: {},
  user: null,
  sessionId: null
}, missingSessionResponse, "/api/auth/session");
assert.equal(missingSessionResponse.statusCode, 200);
assert.deepEqual(JSON.parse(missingSessionResponse.body), {
  ok: true,
  user: null,
  sessionExpiresAt: null,
  restore: null
});

const invalidSessionResponse = createResponseRecorder();
await handleAuthRoutes({
  method: "GET",
  headers: { cookie: "__Secure-signalforge_session=expired-session" },
  user: null,
  sessionId: null
}, invalidSessionResponse, "/api/auth/session");
assert.equal(invalidSessionResponse.statusCode, 401);
assert.deepEqual(JSON.parse(invalidSessionResponse.body), {
  ok: false,
  error: "invalid_session"
});

const checks = {
  validSessionRestores:
    app.includes('api.request("/api/auth/session", { signal })') &&
    app.includes("if (session.user)") &&
    app.includes("[auth] restore:success user_id=") &&
    app.includes("await bootDashboard()"),
  noSessionShowsLoggedOutUi:
    app.includes("No cookie session found; checking persistent restore token.") &&
    app.includes("No persistent restore token found.") &&
    app.includes("isProtectedAppRoute()") &&
    app.includes('authNote.textContent = "Please sign in to continue."'),
  invalidAndExpiredClearLocalAuth:
    app.includes("isPermanentRestoreFailure(error)") &&
    app.includes('clearSavedAuthStorage("invalid_or_expired_restore_token")') &&
    app.includes("[400, 401, 403, 404, 410].includes(error.statusCode)"),
  unauthorizedDoesNotLoop:
    app.includes("isMissingSessionFailure(cookieFailure)") &&
    app.includes('clearSavedAuthStorage("invalid_cookie_session")') &&
    !app.includes("setInterval(loadStartupSession"),
  backendFailureDoesNotLoop:
    app.includes("if (cookieFailure && !isMissingSessionFailure(cookieFailure)) throw cookieFailure") &&
    app.includes("showAuthRestoreFailure(error)") &&
    app.includes("handleStartupFailure"),
  networkFailureDoesNotLoop:
    app.includes("throw error;\n  }\n}\n\nfunction isPermanentRestoreFailure") &&
    app.includes("Startup session restore failed before login state was confirmed"),
  timeoutRecovery:
    app.includes("const AUTH_RESTORE_TIMEOUT_MS = 7000") &&
    app.includes("restoreController.abort()") &&
    app.includes("[auth] restore:timeout") &&
    html.includes('id="auth-restore-failure"') &&
    html.includes("Couldn&rsquo;t restore session"),
  recoveryActions:
    html.includes('id="auth-restore-retry"') &&
    html.includes('id="auth-restore-sign-in"') &&
    html.includes('id="auth-restore-clear"') &&
    app.includes("clearSavedAuthStorage") &&
    app.includes("location.reload()"),
  legacyStorageCleanup:
    app.includes('"signalforge-auth-token"') &&
    app.includes('"signalforge-refresh-token"') &&
    app.includes('"signalforge-cached-user"') &&
    app.includes("[auth] local_session:cleared") &&
    !app.includes("console.info(restoreToken"),
  publicRoutesFailOpen:
    app.includes("function isPublicStartupRoute()") &&
    app.includes('"#pricing"') &&
    app.includes('"#how-it-works"') &&
    app.includes('"#account-recovery-support"') &&
    app.includes("if (isPublicStartupRoute())"),
  protectedRoutesRequireAuth:
    app.includes("function isProtectedAppRoute()") &&
    app.includes('parsed.route !== "how-it-works"') &&
    app.includes("Please sign in to continue."),
  unexpectedJsonFailsSafely:
    app.includes('error.code = "invalid_json"') &&
    app.includes("isValidSessionPayload(session)") &&
    app.includes('clearSavedAuthStorage("unexpected_session_response")'),
  predictableBackendResponses:
    controller.includes('error: "invalid_session"') &&
    controller.includes('error: "session_unavailable"') &&
    controller.includes("ok: true") &&
    controller.includes("buildClearCookies()"),
  mobileRecoveryLayout:
    styles.includes(".auth-restore-failure") &&
    styles.includes("@media (max-width: 480px)") &&
    styles.includes("width: min(calc(100vw - 32px), 480px)"),
  pwaReceivesFix:
    worker.includes('const CACHE_VERSION = "signalforge-static-v28"') &&
    worker.includes('"/app.js"')
};

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(passed, true, `Auth restore failsafe check failed: ${name}`);
}

console.log(JSON.stringify(checks, null, 2));
