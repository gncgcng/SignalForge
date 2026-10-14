// Pivot phase 3: checkout payload, webhook event sequences, the $0 trial invoice, one trial per card, refunds.
// DB-backed (local docker-compose Postgres) with Stripe and Resend replaced by an in-memory fake: no network.
import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { installFakeStripe, settle } from "./test-support/fake-stripe.js";

Object.assign(process.env, {
  NODE_ENV: "development",
  STRIPE_SECRET_KEY: "sk_test_fake_billing",
  STRIPE_WEBHOOK_SECRET: "whsec_fake_billing",
  STRIPE_PRICE_MONTHLY: "price_fake_monthly",
  STRIPE_PRICE_ANNUAL: "price_fake_annual",
  BILLING_CHECKOUT_ENABLED: "true",
  TRIAL_IDENTITY_SECRET: "fake-trial-identity-secret",
  EMAIL_FEATURES_ENABLED: "true",
  RESEND_API_KEY: "re_fake_billing",
  APP_URL: "http://localhost:4173"
});

const fake = installFakeStripe();
const { getPool, query } = await import("../src/db/client.js");
const { appConfig } = await import("../src/config/appConfig.js");
const { findUserById, claimTrialIdentities } = await import("../src/db/repositories.js");
const { trialIdentities } = await import("../src/modules/auth/trialIdentity.js");
const stripe = await import("../src/modules/subscriptions/stripeService.js");
const { getSubscriptionSummary, hasPaidAccess } = await import("../src/modules/subscriptions/subscriptionService.js");
const { getBillingAdminSummary } = await import("../src/modules/subscriptions/billingRepository.js");
const { handleSubscriptionRoutes } = await import("../src/modules/subscriptions/subscriptionController.js");
const fixtures = await import("./account-deletion-fixtures.js");

const results = {};
const helperIds = [];
let eventSeq = 0;
const tag = Date.now().toString(36);

async function makeUser(name) {
  const id = await fixtures.createHelperUser(`bill_${name}`);
  helperIds.push(id);
  await query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [id]);
  await query(`INSERT INTO subscriptions (id, user_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [`sub_row_${id}`, id]);
  return id;
}
const load = (id) => findUserById(id);
const event = (type, object, id = `evt_${tag}_${++eventSeq}`) => ({ id, type, livemode: false, data: { object } });
const process_ = (type, object, id) => stripe.processStripeEvent(event(type, object, id));
const emailsTo = (userId) => fake.state.emails.filter((email) => email.to === `${userId}@example.test`.toLowerCase());
const commissionCount = async (invoiceId) => Number((await query(`SELECT COUNT(*)::integer AS n FROM affiliate_commissions WHERE stripe_invoice_id = $1`, [invoiceId])).rows[0].n);
const invoice = ({ id, subscription, customer, amount, priceId = "price_fake_monthly", charge = null }) => ({
  id, object: "invoice", customer, subscription, amount_paid: amount, currency: "usd", livemode: false,
  charge, billing_reason: amount ? "subscription_cycle" : "subscription_create",
  status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
  lines: { data: [{ price: { id: priceId }, period: { start: Math.floor(Date.now() / 1000), end: Math.floor(Date.now() / 1000) + 30 * 86400 } }] }
});

// A signed webhook request through the real route, as Stripe sends it.
async function postWebhook(stripeEvent) {
  const body = JSON.stringify(stripeEvent);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");
  const req = Object.assign(Readable.from([Buffer.from(body)]), { method: "POST", headers: { "stripe-signature": `t=${timestamp},v1=${signature}` }, user: null });
  const res = { statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(chunk = "") { this.body += chunk; } };
  await handleSubscriptionRoutes(req, res, "/api/stripe/webhook");
  return { status: res.statusCode, json: JSON.parse(res.body || "{}") };
}

try {
  const affiliateId = await makeUser("affiliate");
  const userA = await makeUser("a");
  const userB = await makeUser("b");
  const userC = await makeUser("c");
  const returning = await makeUser("returning");
  const claimed = await makeUser("claimed");
  await query(`INSERT INTO affiliate_referrals (id, affiliate_user_id, referred_user_id) VALUES ($1, $2, $3)`, [`ref_${tag}`, affiliateId, userA]);

  // ---- 1. Checkout ----
  const checkout = {};
  const monthly = await stripe.createCheckout(await load(userA), { interval: "month" });
  let session = fake.callsTo("POST", "/checkout/sessions").at(-1).params;
  assert.equal(session.mode, "subscription");
  assert.equal(session["line_items[0][price]"], "price_fake_monthly");
  assert.equal(session["subscription_data[trial_period_days]"], "7");
  assert.equal(session.payment_method_collection, "always");
  assert.equal(session.client_reference_id, userA);
  assert.equal(session.allow_promotion_codes, undefined, "promotion codes off");
  assert.ok(session.customer?.startsWith("cus_fake_"), "a Stripe customer is created and reused");
  assert.equal(monthly.trial, true);
  checkout.monthly = { price: session["line_items[0][price]"], trial_period_days: session["subscription_data[trial_period_days]"], payment_method_collection: session.payment_method_collection };
  await stripe.createCheckout(await load(userA), { interval: "year" });
  const annual = fake.callsTo("POST", "/checkout/sessions").at(-1).params;
  assert.equal(annual["line_items[0][price]"], "price_fake_annual");
  assert.equal(annual.customer, session.customer, "the same customer is reused");
  assert.equal(fake.callsTo("POST", "/customers").length, 1);
  checkout.annual = { price: annual["line_items[0][price]"], customerReused: true };

  await query(`UPDATE subscriptions SET first_subscribed_at = now() - interval '90 days' WHERE user_id = $1`, [returning]);
  const noTrial = await stripe.createCheckout(await load(returning), { interval: "month" });
  session = fake.callsTo("POST", "/checkout/sessions").at(-1).params;
  assert.equal(noTrial.trial, false);
  assert.equal(session["subscription_data[trial_period_days]"], undefined, "no trial after an earlier subscription");
  assert.equal(session.payment_method_collection, "always");
  assert.deepEqual(await stripe.getTrialEligibility(await load(returning)), { eligible: false, reason: "previous_subscription" });
  await claimTrialIdentities(trialIdentities({ email: `${claimed}@example.test` }));
  await stripe.createCheckout(await load(claimed), { interval: "month" });
  assert.equal(fake.callsTo("POST", "/checkout/sessions").at(-1).params["subscription_data[trial_period_days]"], undefined, "no trial for a claimed identity");
  assert.deepEqual(await stripe.getTrialEligibility(await load(claimed)), { eligible: false, reason: "trial_used" });
  assert.equal(getSubscriptionSummary(await load(returning), { trialEligible: false }).trialEligible, false);
  checkout.noTrial = ["earlier subscription", "email already had a trial"];

  appConfig.stripe.checkoutEnabled = false;
  const before = fake.state.calls.length;
  await assert.rejects(stripe.createCheckout(await load(userB), { interval: "month" }), (error) => error.code === "checkout_paused" && error.statusCode === 403);
  assert.equal(fake.state.calls.length, before, "a paused checkout makes no Stripe call");
  appConfig.stripe.checkoutEnabled = true;
  await assert.rejects(stripe.createCheckout(await load(userB), { interval: "weekly" }), /Choose monthly or annual billing/);
  checkout.flagOff = "403 checkout_paused, no Stripe call";
  results["1. checkout"] = checkout;

  // ---- 2a. created(trialing) -> $0 invoice -> trial_will_end -> invoice.paid ($9.99) -> active ----
  const cusA = (await load(userA)).subscription.providerCustomerId;
  fake.addCard("pm_card_a", "fp_shared_card");
  const subA = fake.addSubscription({ id: `sub_a_${tag}`, customer: cusA, userId: userA, priceId: "price_fake_monthly", paymentMethod: "pm_card_a" });
  let outcome = await process_("customer.subscription.created", subA);
  await settle();
  let a = await load(userA);
  assert.equal(a.subscription.status, "trialing");
  assert.equal(hasPaidAccess(a), true);
  assert.equal(a.plan, "signalforge");
  assert.ok(a.subscription.firstSubscribedAt);
  assert.match(emailsTo(userA).at(-1).subject, /free trial has started/);
  assert.match(emailsTo(userA).at(-1).text, /Your card will be charged \$9\.99 on \d{1,2} \w{3} \d{4}/);
  assert.equal((await query(`SELECT COUNT(*)::integer AS n FROM trial_card_claims WHERE first_user_id = $1`, [userA])).rows[0].n, 1);

  const emailsBeforeZero = emailsTo(userA).length;
  outcome = await process_("invoice.paid", invoice({ id: `in_zero_${tag}`, subscription: subA.id, customer: cusA, amount: 0 }));
  await settle();
  assert.equal(outcome.action, "zero_amount_invoice_ignored");
  assert.equal(emailsTo(userA).length, emailsBeforeZero, "no confirmation email for the $0 trial invoice");
  assert.equal(await commissionCount(`in_zero_${tag}`), 0, "no commission on $0");
  assert.equal((await query(`SELECT COUNT(*)::integer AS n FROM billing_invoices WHERE stripe_invoice_id = $1`, [`in_zero_${tag}`])).rows[0].n, 0);
  assert.equal((await query(`SELECT unlock_credits_balance FROM credit_balances WHERE user_id = $1`, [userA])).rows[0]?.unlock_credits_balance ?? 0, 0, "no credits");
  results["3. $0 trial invoice"] = { action: outcome.action, credits: 0, confirmationEmail: false, commission: 0 };

  outcome = await process_("customer.subscription.trial_will_end", subA);
  await settle();
  assert.equal(outcome.action, "trial_ending_notified");
  const ending = emailsTo(userA).at(-1);
  assert.match(ending.subject, /Your SignalForge trial ends on \d{1,2} \w{3} \d{4}/);
  assert.match(ending.text, /charged \$9\.99/);
  assert.match(ending.text, /Open Settings → Billing: http:\/\/localhost:4173\/#billing/);

  subA.status = "active";
  subA.trial_end = Math.floor(Date.now() / 1000) - 60;
  outcome = await process_("invoice.paid", invoice({ id: `in_paid_${tag}`, subscription: subA.id, customer: cusA, amount: 999, charge: `ch_a_${tag}` }));
  await settle();
  a = await load(userA);
  assert.equal(outcome.action, "subscription_payment_recorded");
  assert.equal(a.subscription.status, "active");
  assert.equal(hasPaidAccess(a), true);
  assert.equal(await commissionCount(`in_paid_${tag}`), 1, "commission on the first real charge");
  assert.match(emailsTo(userA).at(-1).subject, /subscription is active/);
  const again = await process_("invoice.payment_succeeded", invoice({ id: `in_paid_${tag}`, subscription: subA.id, customer: cusA, amount: 999 }));
  assert.equal(again.action, "invoice_already_recorded", "invoice.payment_succeeded for the same invoice is not counted twice");
  assert.equal(Number((await query(`SELECT COUNT(*)::integer AS n FROM product_analytics_events WHERE event_type = 'trial_converted' AND user_id = $1`, [userA])).rows[0].n), 1,
    "a trial that ran and was then paid is a conversion");
  results["2a. trial -> trial_will_end -> paid -> active"] ={ statuses: ["trialing", "active"], commission: 1, trialEndingEmail: ending.subject };

  // ---- 2b. trial cancel -> deleted: no charge, no commission ----
  const cusB = `cus_b_${tag}`;
  await query(`UPDATE subscriptions SET provider_customer_id = $2, stripe_mode = 'test' WHERE user_id = $1`, [userB, cusB]);
  fake.addCard("pm_card_b", "fp_card_b");
  const subB = fake.addSubscription({ id: `sub_b_${tag}`, customer: cusB, userId: userB, priceId: "price_fake_annual", paymentMethod: "pm_card_b" });
  await process_("customer.subscription.created", subB);
  subB.cancel_at_period_end = true;
  outcome = await process_("customer.subscription.updated", subB);
  await settle();
  assert.equal(outcome.cancellationEmail, true);
  assert.match(emailsTo(userB).at(-1).subject, /subscription is cancelled/);
  assert.match(emailsTo(userB).at(-1).text, /You keep full access until \d{1,2} \w{3} \d{4}/);
  assert.equal(hasPaidAccess(await load(userB)), true, "access continues until the period ends");
  subB.status = "canceled";
  outcome = await process_("customer.subscription.deleted", subB);
  const b = await load(userB);
  assert.equal(b.subscription.status, "canceled");
  assert.equal(hasPaidAccess(b), false);
  assert.equal(outcome.trialCanceled, true);
  assert.equal((await query(`SELECT COUNT(*)::integer AS n FROM billing_invoices WHERE user_id = $1`, [userB])).rows[0].n, 0, "no charge");
  assert.equal((await query(`SELECT COUNT(*)::integer AS n FROM affiliate_commissions c JOIN affiliate_referrals r ON r.id = c.referral_id WHERE r.referred_user_id = $1`, [userB])).rows[0].n, 0);
  results["2b. trial cancel -> deleted"] = { status: b.subscription.status, charges: 0, commission: 0, trialCanceled: true };

  // ---- 2c. invoice.payment_failed -> past_due -> access kept, banner ----
  subA.status = "past_due";
  outcome = await process_("invoice.payment_failed", invoice({ id: `in_failed_${tag}`, subscription: subA.id, customer: cusA, amount: 999 }));
  await settle();
  a = await load(userA);
  assert.equal(a.subscription.status, "past_due");
  assert.equal(hasPaidAccess(a), true, "past_due keeps access");
  assert.equal(getSubscriptionSummary(a).pastDue, true, "the banner flag");
  assert.match(emailsTo(userA).at(-1).text, /open Settings → Billing, choose Update card/);
  results["2c. payment failed -> past_due"] = { status: "past_due", access: true, bannerFlag: true };

  // ---- 2d. duplicate event -> no-op (200 through the real route) ----
  const duplicateEvent = event("invoice.paid", invoice({ id: `in_dup_${tag}`, subscription: subA.id, customer: cusA, amount: 999 }), `evt_dup_${tag}`);
  subA.status = "active";
  const first = await postWebhook(duplicateEvent);
  const invoicesAfterFirst = (await query(`SELECT COUNT(*)::integer AS n FROM billing_invoices WHERE user_id = $1`, [userA])).rows[0].n;
  const second = await postWebhook(duplicateEvent);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate, true);
  assert.equal((await query(`SELECT COUNT(*)::integer AS n FROM billing_invoices WHERE user_id = $1`, [userA])).rows[0].n, invoicesAfterFirst);
  results["2d. duplicate event"] = { firstStatus: first.status, secondStatus: second.status, duplicate: true };

  // ---- 2e. unknown price -> 200 and an anomaly ----
  const unknownSub = fake.addSubscription({ id: `sub_unknown_${tag}`, customer: cusB, userId: userB, priceId: `price_unknown_${tag}` });
  const unknown = await postWebhook(event("customer.subscription.created", unknownSub));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.action, "unknown_price_ignored");
  assert.equal(hasPaidAccess(await load(userB)), false, "an unknown price grants nothing");
  const unknownInvoice = await postWebhook(event("invoice.paid", invoice({ id: `in_unknown_${tag}`, subscription: unknownSub.id, customer: cusB, amount: 1500, priceId: `price_unknown_${tag}` })));
  assert.equal(unknownInvoice.status, 200);
  const anomaly = (await query(`SELECT occurrences FROM billing_anomalies WHERE kind = 'unknown_price' AND reference = $1`, [`price_unknown_${tag}`])).rows[0];
  assert.equal(anomaly.occurrences, 2, "one anomaly row, counted twice (logged once)");
  assert.equal((await query(`SELECT COUNT(*)::integer AS n FROM billing_invoices WHERE stripe_invoice_id = $1`, [`in_unknown_${tag}`])).rows[0].n, 0);
  results["2e. unknown price"] = { status: unknown.status, anomalyOccurrences: anomaly.occurrences, granted: false };

  // ---- 4. one trial per card ----
  const cusC = `cus_c_${tag}`;
  await query(`UPDATE subscriptions SET provider_customer_id = $2, stripe_mode = 'test' WHERE user_id = $1`, [userC, cusC]);
  fake.addCard("pm_card_c", "fp_shared_card");
  const subC = fake.addSubscription({ id: `sub_c_${tag}`, customer: cusC, userId: userC, priceId: "price_fake_monthly", paymentMethod: "pm_card_c" });
  outcome = await process_("customer.subscription.created", subC);
  await settle();
  const trialEndCalls = fake.callsTo("POST", `/subscriptions/${subC.id}`);
  assert.equal(trialEndCalls.length, 1);
  assert.equal(trialEndCalls[0].params.trial_end, "now");
  assert.deepEqual(outcome.trial, { ended: true, reason: "card_already_used" });
  assert.match(emailsTo(userC).at(-1).text, /This card was already used for a free trial, so your subscription started today\./);
  // Stripe then sends trial_will_end with the stale payload (still "trialing", the old trial date). The subscription is
  // read again, so no "trial ends" email goes out.
  const emailsBeforeStale = emailsTo(userC).length;
  const stalePayload = { ...subC, status: "trialing", trial_end: Math.floor(Date.now() / 1000) + 7 * 86400 };
  outcome = await process_("customer.subscription.trial_will_end", stalePayload);
  await settle();
  assert.equal(outcome.action, "trial_ending_not_charged");
  assert.equal(emailsTo(userC).length, emailsBeforeStale, "no trial-ending email after the trial was ended");
  // ...and its first charge is not a trial conversion.
  const conversionsBefore = Number((await query(`SELECT COUNT(*)::integer AS n FROM product_analytics_events WHERE event_type = 'trial_converted'`)).rows[0].n);
  outcome = await process_("invoice.paid", invoice({ id: `in_c_${tag}`, subscription: subC.id, customer: cusC, amount: 999 }));
  assert.equal(outcome.action, "subscription_payment_recorded");
  assert.equal(Number((await query(`SELECT COUNT(*)::integer AS n FROM product_analytics_events WHERE event_type = 'trial_converted'`)).rows[0].n), conversionsBefore,
    "a trial ended by the card rule is not a conversion");
  // A trial_will_end whose trial has already passed (Stripe re-read) sends nothing either.
  const endedSub = fake.addSubscription({ id: `sub_ended_${tag}`, customer: cusC, userId: userC, priceId: "price_fake_monthly" });
  endedSub.trial_end = Math.floor(Date.now() / 1000) - 60;
  outcome = await process_("customer.subscription.trial_will_end", endedSub);
  assert.equal(outcome.action, "trial_already_ended");
  // The same account subscribing again with the same card isn't penalised.
  const subA2 = fake.addSubscription({ id: `sub_a2_${tag}`, customer: cusA, userId: userA, priceId: "price_fake_monthly", paymentMethod: "pm_card_a" });
  const callsBefore = fake.callsTo("POST", /^\/subscriptions\//).length;
  outcome = await process_("customer.subscription.created", subA2);
  assert.deepEqual(outcome.trial, { ended: false });
  assert.equal(fake.callsTo("POST", /^\/subscriptions\//).length, callsBefore, "no trial_end=now for the card's own account");
  const storedHash = (await query(`SELECT card_fingerprint_hash FROM trial_card_claims WHERE first_user_id = $1`, [userA])).rows[0].card_fingerprint_hash;
  assert.notEqual(storedHash, "fp_shared_card", "only an HMAC is stored");
  assert.equal(storedHash, stripe.cardFingerprintHash("fp_shared_card"));
  results["4. card fingerprint"] = { secondAccount: "trial_end=now + email", sameAccount: "not penalised", stored: "HMAC only" };

  // ---- 6. refund reverses the commission and corrects revenue ----
  const revenueBefore = await getBillingAdminSummary();
  outcome = await process_("charge.refunded", { id: `ch_a_${tag}`, object: "charge", invoice: `in_paid_${tag}`, amount_refunded: 999 });
  const refunded = (await query(`SELECT amount_refunded_cents FROM billing_invoices WHERE stripe_invoice_id = $1`, [`in_paid_${tag}`])).rows[0];
  const commission = (await query(`SELECT status, reversed_commission_cents, commission_amount_cents FROM affiliate_commissions WHERE stripe_invoice_id = $1`, [`in_paid_${tag}`])).rows[0];
  const revenueAfter = await getBillingAdminSummary();
  assert.equal(outcome.action, "refund_recorded");
  assert.equal(refunded.amount_refunded_cents, 999);
  assert.equal(commission.status, "refunded");
  assert.equal(commission.reversed_commission_cents, commission.commission_amount_cents);
  assert.equal(revenueBefore.revenueLifetimeCents - revenueAfter.revenueLifetimeCents, 999, "revenue drops by the refund");
  results["6. refund"] = { refundedCents: 999, commission: commission.status, revenueDropCents: 999 };

  console.log(JSON.stringify(results, null, 2));
} finally {
  fake.restore();
  await query(`DELETE FROM billing_anomalies WHERE reference LIKE $1`, [`%${tag}%`]);
  await query(`DELETE FROM product_analytics_events WHERE user_id = ANY($1)`, [helperIds]);
  await query(`DELETE FROM affiliate_referrals WHERE referred_user_id = ANY($1)`, [helperIds]);
  await fixtures.cleanupTestUsers(helperIds);
  await getPool().end();
}
