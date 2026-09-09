ALTER TABLE users
  ADD COLUMN IF NOT EXISTS affiliate_code text,
  ADD COLUMN IF NOT EXISTS affiliate_disabled boolean NOT NULL DEFAULT false;

UPDATE users
SET affiliate_code = lower(substr(md5(id), 1, 12))
WHERE affiliate_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_affiliate_code
  ON users(affiliate_code)
  WHERE affiliate_code IS NOT NULL;

ALTER TABLE oauth_login_states
  ADD COLUMN IF NOT EXISTS affiliate_code text;

CREATE TABLE IF NOT EXISTS affiliate_referrals (
  id text PRIMARY KEY,
  affiliate_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_plan text NOT NULL DEFAULT 'free',
  monthly_commission_cents integer NOT NULL DEFAULT 0,
  lifetime_commission_cents integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT false,
  suspicious boolean NOT NULL DEFAULT false,
  suspicious_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (referred_user_id),
  CHECK (affiliate_user_id <> referred_user_id),
  CHECK (subscription_plan IN ('free', 'pro', 'elite'))
);

CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id text PRIMARY KEY,
  affiliate_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visitor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (affiliate_user_id, visitor_id)
);

CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id text PRIMARY KEY,
  referral_id text NOT NULL REFERENCES affiliate_referrals(id) ON DELETE CASCADE,
  stripe_invoice_id text NOT NULL,
  stripe_event_id text NOT NULL,
  subscription_plan text NOT NULL,
  gross_amount_cents integer NOT NULL,
  commission_amount_cents integer NOT NULL,
  refunded_amount_cents integer NOT NULL DEFAULT 0,
  reversed_commission_cents integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'earned',
  period_start timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stripe_invoice_id),
  CHECK (subscription_plan IN ('pro', 'elite')),
  CHECK (status IN ('earned', 'partially_refunded', 'refunded'))
);

CREATE TABLE IF NOT EXISTS affiliate_payout_requests (
  id text PRIMARY KEY,
  affiliate_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL,
  payout_method text NOT NULL,
  payout_destination text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reviewed_by text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_cents >= 2500),
  CHECK (payout_method IN ('paypal', 'wise', 'usdt')),
  CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_affiliate
  ON affiliate_referrals(affiliate_user_id, active);
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_affiliate
  ON affiliate_clicks(affiliate_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_referral
  ON affiliate_commissions(referral_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_status
  ON affiliate_payout_requests(status, created_at);
