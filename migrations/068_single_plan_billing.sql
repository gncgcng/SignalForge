-- Pivot phase 3: one plan ($9.99/month or $89.99/year) with a 7-day, card-required Stripe trial.
-- subscriptions.status now holds Stripe's own status, or 'none' for an account that never subscribed.

-- 1. Free users are no longer "trialing" by default.
ALTER TABLE subscriptions ALTER COLUMN status SET DEFAULT 'none';

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS trial_end timestamptz,
  -- Set the first time this account has any Stripe subscription. An account with one never gets another trial.
  ADD COLUMN IF NOT EXISTS first_subscribed_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_interval text CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year'));

-- Earlier subscriptions (any mode, including the old Pro/Elite test-mode ones) count as "had a subscription".
UPDATE subscriptions s
SET first_subscribed_at = COALESCE(s.first_subscribed_at, s.created_at)
WHERE s.provider_subscription_id IS NOT NULL
  OR (s.status IN ('active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired')
     AND s.provider_customer_id IS NOT NULL)
  OR EXISTS (SELECT 1 FROM billing_entitlement_grants g WHERE g.user_id = s.user_id);

-- Rows that were never a Stripe subscription: the old default 'trialing' (and any stray 'active') become 'none'.
UPDATE subscriptions
SET status = 'none', updated_at = now()
WHERE provider_subscription_id IS NULL
  AND status IN ('trialing', 'active');

-- 2. One free trial per card. card_fingerprint_hash is HMAC-SHA256 (TRIAL_IDENTITY_SECRET) of Stripe's
-- card.fingerprint; the fingerprint itself is never stored. first_user_id has no foreign key so the claim survives
-- account deletion (the anonymized users row keeps its id), like trial_identity_claims.
CREATE TABLE IF NOT EXISTS trial_card_claims (
  card_fingerprint_hash text PRIMARY KEY,
  first_user_id text NOT NULL,
  first_claimed_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Real invoice amounts, for revenue and refunds. Only invoices that actually charged money (amount_paid > 0).
CREATE TABLE IF NOT EXISTS billing_invoices (
  stripe_invoice_id text PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  stripe_subscription_id text,
  stripe_charge_id text,
  amount_paid_cents integer NOT NULL CHECK (amount_paid_cents > 0),
  amount_refunded_cents integer NOT NULL DEFAULT 0 CHECK (amount_refunded_cents >= 0),
  currency text NOT NULL DEFAULT 'usd',
  billing_interval text CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year')),
  livemode boolean NOT NULL DEFAULT false,
  paid_at timestamptz NOT NULL DEFAULT now(),
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_paid_at ON billing_invoices(paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_user ON billing_invoices(user_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_charge ON billing_invoices(stripe_charge_id);

-- 4. Things the webhook refused to act on (unknown price ids, a trial card with no fingerprint, ...).
-- One row per kind + reference; repeats only bump the counter, so each is logged once.
CREATE TABLE IF NOT EXISTS billing_anomalies (
  id text PRIMARY KEY,
  kind text NOT NULL,
  reference text NOT NULL,
  stripe_event_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurrences integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, reference)
);

-- 5. The single plan is stored as 'signalforge' on affiliate rows.
ALTER TABLE affiliate_referrals DROP CONSTRAINT IF EXISTS affiliate_referrals_subscription_plan_check;
ALTER TABLE affiliate_referrals ADD CONSTRAINT affiliate_referrals_subscription_plan_check
  CHECK (subscription_plan IN ('free', 'pro', 'elite', 'signalforge'));
ALTER TABLE affiliate_commissions DROP CONSTRAINT IF EXISTS affiliate_commissions_subscription_plan_check;
ALTER TABLE affiliate_commissions ADD CONSTRAINT affiliate_commissions_subscription_plan_check
  CHECK (subscription_plan IN ('pro', 'elite', 'signalforge'));

-- 6. Billing analytics events for the admin cards (trials started / converted / cancelled, refunds).
ALTER TABLE product_analytics_events DROP CONSTRAINT IF EXISTS product_analytics_events_event_type_check;
ALTER TABLE product_analytics_events ADD CONSTRAINT product_analytics_events_event_type_check
  CHECK (event_type IN (
    'signup',
    'scan',
    'unlock',
    'subscription',
    'affiliate_conversion',
    'checkout_started',
    'checkout_completed',
    'trial_started',
    'trial_converted',
    'trial_canceled',
    'refund'
  ));
