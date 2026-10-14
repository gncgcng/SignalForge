import { query } from "../../db/client.js";
import { createId } from "../../shared/ids.js";

// Things the webhook refused to act on. One row per kind + reference; a repeat only bumps the counter.
// Returns { firstTime } so the caller logs each anomaly once.
export async function recordBillingAnomaly({ kind, reference, stripeEventId = null, detail = {} }) {
  const result = await query(`
    INSERT INTO billing_anomalies (id, kind, reference, stripe_event_id, detail)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (kind, reference) DO UPDATE
    SET occurrences = billing_anomalies.occurrences + 1,
      last_seen_at = now(),
      stripe_event_id = COALESCE(EXCLUDED.stripe_event_id, billing_anomalies.stripe_event_id)
    RETURNING (xmax = 0) AS inserted
  `, [createId("bano"), kind, String(reference || "unknown").slice(0, 200), stripeEventId, JSON.stringify(detail || {})]);
  return { firstTime: Boolean(result.rows[0]?.inserted) };
}

export async function listBillingAnomalies({ limit = 20 } = {}) {
  const result = await query(`
    SELECT kind, reference, stripe_event_id, detail, occurrences, first_seen_at, last_seen_at
    FROM billing_anomalies
    ORDER BY last_seen_at DESC
    LIMIT $1
  `, [Math.min(100, Math.max(1, Number(limit) || 20))]);
  return result.rows;
}

// One free trial per card. Returns { claimed: true } for a new fingerprint or one this same account already
// claimed, and { claimed: false, firstUserId } when another account used it first.
export async function claimTrialCard(cardFingerprintHash, userId) {
  const inserted = await query(`
    INSERT INTO trial_card_claims (card_fingerprint_hash, first_user_id)
    VALUES ($1, $2)
    ON CONFLICT (card_fingerprint_hash) DO NOTHING
    RETURNING first_user_id
  `, [cardFingerprintHash, userId]);
  if (inserted.rows[0]) return { claimed: true, firstUserId: userId };
  const existing = await query(`SELECT first_user_id FROM trial_card_claims WHERE card_fingerprint_hash = $1`, [cardFingerprintHash]);
  const firstUserId = existing.rows[0]?.first_user_id || null;
  return { claimed: firstUserId === userId, firstUserId };
}

// An invoice that actually charged money. Returns { inserted } (false for a repeat: invoice.paid and
// invoice.payment_succeeded both arrive for one invoice) and whether it is the subscription's first paid invoice.
export async function recordPaidInvoice({
  invoiceId, userId, subscriptionId, chargeId, amountPaidCents, currency, interval, livemode, paidAt
}) {
  const earlier = subscriptionId
    ? Number((await query(`
      SELECT COUNT(*)::integer AS n FROM billing_invoices
      WHERE stripe_subscription_id = $1 AND stripe_invoice_id <> $2
    `, [subscriptionId, invoiceId])).rows[0].n)
    : 0;
  const result = await query(`
    INSERT INTO billing_invoices (
      stripe_invoice_id, user_id, stripe_subscription_id, stripe_charge_id, amount_paid_cents, currency,
      billing_interval, livemode, paid_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()))
    ON CONFLICT (stripe_invoice_id) DO NOTHING
    RETURNING stripe_invoice_id
  `, [invoiceId, userId, subscriptionId, chargeId, amountPaidCents, currency || "usd", interval, Boolean(livemode), paidAt]);
  return { inserted: Boolean(result.rows[0]), firstPaidInvoice: earlier === 0 };
}

// charge.refunded carries the running total refunded on the charge; store it (never decreasing).
export async function recordInvoiceRefund({ invoiceId, chargeId, amountRefundedCents }) {
  const result = await query(`
    UPDATE billing_invoices
    SET amount_refunded_cents = GREATEST(amount_refunded_cents, LEAST($3, amount_paid_cents)),
      refunded_at = COALESCE(refunded_at, now()),
      updated_at = now()
    WHERE ($1::text IS NOT NULL AND stripe_invoice_id = $1)
      OR ($2::text IS NOT NULL AND stripe_charge_id = $2)
    RETURNING stripe_invoice_id, user_id, amount_paid_cents, amount_refunded_cents
  `, [invoiceId, chargeId, Math.max(0, Number(amountRefundedCents || 0))]);
  return result.rows[0] || null;
}

export async function hasPaidInvoice(subscriptionId) {
  if (!subscriptionId) return false;
  const result = await query(`SELECT 1 FROM billing_invoices WHERE stripe_subscription_id = $1 LIMIT 1`, [subscriptionId]);
  return Boolean(result.rows[0]);
}

// Whether this subscription really started a free trial (recorded when the trial started; a trial ended at once by
// the one-trial-per-card rule has no such row).
export async function hasTrialStarted(subscriptionId) {
  if (!subscriptionId) return false;
  const result = await query(`
    SELECT 1 FROM product_analytics_events
    WHERE event_type = 'trial_started' AND metadata->>'subscriptionId' = $1
    LIMIT 1
  `, [subscriptionId]);
  return Boolean(result.rows[0]);
}

export async function listGoogleSubjects(userId) {
  const result = await query(`
    SELECT provider_subject FROM oauth_accounts WHERE user_id = $1 AND provider = 'google'
  `, [userId]);
  return result.rows.map((row) => row.provider_subject);
}

// Admin cards: trials, subscriptions, anomalies, and revenue from real invoice amounts (refunds subtracted).
export async function getBillingAdminSummary() {
  const result = await query(`
    SELECT
      (SELECT COUNT(*)::integer FROM product_analytics_events WHERE event_type = 'trial_started') AS trials_started,
      (SELECT COUNT(*)::integer FROM product_analytics_events WHERE event_type = 'trial_converted') AS trials_converted,
      (SELECT COUNT(*)::integer FROM product_analytics_events WHERE event_type = 'trial_canceled') AS trials_canceled,
      (SELECT COUNT(*)::integer FROM subscriptions s JOIN users u ON u.id = s.user_id
        WHERE s.status = 'trialing' AND s.provider_subscription_id IS NOT NULL AND COALESCE(u.role, 'user') <> 'tester') AS trialing,
      (SELECT COUNT(*)::integer FROM subscriptions s JOIN users u ON u.id = s.user_id
        WHERE s.status = 'active' AND s.provider_subscription_id IS NOT NULL AND COALESCE(u.role, 'user') <> 'tester') AS active_subscriptions,
      (SELECT COUNT(*)::integer FROM subscriptions s JOIN users u ON u.id = s.user_id
        WHERE s.status = 'past_due' AND s.provider_subscription_id IS NOT NULL AND COALESCE(u.role, 'user') <> 'tester') AS past_due,
      (SELECT COUNT(*)::integer FROM billing_anomalies) AS billing_anomalies,
      COALESCE((SELECT SUM(amount_paid_cents - amount_refunded_cents) FROM billing_invoices
        WHERE paid_at >= date_trunc('day', now())), 0)::integer AS revenue_today_cents,
      COALESCE((SELECT SUM(amount_paid_cents - amount_refunded_cents) FROM billing_invoices
        WHERE paid_at >= date_trunc('month', now())), 0)::integer AS revenue_month_cents,
      COALESCE((SELECT SUM(amount_paid_cents - amount_refunded_cents) FROM billing_invoices), 0)::integer AS revenue_lifetime_cents,
      COALESCE((SELECT SUM(amount_refunded_cents) FROM billing_invoices), 0)::integer AS refunded_cents,
      (${MRR_SQL}) AS mrr_cents
  `);
  const row = result.rows[0] || {};
  const number = (value) => Number(value || 0);
  return {
    trialsStarted: number(row.trials_started),
    trialsConverted: number(row.trials_converted),
    trialsCanceled: number(row.trials_canceled),
    trialing: number(row.trialing),
    activeSubscriptions: number(row.active_subscriptions),
    pastDue: number(row.past_due),
    billingAnomalies: number(row.billing_anomalies),
    revenueTodayCents: number(row.revenue_today_cents),
    revenueThisMonthCents: number(row.revenue_month_cents),
    revenueLifetimeCents: number(row.revenue_lifetime_cents),
    refundedCents: number(row.refunded_cents),
    monthlyRecurringRevenueCents: number(row.mrr_cents)
  };
}

// MRR from real invoices: for every subscription that is active or past due, its latest paid invoice (minus any
// refund), divided by 12 for an annual plan. Trials have paid nothing yet and add nothing.
export const MRR_SQL = `
  COALESCE((
    SELECT SUM(CASE WHEN latest.billing_interval = 'year'
      THEN ROUND((latest.amount_paid_cents - latest.amount_refunded_cents) / 12.0)
      ELSE latest.amount_paid_cents - latest.amount_refunded_cents END)
    FROM subscriptions s
    JOIN users u ON u.id = s.user_id
    CROSS JOIN LATERAL (
      SELECT i.amount_paid_cents, i.amount_refunded_cents, i.billing_interval
      FROM billing_invoices i
      WHERE i.stripe_subscription_id = s.provider_subscription_id
      ORDER BY i.paid_at DESC
      LIMIT 1
    ) latest
    WHERE s.status IN ('active', 'past_due')
      AND s.provider_subscription_id IS NOT NULL
      AND COALESCE(u.role, 'user') <> 'tester'
  ), 0)::integer`;
