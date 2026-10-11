// DB-backed: Settings → Change password, through the real auth handlers over HTTP (session
// cookies, restore tokens, login) against the local Postgres.
// Requires DATABASE_URL (local docker-compose Postgres) with migrations applied.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

process.env.NODE_ENV = "development";
process.env.EMAIL_FEATURES_ENABLED = "false";

const { appConfig } = await import("../src/config/appConfig.js");
const { getPool, query } = await import("../src/db/client.js");
const { attachAuth, requiresAuthAttachment } = await import("../src/middleware/authMiddleware.js");
const { handleAuthRoutes } = await import("../src/modules/auth/authController.js");
const { hashPassword } = await import("../src/modules/auth/authService.js");
const fixtures = await import("./account-deletion-fixtures.js");

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");
    if (requiresAuthAttachment(pathname)) {
      await attachAuth(req);
    } else {
      req.user = null;
      req.sessionId = null;
    }
    if (!(await handleAuthRoutes(req, res, pathname))) {
      res.writeHead(404);
      res.end();
    }
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const runTag = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
let browserCount = 0;

// A browser: its own cookie jar, IP and device fingerprint.
function browser() {
  browserCount += 1;
  const jar = new Map();
  const ip = `10.88.${randomBytes(1)[0]}.${browserCount}`;
  const device = `change-password-device-${runTag}-${browserCount}`;
  return {
    jar,
    device,
    async request(path, { method = "GET", body } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": ip,
          "x-device-fingerprint": device,
          cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ")
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0];
        const name = pair.slice(0, pair.indexOf("="));
        const value = pair.slice(pair.indexOf("=") + 1);
        if (!value || /max-age=0/i.test(cookie)) jar.delete(name);
        else jar.set(name, value);
      }
      return { status: response.status, json: await response.json().catch(() => null) };
    }
  };
}

const login = (client, email, password) => client.request("/api/auth/login", {
  method: "POST",
  body: { email, password, intent: "signin" }
});
const change = (client, currentPassword, newPassword) => client.request("/api/auth/password/change", {
  method: "POST",
  body: { currentPassword, newPassword }
});
const sessionStatus = async (client) => (await client.request("/api/auth/session")).status;
const restore = (client, restoreToken) => client.request("/api/auth/restore", { method: "POST", body: { restoreToken } });
const errorCode = (response) => response.json?.error?.details?.code;
const passwordHash = async (id) => (await query(`SELECT password_hash FROM users WHERE id = $1`, [id])).rows[0].password_hash;

async function createUser(tag, password) {
  const id = `usr_chpwtest_${tag}_${runTag}`;
  const record = password ? hashPassword(password) : { salt: "", hash: "" };
  await query(`INSERT INTO users (id, name, email, password_salt, password_hash, plan, email_verified_at)
    VALUES ($1, $2, $1 || '@example.com', $3, $4, 'free', now())`, [id, `Change ${tag}`, record.salt, record.hash]);
  userIds.push(id);
  return { id, email: `${id}@example.com` };
}

const userIds = [];
const results = {};

try {
  const paula = await createUser("paula", "old-password-1");
  const laptop = browser();
  const phone = browser();
  const tablet = browser();
  assert.equal((await login(laptop, paula.email, "old-password-1")).status, 200);
  const phoneLogin = await login(phone, paula.email, "old-password-1");
  assert.equal(phoneLogin.status, 200);
  assert.equal((await login(tablet, paula.email, "old-password-1")).status, 200);
  const phoneRestoreToken = phoneLogin.json.restore.token;
  const originalHash = await passwordHash(paula.id);

  // Signed out: refused.
  assert.equal((await change(browser(), "old-password-1", "new-password-2")).status, 401);

  // Wrong current password: refused, nothing changes, other devices stay signed in.
  let response = await change(laptop, "not-my-password", "new-password-2");
  assert.equal(response.status, 401);
  assert.equal(errorCode(response), "reauth_failed");
  assert.equal(await passwordHash(paula.id), originalHash);
  assert.equal(await sessionStatus(phone), 200);
  results.wrongCurrentPasswordRefused = true;

  // New password breaks the usual rule (6+ characters): refused.
  response = await change(laptop, "old-password-1", "short");
  assert.equal(response.status, 400);
  assert.equal(await passwordHash(paula.id), originalHash);
  results.newPasswordRulesApply = true;

  // Success: scrypt hash, this session kept, every other session and restore token revoked.
  response = await change(laptop, "old-password-1", "new-password-2");
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.json.otherSessionsSignedOut, 2);
  assert.ok(response.json.restore?.token, "no fresh restore token for this device");
  assert.match(await passwordHash(paula.id), /^scrypt\$/);
  assert.equal(await sessionStatus(laptop), 200, "the session that changed the password was signed out");
  assert.equal(await sessionStatus(phone), 401, "another device stayed signed in");
  assert.equal(await sessionStatus(tablet), 401, "another device stayed signed in");
  assert.equal((await restore(phone, phoneRestoreToken)).status, 401, "a revoked restore token minted a session");
  assert.equal((await restore(laptop, response.json.restore.token)).status, 200, "this device's fresh restore token doesn't work");
  results.otherSessionsAndRestoreTokensRevoked = true;

  // Old password no longer signs in; the new one does.
  assert.equal((await login(browser(), paula.email, "old-password-1")).status, 401);
  assert.equal((await login(browser(), paula.email, "new-password-2")).status, 200);
  results.newPasswordSignsIn = true;

  // A Google-only account has no password to change (it uses "Set a password").
  const gina = await createUser("gina", null);
  await query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [`sess_chpw_${runTag}`, gina.id]);
  const ginaBrowser = browser();
  ginaBrowser.jar.set(appConfig.sessionCookieName, `sess_chpw_${runTag}`);
  response = await change(ginaBrowser, "", "new-password-2");
  assert.equal(response.status, 409);
  assert.equal(errorCode(response), "no_password");
  assert.equal(await passwordHash(gina.id), "");
  results.googleOnlyAccountsRefused = true;

  // A password reset that lands between the check and the write wins; the change is refused.
  const { changeUserPassword } = await import("../src/db/repositories.js");
  const stale = await changeUserPassword({
    userId: paula.id,
    previousHash: originalHash,
    password: hashPassword("stale-password"),
    keepSessionId: null
  });
  assert.equal(stale, null);
  assert.equal((await login(browser(), paula.email, "new-password-2")).status, 200);
  results.staleChangeDoesNotOverwrite = true;

  console.log(JSON.stringify({ changePassword: "ok", results }, null, 2));
} finally {
  server.close();
  if (!process.argv.includes("--keep")) await fixtures.cleanupTestUsers(userIds);
  await getPool().end();
}
