import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

process.env.NODE_ENV = "production";
process.env.DATABASE_URL = "postgres://user:password@postgres.railway.internal:5432/railway";
process.env.APP_URL = "https://signalforge-app.xyz";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const controller = readFileSync(new URL("../src/modules/auth/authController.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const databaseClient = readFileSync(new URL("../src/db/client.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");
const { handleAuthRoutes } = await import("../src/modules/auth/authController.js");

const bootScriptStart = html.indexOf("(function emergencyBootGuard() {");
const bootScriptEnd = html.indexOf("</script>", bootScriptStart);
const bootScript = html.slice(bootScriptStart, bootScriptEnd);

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
    has(key) { return values.has(key); }
  };
}

function runBootGuard(hash) {
  const ids = [
    "app-splash", "auth-debug-panel", "account-recovery-support-page",
    "public-how-it-works-page", "debug-build-page", "clear-session-page",
    "auth-screen", "dashboard", "landing-page", "debug-build-route",
    "debug-build-local-auth", "debug-build-session-auth", "debug-build-service-worker"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, {
    textContent: "",
    classList: {
      values: new Set(id === "landing-page" ? [] : ["hidden"]),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); },
      toggle(value, force) { if (force) this.add(value); else this.remove(value); }
    }
  }]));
  const localStorage = createStorage({
    "signalforge-restore-token": "opaque-secret",
    "signalforge-cached-user": "cached-user",
    "signalforge-risk-percent": "1"
  });
  const sessionStorage = createStorage({ "signalforge-auth-token": "legacy-token" });
  const location = { hash, search: "", pathname: "/" };
  const window = {
    location,
    localStorage,
    sessionStorage,
    history: {
      replaceState(_state, _title, url) { location.hash = url.slice(url.indexOf("#")); }
    },
    setTimeout() { return 1; },
    __signalForgeBootFailsafe: null
  };
  const context = {
    window,
    document: {
      getElementById(id) { return elements[id] || null; },
      set cookie(_value) {}
    },
    navigator: {
      serviceWorker: { getRegistrations: async () => [] }
    },
    caches: { keys: async () => [], delete: async () => true },
    URLSearchParams,
    Promise,
    console: { info() {}, warn() {} }
  };
  vm.runInNewContext(bootScript, context);
  return { elements, localStorage, sessionStorage, location };
}

const clearBoot = runBootGuard("#clear-session");
assert.equal(clearBoot.location.hash, "#clear-session");
assert.equal(clearBoot.localStorage.has("signalforge-restore-token"), false);
assert.equal(clearBoot.localStorage.has("signalforge-cached-user"), false);
assert.equal(clearBoot.localStorage.has("signalforge-risk-percent"), false);
assert.equal(clearBoot.sessionStorage.has("signalforge-auth-token"), false);
assert.equal(clearBoot.elements["auth-screen"].classList.values.has("hidden"), true);
assert.equal(clearBoot.elements["clear-session-page"].classList.values.has("hidden"), false);
assert.equal(clearBoot.elements["app-splash"].classList.values.has("hidden"), true);

const recoveryBoot = runBootGuard("#account-recovery-support");
assert.equal(recoveryBoot.elements["account-recovery-support-page"].classList.values.has("hidden"), false);
assert.equal(recoveryBoot.elements["app-splash"].classList.values.has("hidden"), true);

const signInBoot = runBootGuard("#signin");
assert.equal(signInBoot.elements["auth-screen"].classList.values.has("hidden"), false);
assert.equal(signInBoot.elements["app-splash"].classList.values.has("hidden"), true);

const debugBuildBoot = runBootGuard("#debug-build");
assert.equal(debugBuildBoot.elements["debug-build-page"].classList.values.has("hidden"), false);
assert.equal(debugBuildBoot.elements["auth-screen"].classList.values.has("hidden"), true);
assert.equal(debugBuildBoot.elements["debug-build-route"].textContent, "#debug-build");

const protectedBoot = runBootGuard("#scanner");
assert.equal(protectedBoot.elements["auth-screen"].classList.values.has("hidden"), false);
assert.equal(protectedBoot.elements["dashboard"].classList.values.has("hidden"), true);

const landingBoot = runBootGuard("");
assert.equal(landingBoot.elements["landing-page"].classList.values.has("hidden"), false);
assert.equal(landingBoot.elements["app-splash"].classList.values.has("hidden"), true);

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
assert.equal(missingSessionResponse.statusCode, 401);
assert.deepEqual(JSON.parse(missingSessionResponse.body), {
  ok: false,
  error: "invalid_session"
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
    app.includes("const AUTH_RESTORE_TIMEOUT_MS = 2800") &&
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
    app.includes('"#signin"') &&
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
    controller.includes('error: "auth_check_failed"') &&
    controller.includes("ok: true") &&
    controller.includes("buildClearCookies()"),
  mobileRecoveryLayout:
    styles.includes(".auth-restore-failure") &&
    styles.includes("@media (max-width: 480px)") &&
    styles.includes("width: min(calc(100vw - 32px), 480px)"),
  pwaReceivesFix:
    worker.includes('const CACHE_VERSION = "signalforge-static-v33-auth-debug-001"') &&
    worker.includes('"/auth-bootstrap.js"') &&
    worker.includes("CRITICAL_ASSET_PATHS") &&
    worker.includes('fetch(request, { cache: "no-store" })'),
  staticBootBypassesDatabase:
    server.indexOf('if (!url.pathname.startsWith("/api/"))') < server.indexOf("attachAuth(req)") &&
    server.includes('withTimeout(attachAuth(req), 2000, "auth_check_timeout")') &&
    server.includes('error: "auth_check_failed"') &&
    server.includes('"cache-control": "no-cache, no-store, must-revalidate"'),
  databaseLookupBounded:
    databaseClient.includes("connectionTimeoutMillis: 5000") &&
    databaseClient.includes("query_timeout: 5000") &&
    databaseClient.includes("statement_timeout: 5000"),
  moduleIndependentBootGuard:
    html.indexOf("function emergencyBootGuard()") < html.indexOf('src="/app.js?v=') &&
    html.includes("revealRequestedRoute(\"rendered_immediately\")") &&
    html.includes("window.__signalForgeBootFailsafe") &&
    styles.includes("app-splash-failsafe"),
  emergencyClearRoute:
    html.includes('hash === "#clear-session"') &&
    html.includes("navigator.serviceWorker.getRegistrations()") &&
    html.includes("caches.keys()") &&
    html.includes('"#signin"') &&
    app.includes("async function emergencyClearSession()")
};

for (const [name, passed] of Object.entries(checks)) {
  assert.equal(passed, true, `Auth restore failsafe check failed: ${name}`);
}

console.log(JSON.stringify(checks, null, 2));
