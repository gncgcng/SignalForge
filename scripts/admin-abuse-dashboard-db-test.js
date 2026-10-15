// Admin abuse dashboard, DB-backed: GET /api/admin/abuse runs every query against the real schema (the
// repeated-devices query once grouped users by a user_id column that table never had, so the route returned 400
// and blanked the whole Admin view). Seeds two accounts on one device and checks they are reported together.
// Also checks the Admin view loads its endpoints with Promise.allSettled. Requires DATABASE_URL (local docker-compose Postgres).
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

const ADMIN_EMAIL = "abuse-dashboard-admin@example.test";
process.env.ADMIN_EMAILS = ADMIN_EMAIL;

const { getPool, query } = await import("../src/db/client.js");
const { handleTesterAccessRoutes } = await import("../src/modules/tester-access/testerAccessController.js");
const fixtures = await import("./account-deletion-fixtures.js");

const results = {};
const helperIds = [];

async function call(user, path) {
  const req = Object.assign(Readable.from([]), { method: "GET", user, headers: {} });
  const res = {
    statusCode: 0, headers: {}, body: "",
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; },
    end(chunk = "") { this.body += chunk; }
  };
  const handled = await handleTesterAccessRoutes(req, res, path);
  assert.equal(handled, true, `GET ${path} not handled`);
  return { status: res.statusCode, json: JSON.parse(res.body || "null"), text: res.body };
}

try {
  const first = await fixtures.createHelperUser("abuse_a");
  const second = await fixtures.createHelperUser("abuse_b");
  helperIds.push(first, second);
  const deviceHash = `devhash_abuse_dashboard_${Date.now().toString(36)}`;
  await query(`UPDATE users SET device_fingerprint_hash = $1, trial_used = true WHERE id = ANY($2)`, [deviceHash, helperIds]);

  const forbidden = await call({ id: first, email: `${first}@example.test` }, "/api/admin/abuse");
  assert.equal(forbidden.status, 403, forbidden.text);
  results["non-admin is refused"] = true;

  const response = await call({ id: "usr_abuse_admin", email: ADMIN_EMAIL }, "/api/admin/abuse");
  assert.equal(response.status, 200, response.text);
  const { abuse } = response.json;
  for (const key of ["flaggedAccounts", "accountsPerIp", "repeatedDevices", "disposableEmails"]) {
    assert.ok(Array.isArray(abuse[key]), `${key} is a list`);
  }
  const device = abuse.repeatedDevices.find((entry) => entry.deviceHash === deviceHash.slice(0, 12) && entry.accounts === 2);
  assert.ok(device, `the shared device is reported with 2 accounts: ${JSON.stringify(abuse.repeatedDevices)}`);
  assert.equal(device.trialUsed, true);
  results["admin gets all four sections, shared device counted per account"] = true;

  // One failing admin endpoint must not keep the other Admin panels from rendering.
  const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const loader = frontend.slice(frontend.indexOf("async function loadAdminRequests()"));
  const body = loader.slice(0, loader.indexOf("\n}\n"));
  assert.match(body, /Promise\.allSettled\(/, "loadAdminRequests uses Promise.allSettled");
  assert.doesNotMatch(body, /Promise\.all\(/, "loadAdminRequests does not use Promise.all");
  results["admin view tolerates one failing endpoint"] = true;

  console.log(JSON.stringify(results, null, 2));
} finally {
  await fixtures.cleanupTestUsers(helperIds);
  await getPool().end();
}
