// GET /api/signals/candidates/quality is admin-only. req.user is the session row from attachAuth, which has
// no isAdmin field (only the client-facing user has one), so the route must check isAdminUser(req.user).
// DB-backed (local docker-compose Postgres); no network.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

const adminEmail = `quality_admin_${Date.now().toString(36)}@example.test`;
Object.assign(process.env, { NODE_ENV: "development", ADMIN_EMAILS: adminEmail });

const { getPool, query } = await import("../src/db/client.js");
const { createSession } = await import("../src/db/repositories.js");
const { appConfig } = await import("../src/config/appConfig.js");
const { attachAuth } = await import("../src/middleware/authMiddleware.js");
const { handleSignalRoutes } = await import("../src/modules/signals/signalController.js");
const fixtures = await import("./account-deletion-fixtures.js");

const helperIds = [];

// Builds req.user the way the server does: a session cookie resolved by attachAuth.
async function sessionUser(userId) {
  const sessionId = randomBytes(24).toString("hex");
  await createSession({ id: sessionId, userId, expiresAt: new Date(Date.now() + 3600_000) });
  const req = { headers: { cookie: `${appConfig.sessionCookieName}=${sessionId}` } };
  await attachAuth(req);
  assert.ok(req.user, "session should resolve to a user");
  return req.user;
}

async function getQuality(reqUser) {
  const req = Object.assign(Readable.from([]), { method: "GET", user: reqUser, headers: {} });
  const res = {
    statusCode: 0, body: "",
    writeHead(status) { this.statusCode = status; },
    end(chunk = "") { this.body += chunk; }
  };
  const path = "/api/signals/candidates/quality";
  const handled = await handleSignalRoutes(req, res, path, new URL(`http://localhost${path}`));
  assert.notEqual(handled, false, "quality route not handled");
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

try {
  const adminId = await fixtures.createHelperUser("quality_admin");
  const memberId = await fixtures.createHelperUser("quality_member");
  helperIds.push(adminId, memberId);
  await query(`UPDATE users SET email = $2 WHERE id = $1`, [adminId, adminEmail]);

  const admin = await sessionUser(adminId);
  assert.equal(admin.isAdmin, undefined, "fixture premise: the session user carries no isAdmin flag");
  const adminResult = await getQuality(admin);
  assert.equal(adminResult.status, 200, `admin in ADMIN_EMAILS should load candidate quality: ${JSON.stringify(adminResult.json)}`);
  assert.ok("quality" in adminResult.json && "marketBrief" in adminResult.json);

  const member = await sessionUser(memberId);
  const memberResult = await getQuality(member);
  assert.equal(memberResult.status, 403, "non-admin must be refused");
  assert.equal(memberResult.json.error.message, "Admin access required.");

  const spoofed = await getQuality({ ...member, isAdmin: true });
  assert.equal(spoofed.status, 403, "an isAdmin flag on req.user must not grant access");

  console.log("candidate quality admin test passed");
} finally {
  await query(`DELETE FROM sessions WHERE user_id = ANY($1)`, [helperIds]);
  await fixtures.cleanupTestUsers(helperIds);
  await getPool().end();
}
