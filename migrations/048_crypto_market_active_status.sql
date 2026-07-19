ALTER TABLE crypto_markets
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'unavailable',
  ADD COLUMN IF NOT EXISTS last_verification_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_details jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE crypto_markets
  ALTER COLUMN status SET DEFAULT 'unavailable';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_markets_status_check') THEN
    ALTER TABLE crypto_markets DROP CONSTRAINT crypto_markets_status_check;
  END IF;
END $$;

UPDATE crypto_markets
SET
  status = CASE
    WHEN enabled = false AND market_status <> 'legacy' THEN 'disabled'
    WHEN market_status = 'legacy' OR status = 'legacy' THEN 'legacy'
    WHEN market_status = 'active' OR status = 'ready' THEN 'active'
    WHEN market_status = 'provider_error' OR status = 'provider_error' THEN 'provider_error'
    WHEN status = 'disabled' THEN 'disabled'
    ELSE 'unavailable'
  END,
  market_status = CASE
    WHEN enabled = false AND market_status <> 'legacy' THEN 'disabled'
    WHEN market_status = 'legacy' OR status = 'legacy' THEN 'legacy'
    WHEN market_status = 'active' OR status = 'ready' THEN 'active'
    WHEN market_status = 'provider_error' OR status = 'provider_error' THEN 'provider_error'
    ELSE 'unavailable'
  END,
  verification_status = CASE
    WHEN market_status = 'legacy' OR status = 'legacy' THEN 'legacy'
    WHEN market_status = 'active' OR status = 'ready' THEN 'verified'
    WHEN market_status = 'provider_error' OR status = 'provider_error' THEN 'error'
    ELSE 'failed'
  END,
  provider_status = CASE
    WHEN market_status = 'active' OR status = 'ready' THEN 'available'
    WHEN market_status = 'provider_error' OR status = 'provider_error' THEN 'provider_issue'
    ELSE 'unavailable'
  END,
  scanner_enabled = CASE WHEN market_status = 'active' OR status = 'ready' THEN scanner_enabled ELSE false END,
  paper_trading_enabled = CASE WHEN market_status = 'active' OR status = 'ready' THEN paper_trading_enabled ELSE false END,
  watchlist_enabled = CASE WHEN market_status = 'active' OR status = 'ready' THEN watchlist_enabled ELSE false END,
  last_error = CASE
    WHEN status = 'pending' OR market_status = 'pending' OR verification_status = 'pending'
      THEN COALESCE(NULLIF(last_error, ''), 'Pending verification retired. Run market:rebuild-active for fresh provider checks.')
    ELSE last_error
  END,
  failure_code = CASE
    WHEN status = 'pending' OR market_status = 'pending' OR verification_status = 'pending'
      THEN COALESCE(NULLIF(failure_code, ''), 'PENDING_RETIRED')
    ELSE failure_code
  END,
  cooldown_until = NULL,
  updated_at = now()
WHERE status IS NULL
   OR status NOT IN ('active', 'unavailable', 'provider_error', 'legacy', 'disabled')
   OR market_status = 'pending'
   OR verification_status = 'pending';

ALTER TABLE crypto_markets ADD CONSTRAINT crypto_markets_status_check
  CHECK (status IN ('active', 'unavailable', 'provider_error', 'legacy', 'disabled'));

CREATE INDEX IF NOT EXISTS idx_crypto_markets_canonical_status
  ON crypto_markets (status, enabled, scanner_enabled, paper_trading_enabled);
