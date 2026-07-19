CREATE TABLE IF NOT EXISTS crypto_markets (
  symbol text PRIMARY KEY,
  display_symbol text NOT NULL,
  provider_symbol text NOT NULL UNIQUE,
  name text NOT NULL,
  provider text NOT NULL DEFAULT 'coinbase-exchange',
  liquidity_tier text NOT NULL DEFAULT 'standard',
  enabled boolean NOT NULL DEFAULT true,
  scanner_enabled boolean NOT NULL DEFAULT false,
  paper_trading_enabled boolean NOT NULL DEFAULT true,
  watchlist_enabled boolean NOT NULL DEFAULT true,
  provider_status text NOT NULL DEFAULT 'unchecked'
    CHECK (provider_status IN ('unchecked', 'available', 'unavailable', 'provider_issue')),
  supported_timeframes text[] NOT NULL DEFAULT ARRAY[]::text[],
  unsupported_timeframes text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_successful_candle_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  failure_code text,
  cooldown_until timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crypto_markets_scanner
  ON crypto_markets (enabled, scanner_enabled, provider_status, liquidity_tier);
CREATE INDEX IF NOT EXISTS idx_crypto_markets_cooldown
  ON crypto_markets (cooldown_until, last_checked_at);
