// Admin billing metrics count only the current Stripe mode. Old test-mode subscriptions under the live key (production
// had three 'active' ones) must not show as active subscriptions, MRR, trials or past due. DB-backed (local
// docker-compose Postgres); no network.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";

Object.assign(process.env, {
  NODE_ENV: "development",
  STRIPE_SECRET_KEY: "sk_live_fake_admin_metrics",
  STRIPE_PRICE_MONTHLY: "price_fake_monthly",
  STRIPE_PRICE_ANNUAL: "price_fake_annual"
});

const { getPool, query } = await import("../src/db/client.js");
const { getAdminProductAnalytics, getAdminOperationsDashboard } = await import("../src/db/repositories.js");
const { getBillingAdminSummary } = await import("../src/modules/subscriptions/billingRepository.js");
const { isOtherStripeModeSubscription, countsInCurrentStripeModeSql } = await import("../src/modules/subscriptions/stripeModeFilter.js");
const fixtures = await import("./account-deletion-fixtures.js");

const results = {};
const helperIds = [];
const tag = Date.now().toString(36);

// ---- the SQL filter agrees with isOtherStripeModeSubscription on every combination ----
const matrix = [];
for (const currentMode of ["test", "live", "unknown", "unconfigured"]) {
  for (const rowMode of ["test", "live", null, "unknown"]) {
    const sql = `SELECT ${countsInCurrentStripeModeSql("v.mode", currentMode)} AS counts FROM (VALUES ($1::text)) v(mode)`;
    const counts = (await query(sql, [rowMode])).rows[0].counts;
    assert.equal(counts, !isOtherStripeModeSubscription({ stripeMode: rowMode }, currentMode), `${currentMode}/${rowMode}`);
    matrix.push(`${currentMode}/${rowMode}=${counts}`);
  }
}
results.sqlMatchesJs = matrix;

const metricKeys = ["trialsStarted", "trialsConverted", "trialsCanceled", "trialing", "activeSubscriptions", "pastDue", "monthlyRecurringRevenueCents"];
const pick = (summary) => Object.fromEntries(metricKeys.map((key) => [key, summary[key]]));
const delta = (after, before) => Object.fromEntries(metricKeys.map((key) => [key, after[key] - before[key]]));

async function seedUser(name, status, stripeMode) {
  const id = await fixtures.createHelperUser(`adm_${name}_${tag}`);
  helperIds.push(id);
  await query(`INSERT INTO subscriptions (id, user_id, status, provider_subscription_id, provider_customer_id, stripe_mode)
    VALUES ($1, $2, $3, $4, $5, $6)`, [`sub_row_${id}`, id, status, `sub_${name}_${tag}`, `cus_${name}_${tag}`, stripeMode]);
  return id;
}
async function seedInvoice(userId, name, cents, interval, livemode) {
  await query(`INSERT INTO billing_invoices (stripe_invoice_id, user_id, stripe_subscription_id, amount_paid_cents,
      amount_refunded_cents, currency, billing_interval, livemode, paid_at)
    VALUES ($1, $2, $3, $4, 0, 'usd', $5, $6, now() - interval '1 day')`,
  [`in_${name}_${tag}`, userId, `sub_${name}_${tag}`, cents, interval, livemode]);
}
async function seedEvent(userId, eventType, metadata) {
  await query(`INSERT INTO product_analytics_events (id, event_type, user_id, plan, metadata)
    VALUES ($1, $2, $3, 'signalforge', $4)`, [`pae_${tag}_${helperIds.length}_${eventType}_${Math.random().toString(36).slice(2, 8)}`, eventType, userId, JSON.stringify(metadata)]);
}

try {
  const beforeLive = pick(await getBillingAdminSummary({ mode: "live" }));
  const beforeTest = pick(await getBillingAdminSummary({ mode: "test" }));
  const dashboards = async () => {
    const analytics = await getAdminProductAnalytics();
    const operations = await getAdminOperationsDashboard();
    return {
      paidUsers: analytics.paidUsers,
      analyticsMrr: analytics.monthlyRecurringRevenueCents,
      operationsMrr: operations.overview.revenue.monthlyRecurringRevenueCents,
      newTrialsToday: operations.overview.users.newTrials,
      billingActive: operations.billing.activeSubscriptions
    };
  };
  const beforeDashboards = await dashboards();

  const liveActive = await seedUser("live_active", "active", "live");
  const livePastDue = await seedUser("live_past_due", "past_due", "live");
  const liveTrial = await seedUser("live_trial", "trialing", "live");
  const staleActive = await seedUser("stale_active", "active", "test"); // like the 3 production rows
  const staleTrial = await seedUser("stale_trial", "trialing", "test");
  await seedUser("null_mode", "active", null); // no recorded mode: counts, as hasPaidAccess lets it pay

  await seedInvoice(liveActive, "live_active", 999, "month", true);
  await seedInvoice(livePastDue, "live_past_due", 8999, "year", true);
  await seedInvoice(staleActive, "stale_active", 999, "month", false);

  await seedEvent(liveTrial, "trial_started", { stripeMode: "live" });
  await seedEvent(staleTrial, "trial_started", {}); // an older event: falls back to the row's mode (test)
  await seedEvent(liveActive, "trial_started", { stripeMode: "test" }); // the recorded mode wins over the row's
  await seedEvent(liveActive, "trial_converted", {}); // row mode live
  await seedEvent(liveActive, "trial_canceled", { stripeMode: "live" });
  await seedEvent(staleActive, "trial_canceled", { stripeMode: "test" });

  const liveDelta = delta(pick(await getBillingAdminSummary({ mode: "live" })), beforeLive);
  assert.deepEqual(liveDelta, {
    trialsStarted: 1,
    trialsConverted: 1,
    trialsCanceled: 1,
    trialing: 1,
    activeSubscriptions: 2, // live_active + null_mode; stale_active is left out
    pastDue: 1,
    monthlyRecurringRevenueCents: 999 + 750 // $9.99 monthly + $89.99/12 annual; the stale test invoice adds nothing
  });

  const testDelta = delta(pick(await getBillingAdminSummary({ mode: "test" })), beforeTest);
  assert.deepEqual(testDelta, {
    trialsStarted: 2,
    trialsConverted: 0,
    trialsCanceled: 1,
    trialing: 1,
    activeSubscriptions: 2, // stale_active + null_mode
    pastDue: 0,
    monthlyRecurringRevenueCents: 999
  });
  results.liveModeDelta = liveDelta;
  results.testModeDelta = testDelta;

  // The other admin pages use the same filter (the key in this process is live).
  const afterDashboards = await dashboards();
  const dashboardDelta = Object.fromEntries(Object.keys(afterDashboards).map((key) => [key, afterDashboards[key] - beforeDashboards[key]]));
  assert.deepEqual(dashboardDelta, {
    paidUsers: 3, // live_active, live_past_due, null_mode
    analyticsMrr: 1749,
    operationsMrr: 1749,
    newTrialsToday: 1,
    billingActive: 2
  });
  results.adminDashboardsDelta = dashboardDelta;
  console.log(JSON.stringify(results, null, 2));
} finally {
  await query(`DELETE FROM product_analytics_events WHERE user_id = ANY($1)`, [helperIds]);
  await query(`DELETE FROM subscriptions WHERE user_id = ANY($1)`, [helperIds]);
  await fixtures.cleanupTestUsers(helperIds);
  await getPool().end();
}
