ALTER TABLE crypto_markets
  ADD COLUMN IF NOT EXISTS base_asset text,
  ADD COLUMN IF NOT EXISTS quote_asset text,
  ADD COLUMN IF NOT EXISTS product_status text,
  ADD COLUMN IF NOT EXISTS trading_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS market_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS replacement_symbol text;

UPDATE crypto_markets
SET
  base_asset = COALESCE(base_asset, split_part(provider_symbol, '-', 1)),
  quote_asset = COALESCE(quote_asset, split_part(provider_symbol, '-', 2)),
  product_status = COALESCE(product_status, 'legacy_seed'),
  market_status = CASE
    WHEN enabled = false THEN 'disabled'
    WHEN provider_status = 'available' THEN 'active'
    WHEN provider_status = 'unavailable' THEN 'unavailable'
    WHEN provider_status = 'provider_issue' THEN 'provider_error'
    ELSE 'pending'
  END,
  verification_status = CASE
    WHEN provider_status = 'available' THEN 'verified'
    WHEN provider_status = 'unavailable' THEN 'failed'
    WHEN provider_status = 'provider_issue' THEN 'error'
    ELSE 'pending'
  END,
  last_verified_at = COALESCE(last_verified_at, last_checked_at)
WHERE base_asset IS NULL
   OR quote_asset IS NULL
   OR product_status IS NULL
   OR market_status = 'pending'
   OR verification_status = 'pending';

UPDATE crypto_markets
SET market_status = 'legacy', verification_status = 'legacy', enabled = false,
    scanner_enabled = false, paper_trading_enabled = false, provider_status = 'unavailable',
    replacement_symbol = CASE symbol WHEN 'MATIC-USD' THEN 'POL-USD' WHEN 'RNDR-USD' THEN 'RENDER-USD' END,
    last_error = 'Legacy Coinbase symbol. Use the replacement market.'
WHERE symbol IN ('MATIC-USD', 'RNDR-USD')
  AND market_status <> 'legacy';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_markets_market_status_check') THEN
    ALTER TABLE crypto_markets ADD CONSTRAINT crypto_markets_market_status_check
      CHECK (market_status IN ('active', 'pending', 'unavailable', 'legacy', 'disabled', 'provider_error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crypto_markets_verification_status_check') THEN
    ALTER TABLE crypto_markets ADD CONSTRAINT crypto_markets_verification_status_check
      CHECK (verification_status IN ('pending', 'verified', 'failed', 'error', 'legacy'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crypto_markets_lifecycle
  ON crypto_markets (market_status, verification_status, enabled);
CREATE INDEX IF NOT EXISTS idx_crypto_markets_verification_queue
  ON crypto_markets (verification_status, last_verified_at)
  WHERE verification_status = 'pending';
