ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS stripe_mode text;

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_stripe_mode_check;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_stripe_mode_check
  CHECK (stripe_mode IS NULL OR stripe_mode IN ('test', 'live'));

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer_mode
  ON subscriptions(provider_customer_id, stripe_mode)
  WHERE provider_customer_id IS NOT NULL;
