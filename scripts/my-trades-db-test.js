// "My trades" (pivot phase 2c), DB-backed: ownership (another user's trade is a 404 and stays unchanged), account
// deletion leaves no rows, the per-user cap, validation through the API, CSV export, and migration 067 on a fresh
// database and on one at 066. Requires DATABASE_URL (local docker-compose Postgres).
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";

process.env.NODE_ENV = "development";
delete process.env.STRIPE_SECRET_KEY;

const { getPool, query } = await import("../src/db/client.js");
const { handleRealTradeRoutes } = await import("../src/modules/real-trades/realTradeController.js");
const { MAX_TRADES_PER_USER } = await import("../src/modules/real-trades/realTradeService.js");
const { deleteAccountData } = await import("../src/modules/account-deletion/accountDeletionRepository.js");
const { loadTrackRecords } = await import("../src/modules/track-records/trackRecordService.js");
const fixtures = await import("./account-deletion-fixtures.js");

loadTrackRecords();
const results = {};
const helperIds = [];

// Drives the real route handler with a fake request/response, as the server would.
async function call(user, method, path, body) {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const req = Object.assign(Readable.from(raw), { method, user, headers: {} });
  const res = {
    statusCode: 0, headers: {}, body: "",
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; },
    end(chunk = "") { this.body += chunk; }
  };
  const handled = await handleRealTradeRoutes(req, res, path);
  assert.equal(handled, true, `${method} ${path} not handled`);
  const json = res.headers["content-type"]?.startsWith("application/json") ? JSON.parse(res.body) : null;
  return { status: res.statusCode, json, text: res.body, headers: res.headers };
}

const row = (id) => query(`SELECT * FROM real_trades WHERE id = $1`, [id]).then((result) => result.rows[0] || null);
const TRADE = { status: "open", market: "btc-usd", direction: "long", entryPrice: 100, stopPrice: 99, targetPrice: 102, sizeUnits: 10, openedAt: "2026-01-05T10:00:00Z", notes: "plan" };

try {
  // Pivot phase 3: adding and editing trades needs the paid plan; these accounts are in their trial.
  const PAID = { role: "user", subscription: { status: "trialing", providerSubscriptionId: "sub_my_trades" } };
  const userA = { id: await fixtures.createHelperUser("rt_a"), ...PAID };
  const userB = { id: await fixtures.createHelperUser("rt_b"), ...PAID };
  helperIds.push(userA.id, userB.id);

  // ---- create, list, close ----
  const created = await call(userB, "POST", "/api/trades", TRADE);
  assert.equal(created.status, 201, created.text);
  const bTrade = created.json.trade;
  assert.equal(bTrade.market, "BTC-USD");
  assert.equal(bTrade.status, "open");
  const closed = await call(userB, "PATCH", `/api/trades/${bTrade.id}`, { status: "closed", exitPrice: 102, closedAt: "2026-01-05T12:00:00Z" });
  assert.equal(closed.status, 200, closed.text);
  assert.equal(closed.json.trade.exitPrice, 102);
  assert.equal(closed.json.trade.notes, "plan", "a partial update keeps the other fields");
  const bBefore = await row(bTrade.id);
  assert.equal(bBefore.entry_price, "100"); // numeric, not float
  results["create, close and list own trades"] = true;

  // ---- ownership: A can't read, edit, delete or export B's trade; each is a 404 and B's row is unchanged ----
  const ownership = {};
  const listA = await call(userA, "GET", "/api/trades");
  assert.equal(listA.status, 200);
  assert.deepEqual(listA.json.trades, []);
  ownership.list = "A sees 0 trades";
  for (const [label, method, body] of [
    ["edit", "PATCH", { market: "HACKED", notes: "x" }],
    ["close", "PATCH", { status: "closed", exitPrice: 1, closedAt: "2026-01-06T00:00:00Z" }],
    ["delete", "DELETE", undefined]
  ]) {
    const response = await call(userA, method, `/api/trades/${bTrade.id}`, body);
    assert.equal(response.status, 404, `${label}: ${response.text}`);
    assert.equal(response.json.error.message, "Trade not found.");
    ownership[label] = 404;
  }
  const missing = await call(userA, "PATCH", "/api/trades/rt_doesnotexist", { notes: "x" });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.message, "Trade not found.", "a missing id and someone else's id look the same");
  const exportA = await call(userA, "GET", "/api/trades/export.csv");
  assert.equal(exportA.status, 200);
  assert.equal(exportA.text.trim().split("\r\n").length, 1, "A's export has only the header");
  assert.ok(!exportA.text.includes(bTrade.id));
  ownership.export = "header only, B's id absent";
  assert.deepEqual(await row(bTrade.id), bBefore, "B's row changed");
  ownership.bRowUnchanged = true;
  const unauthenticated = await call(null, "GET", "/api/trades");
  assert.equal(unauthenticated.status, 401);
  ownership.signedOut = 401;
  results.ownership = ownership;

  // ---- export for the owner: injection guard on the stored note ----
  await call(userB, "PATCH", `/api/trades/${bTrade.id}`, { notes: "=HYPERLINK(\"http://x\"), \"quoted\"" });
  const exportB = await call(userB, "GET", "/api/trades/export.csv");
  assert.equal(exportB.headers["content-type"], "text/csv; charset=utf-8");
  assert.match(exportB.headers["content-disposition"], /attachment; filename="my-trades.csv"/);
  assert.ok(exportB.text.includes(`"'=HYPERLINK(""http://x""), ""quoted"""`), exportB.text);
  results["CSV export through the API"] = true;

  // ---- validation through the API: clear 400s ----
  const validation = {};
  for (const [label, body, message] of [
    ["stop on the wrong side", { ...TRADE, stopPrice: 101 }, "For a long trade, the stop must be below the entry price."],
    ["closed without exit", { ...TRADE, status: "closed" }, "A closed trade needs its exit price and close time."],
    ["closed_at before opened_at", { ...TRADE, status: "closed", exitPrice: 102, closedAt: "2026-01-05T09:00:00Z" }, "The close time can't be before the open time."]
  ]) {
    const response = await call(userA, "POST", "/api/trades", body);
    assert.equal(response.status, 400, label);
    assert.equal(response.json.error.message, message, label);
    validation[label] = `400 ${message}`;
  }
  const tooBig = await call(userA, "POST", "/api/trades", { ...TRADE, notes: "x".repeat(20 * 1024) });
  assert.equal(tooBig.status, 413, "body over 16 KB");
  validation["body over 16 KB"] = 413;
  const badJson = await call(userA, "POST", "/api/trades", "{nope");
  assert.equal(badJson.status, 400);

  // Per-user cap: fill A to the limit directly, then one more through the API.
  await query(`
    INSERT INTO real_trades (id, user_id, status, market, direction, entry_price, stop_price, size_units, opened_at)
    SELECT 'rt_cap_' || g || '_' || $1, $1, 'open', 'BTC-USD', 'long', 100, 99, 1, now() - (g || ' minutes')::interval
    FROM generate_series(1, $2::integer) AS g
  `, [userA.id, MAX_TRADES_PER_USER]);
  const capped = await call(userA, "POST", "/api/trades", TRADE);
  assert.equal(capped.status, 400);
  assert.equal(capped.json.error.message, "You've reached the limit of 5,000 logged trades. Delete or export older trades to add more.");
  validation["per-user cap"] = `400 ${capped.json.error.message}`;
  assert.equal((await query(`SELECT COUNT(*)::integer AS n FROM real_trades WHERE user_id = $1`, [userA.id])).rows[0].n, MAX_TRADES_PER_USER);
  results.validation = validation;

  // ---- the database enforces the same rules if the API is bypassed ----
  await assert.rejects(query(`INSERT INTO real_trades (id, user_id, status, market, direction, entry_price, stop_price, size_units, opened_at)
    VALUES ('rt_bad_side', $1, 'open', 'BTC-USD', 'long', 100, 101, 1, now())`, [userB.id]), /real_trades_stop_side_check/);
  await assert.rejects(query(`INSERT INTO real_trades (id, user_id, status, market, direction, entry_price, stop_price, size_units, opened_at)
    VALUES ('rt_bad_close', $1, 'closed', 'BTC-USD', 'long', 100, 99, 1, now())`, [userB.id]), /real_trades_closed_fields_check/);
  await assert.rejects(query(`INSERT INTO real_trades (id, user_id, status, market, direction, entry_price, stop_price, size_units, opened_at, exit_price, closed_at)
    VALUES ('rt_bad_time', $1, 'closed', 'BTC-USD', 'long', 100, 99, 1, now(), 101, now() - interval '1 hour')`, [userB.id]), /real_trades_close_after_open_check/);
  results["database constraints"] = true;

  // ---- delete own trade ----
  const second = (await call(userB, "POST", "/api/trades", { ...TRADE, market: "eth-usd" })).json.trade;
  assert.equal((await call(userB, "DELETE", `/api/trades/${second.id}`)).status, 200);
  assert.equal(await row(second.id), null);
  assert.equal((await call(userB, "DELETE", `/api/trades/${second.id}`)).status, 404);
  results["delete own trade"] = true;

  // ---- account deletion: zero rows left, on the real path and through the cascade ----
  const deletion = {};
  const before = (await query(`SELECT COUNT(*)::integer AS n FROM real_trades WHERE user_id = $1`, [userB.id])).rows[0].n;
  assert.ok(before >= 1);
  const email = (await query(`SELECT email FROM users WHERE id = $1`, [userB.id])).rows[0].email;
  await deleteAccountData({ userId: userB.id, email });
  const usersRow = (await query(`SELECT account_status FROM users WHERE id = $1`, [userB.id])).rows[0];
  assert.equal(usersRow.account_status, "deleted", "the deletion path anonymizes the users row and keeps it");
  deletion.accountDeletionPath = { before, after: (await query(`SELECT COUNT(*)::integer AS n FROM real_trades WHERE user_id = $1`, [userB.id])).rows[0].n };
  assert.equal(deletion.accountDeletionPath.after, 0);
  // The cascade, for a hard delete of the users row.
  const userC = await fixtures.createHelperUser("rt_c");
  helperIds.push(userC);
  await call({ id: userC, ...PAID }, "POST", "/api/trades", TRADE);
  await query(`DELETE FROM users WHERE id = $1`, [userC]);
  deletion.cascade = { after: (await query(`SELECT COUNT(*)::integer AS n FROM real_trades WHERE user_id = $1`, [userC])).rows[0].n };
  assert.equal(deletion.cascade.after, 0);
  results.accountDeletion = deletion;

  // ---- migration 067 on a fresh database and on a database at 066 ----
  const migration = {};
  const base = new URL(process.env.DATABASE_URL);
  const scratch = `sf_mytrades_migration_${process.pid}`;
  await query(`DROP DATABASE IF EXISTS ${scratch}`);
  await query(`CREATE DATABASE ${scratch}`);
  try {
    const url = new URL(base);
    url.pathname = `/${scratch}`;
    const migrate = () => spawnSync(process.execPath, ["scripts/db-migrate.js"], { env: { ...process.env, DATABASE_URL: url.toString() }, encoding: "utf8" });
    const fresh = migrate();
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.match(fresh.stdout, /\[database\] Applied migration 067_real_trades\.sql/);
    migration.fresh = "applied 001..067";
    // Back to 066, then forward again.
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(`DROP TABLE real_trades; DELETE FROM schema_migrations WHERE filename = '067_real_trades.sql'`);
    // 067 is undone; 066 (and any later migration, e.g. 068) stays applied.
    const applied = (await client.query(`SELECT filename FROM schema_migrations`)).rows.map((row) => row.filename);
    assert.ok(applied.includes("066_trial_identity_claims.sql"));
    assert.ok(!applied.includes("067_real_trades.sql"));
    const at066 = migrate();
    assert.equal(at066.status, 0, at066.stderr);
    assert.equal(at066.stdout.trim().split("\n").filter((line) => line.includes("Applied migration")).join("|"), "[database] Applied migration 067_real_trades.sql");
    const index = (await client.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_real_trades_user_opened'`)).rows[0];
    assert.match(index.indexdef, /\(user_id, opened_at DESC\)/);
    const fk = (await client.query(`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'real_trades'::regclass AND contype = 'f'`)).rows[0];
    assert.equal(fk.confdeltype, "c", "user_id is ON DELETE CASCADE");
    const types = (await client.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'real_trades'
      AND column_name IN ('entry_price', 'stop_price', 'target_price', 'size_units', 'exit_price', 'fees_paid', 'fee_rate_pct')`)).rows;
    assert.ok(types.length === 7 && types.every((column) => column.data_type === "numeric"), JSON.stringify(types));
    await client.end();
    migration.at066 = "applied only 067";
    migration.index = "(user_id, opened_at DESC)";
    migration.cascade = "ON DELETE CASCADE";
  } finally {
    // FORCE: a failed assertion can leave the scratch connection open; don't let cleanup hang and hide it.
    await query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  }
  results.migration = migration;

  console.log(JSON.stringify(results, null, 2));
} finally {
  await query(`DELETE FROM real_trades WHERE user_id = ANY($1)`, [helperIds]);
  await fixtures.cleanupTestUsers(helperIds);
  await getPool().end();
}
