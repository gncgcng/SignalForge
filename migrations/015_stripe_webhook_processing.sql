ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'processed',
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1;

ALTER TABLE stripe_webhook_events
  DROP CONSTRAINT IF EXISTS stripe_webhook_events_status_check;

ALTER TABLE stripe_webhook_events
  ADD CONSTRAINT stripe_webhook_events_status_check
  CHECK (status IN ('processing', 'processed', 'failed'));

CREATE TABLE IF NOT EXISTS billing_entitlement_grants (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_reference text NOT NULL UNIQUE,
  plan text NOT NULL CHECK (plan IN ('pro', 'elite')),
  scan_credits integer NOT NULL CHECK (scan_credits > 0),
  unlock_credits integer NOT NULL CHECK (unlock_credits > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_entitlement_grants_user_created
  ON billing_entitlement_grants(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status
  ON stripe_webhook_events(status, processed_at DESC);
