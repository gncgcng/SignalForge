import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { withLoginTimeout } from "../src/modules/auth/authController.js";

const bootstrapSource = readFileSync(new URL("../public/auth-bootstrap.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");
const authController = readFileSync(new URL("../src/modules/auth/authController.js", import.meta.url), "utf8");
const authService = readFileSync(new URL("../src/modules/auth/authService.js", import.meta.url), "utf8");
const appConfig = readFileSync(new URL("../src/config/appConfig.js", import.meta.url), "utf8");

assert.match(html, /auth-bootstrap\.js\?v=2026\.07\.13-auth-timeout\.3/);
assert.ok(html.indexOf("auth-bootstrap.js") < html.indexOf("app.js?v="));
assert.match(serviceWorker, /signalforge-static-v31-auth-timeout/);
assert.match(serviceWorker, /"\/auth-bootstrap\.js"/);
assert.match(appSource, /\[auth-ui\] login:submit/);
assert.match(appSource, /\[auth-ui\] login:request:start/);
assert.match(appSource, /\[auth-ui\] login:success/);
assert.match(appSource, /\[auth-ui\] login:failed reason=/);
assert.match(appSource, /timeoutMs: 8000/);
assert.match(appSource, /\[auth-ui\] login:request:response status=/);
assert.match(appSource, /\[auth-ui\] login:timeout/);
assert.match(appSource, /\[auth-ui\] login:finally/);
assert.doesNotMatch(appSource, /history\.replaceState\([^;]+#scanner[^;]+;\s*await bootDashboard\(\)/);
assert.match(appSource, /bootDashboard\(\)\.catch/);
assert.match(appSource, /restore:stale_result_ignored/);
assert.match(appSource, /let loginInProgress = false/);
assert.match(appSource, /isAuthOperationCurrent\(operationId\)/);
assert.match(appSource, /if \(!isAuthOperationCurrent\(restoreOperationId\) \|\| loginInProgress\)/);
assert.match(appSource, /if \(isAuthOperationCurrent\(operationId\)\) saveRestoreToken\(session\.restore\)/);
assert.match(appSource, /if \(!isAuthOperationCurrent\(operationId\)\) return null;\s+saveRestoreToken\(result\.restore\)/);
assert.match(appSource, /finally \{[\s\S]*submitButton\.disabled = false/);
assert.match(appSource, /history\.pushState\(\{\}, "", `\$\{location\.pathname\}\$\{location\.search\}#reset-password`\)/);
assert.match(appSource, /function saveAuthSession\(session = \{\}\)/);
assert.match(appSource, /function getAuthSession\(\)/);
assert.match(appSource, /window\.__signalForgeMainAuthReady = true/);
assert.match(appSource, /Google sign-in temporarily unavailable/);
assert.match(bootstrapSource, /googleButton\.disabled = !config\.googleEnabled/);
assert.match(authController, /ok: true,[\s\S]*restoreToken: restore\.token/);
assert.match(authController, /error: errorCode/);
assert.match(authController, /\[auth\] login:start email_hash=/);
assert.match(authController, /\[auth\] login:success user_id=/);
assert.match(authController, /LOGIN_OPERATION_TIMEOUT_MS = 8000/);
assert.match(authController, /withLoginTimeout/);
assert.match(authService, /login:user_lookup:start/);
assert.match(authService, /login:password_check:done valid=/);
assert.match(authService, /login:session_create:done/);
assert.match(authService, /error\.statusCode = 401/);
assert.match(appConfig, /enabled: process\.env\.GOOGLE_AUTH_ENABLED !== "false"/);
await assert.rejects(
  withLoginTimeout(new Promise(() => {}), 1),
  (error) => error.code === "LOGIN_TIMEOUT" && error.statusCode === 500
);

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  toggle(value, force) {
    if (force === undefined ? !this.values.has(value) : force) this.values.add(value);
    else this.values.delete(value);
  }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.listeners = {};
    this.classList = new FakeClassList();
    this.dataset = {};
    this.disabled = false;
    this.textContent = "";
    this.checked = false;
    this.attributes = {};
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelector(selector) { return selector === "button[type='submit']" ? elements.submit : null; }
  reportValidity() { return true; }
  setAttribute(name, value) { this.attributes[name] = value; }
}

const ids = [
  "auth-form", "auth-note", "legal-consent", "forgot-password-button", "back-to-login-button",
  "recovery-back-to-sign-in", "google-auth-button", "auth-screen", "password-reset-request-form",
  "password-reset-confirm-form", "password-reset-unavailable", "password-reset-email-field",
  "password-reset-submit", "password-reset-request-note", "landing-page", "dashboard",
  "account-recovery-support-page", "auth-debug-panel", "password-reset-contact-support",
  "start-free-button", "landing-login-button"
];
const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement(id)]));
elements.submit = new FakeElement("submit");
elements["legal-consent"].checked = true;

function createStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

let fetchMode = "success";
const requests = [];
const location = {
  hash: "#signin",
  pathname: "/",
  search: "",
  replace(value) { this.replacedWith = value; },
  assign(value) { this.assignedTo = value; },
  reload() { this.reloadCalled = true; }
};
const context = {
  AbortController,
  URLSearchParams,
  FormData: class {
    *[Symbol.iterator]() {
      yield ["email", "user@example.com"];
      yield ["password", "correct-password"];
    }
  },
  console: { info() {}, warn() {} },
  document: {
    getElementById(id) { return elements[id] || null; }
  },
  fetch: async (path, options = {}) => {
    requests.push(path);
    if (path === "/api/auth/config") return response(200, { googleEnabled: true });
    if (path === "/api/auth/google/start") return response(200, { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test" });
    if (fetchMode === "invalid") return response(401, { ok: false, error: "invalid_credentials" });
    if (fetchMode === "server") return response(500, { ok: false, error: "login_failed" });
    if (fetchMode === "missing") return response(404, { ok: false, error: "not_found" });
    if (fetchMode === "unexpected") return response(200, {});
    if (fetchMode === "empty") return rawResponse(200, "");
    if (fetchMode === "non_json") return rawResponse(502, "upstream unavailable");
    if (fetchMode === "hang") return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
    if (fetchMode === "network") throw new TypeError("network failed");
    return response(200, {
      ok: true,
      user: { id: "usr_test" },
      restoreToken: "opaque-restore-token"
    });
  },
  history: {
    pushState(_state, _title, value) { location.hash = value.slice(value.indexOf("#")); },
    replaceState(_state, _title, value) { location.hash = value.slice(value.indexOf("#")); }
  },
  localStorage: createStorage(),
  sessionStorage: createStorage(),
  location,
  setTimeout,
  clearTimeout
};
context.window = context;
vm.runInNewContext(bootstrapSource, context, { filename: "auth-bootstrap.js" });
await new Promise((resolve) => setTimeout(resolve, 0));

const submitEvent = { preventDefault() {}, stopImmediatePropagation() {} };
await elements["auth-form"].listeners.submit(submitEvent);
assert.ok(requests.includes("/api/auth/login"), "login form calls the auth API");
assert.equal(context.localStorage.getItem("signalforge-restore-token"), "opaque-restore-token");
assert.equal(location.hash, "#scanner");
assert.equal(location.reloadCalled, true);
assert.equal(elements.submit.disabled, false, "loading state resets after success");

await elements["google-auth-button"].listeners.click({ stopImmediatePropagation() {} });
assert.match(location.assignedTo, /^https:\/\/accounts\.google\.com\//, "enabled Google login opens the OAuth URL");

fetchMode = "invalid";
await elements["auth-form"].listeners.submit(submitEvent);
assert.equal(elements["auth-note"].textContent, "Invalid email or password.");
assert.equal(elements.submit.disabled, false, "loading state resets after invalid login");

fetchMode = "network";
await elements["auth-form"].listeners.submit(submitEvent);
assert.equal(elements["auth-note"].textContent, "Could not sign in right now. Please try again.");
assert.equal(elements.submit.disabled, false, "loading state resets after network failure");

fetchMode = "server";
await elements["auth-form"].listeners.submit(submitEvent);
assert.equal(elements["auth-note"].textContent, "Could not sign in right now. Please try again.");
assert.equal(elements.submit.disabled, false, "loading state resets after a server error");

fetchMode = "missing";
await elements["auth-form"].listeners.submit(submitEvent);
assert.equal(elements["auth-note"].textContent, "Sign in is currently unavailable.");
assert.equal(elements.submit.disabled, false, "loading state resets after a missing endpoint");

fetchMode = "non_json";
await elements["auth-form"].listeners.submit(submitEvent);
assert.equal(elements["auth-note"].textContent, "Sign in failed. Server returned an invalid response.");
assert.equal(elements.submit.disabled, false, "loading state resets after non-JSON response");

fetchMode = "unexpected";
await elements["auth-form"].listeners.submit(submitEvent);
assert.equal(elements["auth-note"].textContent, "Sign in failed. Please try again.");
assert.equal(elements.submit.disabled, false, "loading state resets after unexpected response");

fetchMode = "empty";
await elements["auth-form"].listeners.submit(submitEvent);
assert.equal(elements["auth-note"].textContent, "Sign in failed. Please try again.");
assert.equal(elements.submit.disabled, false, "loading state resets after an empty response");

fetchMode = "hang";
const realSetTimeout = context.setTimeout;
context.setTimeout = (callback) => { queueMicrotask(callback); return 1; };
await elements["auth-form"].listeners.submit(submitEvent);
context.setTimeout = realSetTimeout;
assert.equal(elements["auth-note"].textContent, "Sign in timed out. Please try again.");
assert.equal(elements.submit.disabled, false, "timeout always resets the login button");

elements["forgot-password-button"].listeners.click();
assert.equal(location.hash, "#reset-password");
assert.equal(elements["password-reset-request-form"].classList.contains("hidden"), false);
assert.match(elements["password-reset-request-note"].textContent, /not available yet/i);

elements["password-reset-contact-support"].listeners.click({ preventDefault() {} });
assert.equal(location.hash, "#account-recovery-support");
assert.equal(elements["account-recovery-support-page"].classList.contains("hidden"), false);

context.localStorage.setItem("signalforge-auth-token", "legacy");
context.SignalForgeAuthStorage.clearAuthSession();
assert.equal(context.localStorage.getItem("signalforge-auth-token"), null);
assert.equal(context.localStorage.getItem("signalforge-restore-token"), null);

console.log("Auth actions tests passed.");

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); }
  };
}

function rawResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; }
  };
}
