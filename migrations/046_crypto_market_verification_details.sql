ALTER TABLE crypto_markets
  ADD COLUMN IF NOT EXISTS verification_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_verification_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_crypto_markets_status_retry
  ON crypto_markets (market_status, cooldown_until, last_verified_at);
