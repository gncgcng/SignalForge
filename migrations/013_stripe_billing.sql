ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS provider_subscription_id text,
  ADD COLUMN IF NOT EXISTS price_id text,
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;

ALTER TABLE credit_balances
  ADD COLUMN IF NOT EXISTS unlock_credits_balance integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_unlocks_used integer NOT NULL DEFAULT 0;

UPDATE users
SET plan = 'free'
WHERE plan = 'trial';

UPDATE credit_balances c
SET unlock_credits_balance = GREATEST(
  unlock_credits_balance,
  paid_credits + GREATEST(0, free_signal_allowance - trial_signals_used)
)
FROM users u
WHERE u.id = c.user_id
  AND u.email_verified_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS setup_discovery_usage (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scan_key text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scan_result_cache (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scan_key text NOT NULL,
  result_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scan_key)
);

CREATE TABLE IF NOT EXISTS billing_credit_grants (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_reference text NOT NULL UNIQUE,
  source text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discovery_usage_user_created
  ON setup_discovery_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_cache_expiry
  ON scan_result_cache(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_provider_subscription
  ON subscriptions(provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_provider_customer
  ON subscriptions(provider_customer_id)
  WHERE provider_customer_id IS NOT NULL;
