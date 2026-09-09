ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS stripe_object_id text,
  ADD COLUMN IF NOT EXISTS user_id text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payload_json jsonb,
  ADD COLUMN IF NOT EXISTS result_json jsonb,
  ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE stripe_webhook_events
SET received_at = COALESCE(received_at, processed_at),
  processing_started_at = COALESCE(processing_started_at, processed_at),
  completed_at = CASE
    WHEN status = 'processed' THEN COALESCE(completed_at, processed_at)
    ELSE completed_at
  END;

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_history
  ON stripe_webhook_events(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_failures
  ON stripe_webhook_events(status, received_at DESC);
