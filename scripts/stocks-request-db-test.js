// "Want stocks & ETFs? Tell us" on the backtesting page: one click per user, counted on the server through the real
// route, and the count shows in Admin analytics. Free users can ask too. No stock data is fetched. Deleting an account
// leaves no request row linked to it, only an anonymous count.
// DB-backed (local docker-compose Postgres); no network.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { Readable } from "node:stream";

Object.assign(process.env, { NODE_ENV: "development", EMAIL_FEATURES_ENABLED: "false" });

const { getPool, query } = await import("../src/db/client.js");
const { createHelperUser } = await import("./account-deletion-fixtures.js");
const { getAdminProductAnalytics } = await import("../src/db/repositories.js");
const { handleBacktestRoutes } = await import("../src/modules/backtesting/backtestController.js");
const { deleteAccountData } = await import("../src/modules/account-deletion/accountDeletionRepository.js");

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => { throw new Error(`no network expected: ${input}`); };
const userIds = [];
let anonymousBefore = null;

async function call(method, userId) {
  const req = Readable.from(method === "POST" ? ["{}"] : []);
  Object.assign(req, { method, headers: { "content-type": "application/json" }, user: { id: userId, role: "user", subscription: { status: "none" } } });
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status) { this.statusCode = status; return this; },
    setHeader() {},
    end(body = "") { this.body = String(body); }
  };
  const handled = await handleBacktestRoutes(req, res, "/api/backtesting/stocks-request", new URL("http://localhost/api/backtesting/stocks-request"));
  assert.notEqual(handled, false, "route handled");
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const count = async () => (await getAdminProductAnalytics()).stocksEtfsRequests;

try {
  const before = await count();
  const first = await createHelperUser("stocks1");
  const second = await createHelperUser("stocks2");
  userIds.push(first, second);

  assert.deepEqual(await call("GET", first), { status: 200, body: { requested: false } });
  assert.deepEqual(await call("POST", first), { status: 200, body: { requested: true, counted: true } });
  assert.equal(await count(), before + 1, "the first click counts");
  assert.deepEqual(await call("POST", first), { status: 200, body: { requested: true, counted: false } });
  assert.deepEqual(await call("POST", first), { status: 200, body: { requested: true, counted: false } });
  assert.equal(await count(), before + 1, "clicking again does not count again");
  assert.deepEqual(await call("GET", first), { status: 200, body: { requested: true } });

  assert.deepEqual(await call("POST", second), { status: 200, body: { requested: true, counted: true } });
  assert.equal(await count(), before + 2, "another user counts");

  // Two clicks at the same time from one user still count once.
  const third = await createHelperUser("stocks3");
  userIds.push(third);
  const racing = await Promise.all([call("POST", third), call("POST", third), call("POST", third)]);
  assert.equal(racing.filter((response) => response.body.counted).length, 1);
  assert.equal(await count(), before + 3);

  // Signed-out requests are refused.
  const res = { statusCode: 0, body: "", writeHead(status) { this.statusCode = status; return this; }, setHeader() {}, end(body = "") { this.body = String(body); } };
  await handleBacktestRoutes({ method: "POST", headers: {} }, res, "/api/backtesting/stocks-request", new URL("http://localhost/api/backtesting/stocks-request"));
  assert.equal(res.statusCode, 401);
  assert.equal(await count(), before + 3);

  // Deleting an account removes its request rows; only an anonymous number per feature is kept, so the total holds.
  const anonymous = async () => (await query("SELECT count FROM feature_request_anonymous_counts WHERE feature = 'stocks_etfs'")).rows[0]?.count || 0;
  anonymousBefore = await anonymous();
  await deleteAccountData({ userId: first, email: `${first}@example.test`, loginEmailHash: null });
  assert.equal((await query("SELECT COUNT(*)::integer AS n FROM feature_requests WHERE user_id = $1", [first])).rows[0].n, 0,
    "no request row stays linked to the deleted user");
  assert.equal(await anonymous(), anonymousBefore + 1, "kept as an anonymous count");
  assert.equal(await count(), before + 3, "Admin total unchanged by the deletion");
  const columns = (await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'feature_request_anonymous_counts' ORDER BY column_name`)).rows.map((row) => row.column_name);
  assert.deepEqual(columns, ["count", "feature"], "the anonymous table has no user column");

  console.log(JSON.stringify({ before, after: await count(), anonymous: await anonymous() }, null, 2));
} finally {
  globalThis.fetch = realFetch;
  if (userIds.length) {
    await query("DELETE FROM feature_requests WHERE user_id = ANY($1)", [userIds]);
    if (anonymousBefore !== null) {
      await query("UPDATE feature_request_anonymous_counts SET count = $1 WHERE feature = 'stocks_etfs'", [anonymousBefore]);
    }
    await query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  }
  await getPool().end();
}
