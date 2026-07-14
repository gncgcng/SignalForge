const baseUrl = normalizeBaseUrl(process.env.APP_URL || "http://localhost:4173");
const email = String(process.env.AUTH_SMOKE_EMAIL || "").trim().toLowerCase();
const password = String(process.env.AUTH_SMOKE_PASSWORD || "");
const fingerprint = `auth-smoke|${process.platform}|${process.version}`;

if (!email || !password) {
  fail("AUTH_SMOKE_EMAIL and AUTH_SMOKE_PASSWORD are required.");
}

let cookie = "";

const health = await request("/api/auth/health", { method: "GET" });
reportResponse("auth health", health);
if (health.status !== 200 || health.body?.ok !== true) {
  fail(`auth health is not ready (${safeSummary(health.body)})`);
}
pass("auth health is ready");

const login = await request("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email, password })
});
reportResponse("login", login);
if (login.timedOut) fail("login endpoint timed out");
if (login.status === 404) fail("login endpoint returned 404");
if (login.status !== 200) fail(`valid credentials were rejected (${safeSummary(login.body)})`);
pass("login endpoint responded");

if (login.body?.ok !== true || !login.body?.user?.id) {
  fail(`login response shape is invalid (${safeSummary(login.body)})`);
}
pass("valid credentials accepted");

const restoreToken = login.body.restoreToken || login.body.restore?.token || login.body.token;
if (!restoreToken || typeof restoreToken !== "string") {
  fail("response shape missing token");
}
pass("token returned");

if (!cookie) fail("login did not return a persistent session cookie");
const cookieSession = await request("/api/auth/session", { method: "GET" });
reportResponse("cookie session", cookieSession);
if (cookieSession.status !== 200 || cookieSession.body?.user?.id !== login.body.user.id) {
  fail("fresh login cookie was rejected by auth/session");
}
pass("fresh cookie session accepted");

cookie = "";
const restore = await request("/api/auth/restore", {
  method: "POST",
  body: JSON.stringify({ restoreToken })
});
reportResponse("restore token", restore);
if (restore.status !== 200 || restore.body?.user?.id !== login.body.user.id || !cookie) {
  fail("session restore rejected fresh token");
}

const restoredSession = await request("/api/auth/session", { method: "GET" });
reportResponse("restored session", restoredSession);
if (restoredSession.status !== 200 || restoredSession.body?.user?.id !== login.body.user.id) {
  fail("auth/session rejected the restored session cookie");
}
pass("session restore accepted token");

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-device-fingerprint": fingerprint,
        ...(cookie ? { cookie } : {}),
        ...(options.headers || {})
      }
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      fail(`${path} returned non-JSON response`);
    }
    return { status: response.status, body, timedOut: false };
  } catch (error) {
    if (error.name === "AbortError") return { status: 0, body: null, timedOut: true };
    fail(`${path} network error: ${safeCode(error.code || error.name)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

function reportResponse(label, response) {
  console.log(`${label}: HTTP ${response.status} ${safeSummary(response.body)}`);
}

function safeSummary(body) {
  if (!body || typeof body !== "object") return "body=empty";
  return [
    `ok=${body.ok === true}`,
    `user=${Boolean(body.user?.id)}`,
    `token=${Boolean(body.token || body.restoreToken || body.restore?.token)}`,
    `error=${safeCode(typeof body.error === "string" ? body.error : body.error?.message || body.reason || "none")}`
  ].join(" ");
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("APP_URL must be a valid http(s) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) fail("APP_URL must use http or https.");
  return url.href.replace(/\/+$/, "");
}

function safeCode(value) {
  return String(value || "unknown").replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}
