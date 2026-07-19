ALTER TABLE crypto_markets
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS last_verification_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_details jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE crypto_markets
SET status = CASE
  WHEN enabled = false AND market_status <> 'legacy' THEN 'disabled'
  WHEN market_status = 'active' THEN 'ready'
  WHEN market_status = 'provider_error' THEN 'provider_error'
  WHEN market_status = 'unavailable' THEN 'unavailable'
  WHEN market_status = 'legacy' THEN 'legacy'
  ELSE 'pending'
END
WHERE status IS NULL
   OR status = 'pending'
   OR status NOT IN ('ready', 'pending', 'unavailable', 'provider_error', 'legacy', 'disabled');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_markets_status_check') THEN
    ALTER TABLE crypto_markets ADD CONSTRAINT crypto_markets_status_check
      CHECK (status IN ('ready', 'pending', 'unavailable', 'provider_error', 'legacy', 'disabled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crypto_markets_canonical_status
  ON crypto_markets (status, enabled, scanner_enabled, paper_trading_enabled);
