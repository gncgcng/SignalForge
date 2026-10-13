// Pivot phase 3, test 5: paid access is decided by one server-side function (hasPaidAccess) and every paid
// endpoint checks it. Free accounts keep levels on BTC-USD and ETH-USD; My trades stays readable and exportable
// after a subscription ends. DB-backed (local docker-compose Postgres); no network.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

Object.assign(process.env, {
  NODE_ENV: "development",
  STRIPE_SECRET_KEY: "sk_test_fake_access",
  STRIPE_PRICE_MONTHLY: "price_fake_monthly",
  STRIPE_PRICE_ANNUAL: "price_fake_annual"
});
delete process.env.TELEGRAM_BOT_TOKEN;

const { getPool, query } = await import("../src/db/client.js");
const { findUserById } = await import("../src/db/repositories.js");
const access = await import("../src/modules/subscriptions/subscriptionService.js");
const { handleSignalRoutes } = await import("../src/modules/signals/signalController.js");
const { handleNotificationRoutes } = await import("../src/modules/notifications/notificationController.js");
const { enqueueMatchingTelegramNotifications } = await import("../src/modules/notifications/notificationService.js");
const { handleBacktestRoutes } = await import("../src/modules/backtesting/backtestController.js");
const { handlePerformanceRoutes } = await import("../src/modules/performance/performanceController.js");
const { handleRealTradeRoutes } = await import("../src/modules/real-trades/realTradeController.js");
const fixtures = await import("./account-deletion-fixtures.js");

const results = {};
const helperIds = [];
const tag = Date.now().toString(36);

// ---- the one function ----
const user = (status, extra = {}) => ({
  id: "u", role: "user", email: "x@example.test",
  subscription: { status, providerSubscriptionId: status === "none" ? null : "sub_x", stripeMode: "test", ...extra }
});
const matrix = Object.fromEntries(["none", "trialing", "active", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]
  .map((status) => [status, access.hasPaidAccess(user(status))]));
assert.deepEqual(matrix, {
  none: false, trialing: true, active: true, past_due: true, canceled: false, unpaid: false,
  incomplete: false, incomplete_expired: false, paused: false
});
assert.equal(access.hasPaidAccess(user("active", { stripeMode: "live" })), false, "a subscription from the other Stripe mode never counts");
assert.equal(access.hasPaidAccess(user("trialing", { providerSubscriptionId: null })), false, "the old 'trialing' default is not a trial");
assert.equal(access.hasPaidAccess({ ...user("none"), role: "tester" }), true);
assert.equal(access.isPastDue(user("past_due")), true);
assert.deepEqual(access.FREE_LEVEL_MARKETS, ["BTC-USD", "ETH-USD"]);
assert.equal(access.canViewLevels(user("none"), "btc-usd"), true);
assert.equal(access.canViewLevels(user("none"), "SOL-USD"), false);
assert.equal(access.canViewLevels(user("trialing"), "SOL-USD"), true);
results.hasPaidAccess = matrix;

// ---- endpoints ----
async function call(handler, reqUser, method, path, body, url = null) {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Object.assign(Readable.from(raw), { method, user: reqUser, headers: {} });
  const res = {
    statusCode: 0, headers: {}, body: "",
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; },
    end(chunk = "") { this.body += chunk; }
  };
  const handled = await handler(req, res, path, url || new URL(`http://localhost${path}`));
  assert.notEqual(handled, false, `${method} ${path} not handled`);
  let json = null;
  try { json = JSON.parse(res.body); } catch { json = null; }
  return { status: res.statusCode, json, text: res.body };
}

async function makeUser(name, status, { subscriptionId = null } = {}) {
  const id = await fixtures.createHelperUser(`acc_${name}`);
  helperIds.push(id);
  await query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [id]);
  await query(`INSERT INTO subscriptions (id, user_id, status, provider_subscription_id, stripe_mode, provider_customer_id)
    VALUES ($1, $2, $3, $4, 'test', $5)`, [`sub_row_${id}`, id, status, subscriptionId, subscriptionId ? `cus_${id}` : null]);
  return id;
}

// A ready, unexpired setup in the account's scan-all cache, as a scan would leave it (levels are hidden in the
// scan response; viewing them saves the signal).
async function seedReadySetup(userId, symbol) {
  const generatedAt = new Date().toISOString();
  const setupKey = `${symbol}:1h:long:${tag}:${userId}`;
  const setup = {
    id: `sig_${tag}_${symbol}_${userId}`.replace(/[^A-Za-z0-9_]/g, "_"),
    setupKey, symbol, timeframe: "1h", direction: "long", resultType: "ready_signal", status: "Active",
    validationPassed: true, readinessScore: 82, entryPrice: 100, stopLoss: 98, takeProfit: 104, riskRewardRatio: 2,
    confidenceScore: 80, qualityScore: 70, setupType: "Momentum breakout", reasoning: "Fixture setup.",
    confirmations: [], indicators: {}, marketSource: "fixture", generatedAt,
    validUntil: new Date(Date.now() + 3 * 3600 * 1000).toISOString()
  };
  await query(`INSERT INTO scan_result_cache (user_id, scan_key, result_json, expires_at)
    VALUES ($1, $2, $3, now() + interval '1 hour')
    ON CONFLICT (user_id, scan_key) DO UPDATE SET result_json = EXCLUDED.result_json, expires_at = EXCLUDED.expires_at`,
  [userId, `scan-all:${tag}:${symbol}`, JSON.stringify({ fullSetups: [setup] })]);
  return setup;
}

const viewLevels = (reqUser, setup) => call(handleSignalRoutes, reqUser, "POST", "/api/signals/generate",
  { symbol: setup.symbol, timeframe: setup.timeframe, setupKey: setup.setupKey });

try {
  const freeId = await makeUser("free", "none");
  const trialId = await makeUser("trial", "trialing", { subscriptionId: `sub_trial_${tag}` });
  const canceledId = await makeUser("canceled", "active", { subscriptionId: `sub_cancel_${tag}` });
  const free = await findUserById(freeId);
  const trial = await findUserById(trialId);
  let canceled = await findUserById(canceledId);
  assert.equal(access.hasPaidAccess(free), false);
  assert.equal(access.hasPaidAccess(trial), true);

  const endpoints = {};
  const record = (name, freeStatus, paidStatus) => { endpoints[name] = { free: freeStatus, paid: paidStatus }; };

  // Levels: BTC/ETH free; other markets paid.
  const freeBtc = await viewLevels(free, await seedReadySetup(freeId, "BTC-USD"));
  assert.equal(freeBtc.status, 201, freeBtc.text);
  assert.equal(freeBtc.json.signal.entryPrice, 100, "a free account sees BTC-USD levels");
  const freeEth = await viewLevels(free, await seedReadySetup(freeId, "ETH-USD"));
  assert.equal(freeEth.status, 201, freeEth.text);
  const freeSol = await viewLevels(free, await seedReadySetup(freeId, "SOL-USD"));
  assert.equal(freeSol.status, 402);
  assert.equal(freeSol.json.error.message, "Start your 7-day free trial to see levels on every market.");
  assert.equal(freeSol.json.error.details.code, "PAID_ACCESS_REQUIRED");
  const trialSol = await viewLevels(trial, await seedReadySetup(trialId, "SOL-USD"));
  assert.equal(trialSol.status, 201, trialSol.text);
  assert.equal(trialSol.json.signal.stopLoss, 98);
  record("POST /api/signals/generate (SOL-USD levels)", freeSol.status, trialSol.status);
  endpoints["POST /api/signals/generate (BTC-USD, ETH-USD levels)"] = { free: freeBtc.status, freeEth: freeEth.status };
  assert.equal(Number((await query(`SELECT COUNT(*)::integer AS n FROM signal_credit_transactions WHERE user_id = ANY($1)`, [[freeId, trialId]])).rows[0].n), 0, "no credit is charged");

  await query(`INSERT INTO telegram_notification_queue (id, user_id, setup_key, chat_id, payload, status)
    VALUES ($1, $2, $3, 'chat', $4, 'sent')`, [`tq_${tag}`, freeId, `tg_${tag}`, JSON.stringify({ symbol: "SOL-USD", timeframe: "1h", setupKey: `tg_${tag}` })]);
  const tgUnlock = await call(handleSignalRoutes, free, "POST", "/api/signals/telegram-unlock", { setupKey: `tg_${tag}` });
  assert.equal(tgUnlock.status, 402);
  endpoints["POST /api/signals/telegram-unlock (SOL-USD)"] = { free: tgUnlock.status };

  // Telegram alerts.
  for (const [method, path, body] of [
    ["POST", "/api/notifications/telegram/connect/start", {}],
    ["POST", "/api/notifications/telegram/connect", { chatId: "123" }],
    ["POST", "/api/notifications/telegram/test", {}],
    ["PUT", "/api/notifications/telegram/preferences", { chatId: "123" }],
    ["PUT", "/api/notifications/telegram/enabled", { enabled: true }]
  ]) {
    const freeResponse = await call(handleNotificationRoutes, free, method, path, body);
    const paidResponse = await call(handleNotificationRoutes, trial, method, path, body);
    assert.equal(freeResponse.status, 402, `${method} ${path}`);
    assert.notEqual(paidResponse.status, 402, `${method} ${path} with access: ${paidResponse.text}`);
    record(`${method} ${path}`, freeResponse.status, paidResponse.status);
  }
  const off = await call(handleNotificationRoutes, free, "PUT", "/api/notifications/telegram/enabled", { enabled: false });
  assert.notEqual(off.status, 402, "turning alerts off is always allowed");
  assert.notEqual((await call(handleNotificationRoutes, free, "GET", "/api/notifications/telegram")).status, 402, "settings stay readable");
  assert.deepEqual(await enqueueMatchingTelegramNotifications(free, [{ setupKey: "x" }]), [], "no alerts are queued for a free account");

  // Backtesting and performance.
  for (const [handler, method, path] of [
    // An unsupported market fails validation right after the paywall, so the test needs no candle data.
    [handleBacktestRoutes, "GET", "/api/backtesting?symbol=NOT-A-MARKET&timeframe=1h"],
    [handleBacktestRoutes, "POST", "/api/backtesting/run"],
    [handlePerformanceRoutes, "GET", "/api/performance"]
  ]) {
    const pathname = path.split("?")[0];
    const url = new URL(`http://localhost${path}`);
    const body = method === "POST" ? { symbol: "NOT-A-MARKET", timeframe: "1h" } : undefined;
    const freeResponse = await call((req, res) => handler(req, res, pathname, url), free, method, pathname, body);
    const paidResponse = await call((req, res) => handler(req, res, pathname, url), trial, method, pathname, body);
    assert.equal(freeResponse.status, 402, path);
    assert.equal(freeResponse.json.error.details.code, "PAID_ACCESS_REQUIRED");
    assert.notEqual(paidResponse.status, 402, `${path} with access`);
    record(`${method} ${pathname}`, freeResponse.status, paidResponse.status);
  }
  assert.equal(endpoints["GET /api/performance"].paid, 200);
  assert.equal(endpoints["GET /api/backtesting"].paid, 400, "past the paywall: the market is validated");

  // My trades: writes need the plan; reading, exporting and deleting never do.
  const trade = { status: "open", market: "BTC-USD", direction: "long", entryPrice: 100, stopPrice: 99, sizeUnits: 1, openedAt: "2026-01-05T10:00:00Z" };
  const freePost = await call(handleRealTradeRoutes, free, "POST", "/api/trades", trade);
  const paidPost = await call(handleRealTradeRoutes, canceled, "POST", "/api/trades", trade);
  assert.equal(freePost.status, 402);
  assert.equal(paidPost.status, 201, paidPost.text);
  record("POST /api/trades", freePost.status, paidPost.status);
  const tradeId = paidPost.json.trade.id;
  const second = (await call(handleRealTradeRoutes, canceled, "POST", "/api/trades", { ...trade, market: "ETH-USD" })).json.trade.id;

  // The subscription ends.
  await query(`UPDATE subscriptions SET status = 'canceled', provider_subscription_id = NULL WHERE user_id = $1`, [canceledId]);
  canceled = await findUserById(canceledId);
  assert.equal(access.hasPaidAccess(canceled), false);
  const afterList = await call(handleRealTradeRoutes, canceled, "GET", "/api/trades");
  const afterExport = await call(handleRealTradeRoutes, canceled, "GET", "/api/trades/export.csv");
  const afterPost = await call(handleRealTradeRoutes, canceled, "POST", "/api/trades", trade);
  const afterPatch = await call(handleRealTradeRoutes, canceled, "PATCH", `/api/trades/${tradeId}`, { notes: "edit" });
  const afterDelete = await call(handleRealTradeRoutes, canceled, "DELETE", `/api/trades/${second}`);
  assert.equal(afterList.status, 200);
  assert.equal(afterList.json.trades.length, 2, "the list stays readable");
  assert.equal(afterExport.status, 200);
  assert.ok(afterExport.text.includes(tradeId), "the export still has the trades");
  assert.equal(afterPost.status, 402, "adding is locked after cancellation");
  assert.equal(afterPatch.status, 402, "editing is locked after cancellation");
  assert.equal(afterPatch.json.error.message, "Adding and editing trades is part of the SignalForge plan. Your trades stay readable and exportable.");
  assert.equal(afterDelete.status, 200, "deleting your own data is never locked");
  results.myTradesAfterCancel = { list: afterList.status, export: afterExport.status, add: afterPost.status, edit: afterPatch.status, delete: afterDelete.status };

  // Pages without an endpoint (the trade checker is computed in the browser) are gated in the client too.
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /const PAID_VIEWS = new Set\(\["trade-check", "backtesting", "performance"\]\)/);
  assert.match(app, /classList\.toggle\("my-trades-read-only", myTradesLocked\)/, "My trades turns read-only, not hidden");
  results.endpoints = endpoints;
  console.log(JSON.stringify(results, null, 2));
} finally {
  await query(`DELETE FROM telegram_notification_queue WHERE user_id = ANY($1)`, [helperIds]);
  await query(`DELETE FROM real_trades WHERE user_id = ANY($1)`, [helperIds]);
  await query(`DELETE FROM product_analytics_events WHERE user_id = ANY($1)`, [helperIds]);
  await fixtures.cleanupTestUsers(helperIds);
  await getPool().end();
}
