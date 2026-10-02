-- Generic markets registry: one table for every asset class, replacing both crypto_markets and
-- the hardcoded commodity/stock array in marketDataService.js.
--
-- Purely additive. crypto_markets is NOT dropped here: it stays as a read path for one deploy
-- cycle, kept in sync by the mirror trigger below so a code rollback still sees current crypto
-- state. A follow-up migration drops the trigger, the function and crypto_markets together.
CREATE TABLE IF NOT EXISTS markets (
  id text PRIMARY KEY,
  symbol text NOT NULL,
  asset_class text NOT NULL CHECK (asset_class IN ('crypto', 'commodity', 'stock', 'forex')),
  provider text NOT NULL,
  provider_symbol text NOT NULL,
  exchange_timezone text,
  session_calendar_id text,
  category text,
  venue text,
  scanner_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_symbol),

  -- Identity and capability flags every market needs.
  name text NOT NULL,
  display_symbol text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  paper_trading_enabled boolean NOT NULL DEFAULT true,
  watchlist_enabled boolean NOT NULL DEFAULT true,

  -- Provider verification / health state carried over column-for-column from crypto_markets so
  -- the crypto lifecycle keeps working unchanged. Only crypto rows populate most of these today.
  liquidity_tier text,
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
  base_asset text,
  quote_asset text,
  product_status text,
  trading_enabled boolean NOT NULL DEFAULT true,
  market_status text NOT NULL DEFAULT 'unavailable'
    CHECK (market_status IN ('active', 'pending', 'unavailable', 'legacy', 'disabled', 'provider_error')),
  verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'failed', 'error', 'legacy')),
  status text NOT NULL DEFAULT 'unavailable'
    CHECK (status IN ('active', 'unavailable', 'provider_error', 'legacy', 'disabled')),
  last_verified_at timestamptz,
  last_verification_attempt_at timestamptz,
  replacement_symbol text,
  verification_details jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- The app addresses markets by symbol everywhere, so it must be unique across asset classes.
CREATE UNIQUE INDEX IF NOT EXISTS markets_symbol_key ON markets (symbol);
CREATE INDEX IF NOT EXISTS idx_markets_asset_class ON markets (asset_class, enabled, scanner_enabled);
CREATE INDEX IF NOT EXISTS idx_markets_canonical_status ON markets (status, enabled, scanner_enabled, paper_trading_enabled);
CREATE INDEX IF NOT EXISTS idx_markets_status_retry ON markets (market_status, cooldown_until, last_verified_at);

-- 1. Every crypto_markets row, verbatim.
INSERT INTO markets (
  id, symbol, asset_class, provider, provider_symbol, exchange_timezone, session_calendar_id,
  category, venue, scanner_enabled, created_at, updated_at,
  name, display_symbol, enabled, paper_trading_enabled, watchlist_enabled,
  liquidity_tier, provider_status, supported_timeframes, unsupported_timeframes,
  last_successful_candle_at, last_checked_at, last_error, failure_code, cooldown_until,
  consecutive_failures, base_asset, quote_asset, product_status, trading_enabled,
  market_status, verification_status, status, last_verified_at, last_verification_attempt_at,
  replacement_symbol, verification_details
)
SELECT
  'crypto:' || symbol, symbol, 'crypto', provider, provider_symbol, NULL, NULL,
  'Crypto', 'Coinbase', scanner_enabled, created_at, updated_at,
  name, display_symbol, enabled, paper_trading_enabled, watchlist_enabled,
  liquidity_tier, provider_status, supported_timeframes, unsupported_timeframes,
  last_successful_candle_at, last_checked_at, last_error, failure_code, cooldown_until,
  consecutive_failures, base_asset, quote_asset, product_status, trading_enabled,
  market_status, verification_status, status, last_verified_at, last_verification_attempt_at,
  replacement_symbol, verification_details
FROM crypto_markets
ON CONFLICT DO NOTHING;

-- 2. Commodity and stock entries from the old JS array. provider_symbol is the string Twelve Data
-- actually expects (previously twelveDataSymbolMap). Stocks never had a provider; 'none' keeps the
-- NOT NULL contract and the app treats it as "no provider configured" (Coming Soon), as before.
-- SPY was assetClass "ETF" in the array; ETFs fold into 'stock'.
INSERT INTO markets (
  id, symbol, asset_class, provider, provider_symbol, category, venue, scanner_enabled,
  name, display_symbol, supported_timeframes, market_status, verification_status, status, provider_status
) VALUES
  ('commodity:XAU/USD', 'XAU/USD', 'commodity', 'twelve-data', 'XAU/USD', 'Commodities', 'OTC', true, 'Gold', 'XAU/USD', ARRAY['5m','15m','1h','4h'], 'active', 'pending', 'active', 'unchecked'),
  ('commodity:XAG/USD', 'XAG/USD', 'commodity', 'twelve-data', 'XAG/USD', 'Commodities', 'OTC', true, 'Silver', 'XAG/USD', ARRAY['5m','15m','1h','4h'], 'active', 'pending', 'active', 'unchecked'),
  ('commodity:WTI', 'WTI', 'commodity', 'twelve-data', 'XTI/USD', 'Commodities', 'OTC', true, 'WTI Crude Oil', 'WTI', ARRAY['5m','15m','1h','4h'], 'active', 'pending', 'active', 'unchecked'),
  ('commodity:BRENT', 'BRENT', 'commodity', 'twelve-data', 'XBR/USD', 'Commodities', 'OTC', true, 'Brent Crude Oil', 'BRENT', ARRAY['5m','15m','1h','4h'], 'active', 'pending', 'active', 'unchecked'),
  ('commodity:NATGAS', 'NATGAS', 'commodity', 'twelve-data', 'XNG/USD', 'Commodities', 'OTC', true, 'Natural Gas', 'NATGAS', ARRAY['5m','15m','1h','4h'], 'active', 'pending', 'active', 'unchecked'),
  ('stock:NVDA', 'NVDA', 'stock', 'none', 'NVDA', 'Stocks & ETFs', 'NASDAQ', false, 'NVIDIA Corp', 'NVDA', ARRAY[]::text[], 'unavailable', 'pending', 'unavailable', 'unchecked'),
  ('stock:TSLA', 'TSLA', 'stock', 'none', 'TSLA', 'Stocks & ETFs', 'NASDAQ', false, 'Tesla Inc', 'TSLA', ARRAY[]::text[], 'unavailable', 'pending', 'unavailable', 'unchecked'),
  ('stock:AAPL', 'AAPL', 'stock', 'none', 'AAPL', 'Stocks & ETFs', 'NASDAQ', false, 'Apple Inc', 'AAPL', ARRAY[]::text[], 'unavailable', 'pending', 'unavailable', 'unchecked'),
  ('stock:SPY', 'SPY', 'stock', 'none', 'SPY', 'Stocks & ETFs', 'NYSE Arca', false, 'S&P 500 ETF', 'SPY', ARRAY[]::text[], 'unavailable', 'pending', 'unavailable', 'unchecked')
ON CONFLICT DO NOTHING;

-- 3. Transitional mirror: every crypto write to markets is copied into crypto_markets so the
-- previous release (which reads crypto_markets) stays correct if this deploy is rolled back.
-- Best-effort by design: a mirror failure must never fail the primary write.
CREATE OR REPLACE FUNCTION mirror_crypto_market_to_legacy() RETURNS trigger AS $$
BEGIN
  INSERT INTO crypto_markets (
    symbol, display_symbol, provider_symbol, name, provider, liquidity_tier,
    enabled, scanner_enabled, paper_trading_enabled, watchlist_enabled, provider_status,
    supported_timeframes, unsupported_timeframes, last_successful_candle_at, last_checked_at,
    last_error, failure_code, cooldown_until, consecutive_failures, created_at, updated_at,
    base_asset, quote_asset, product_status, trading_enabled, market_status, verification_status,
    last_verified_at, replacement_symbol, verification_details, last_verification_attempt_at, status
  ) VALUES (
    NEW.symbol, NEW.display_symbol, NEW.provider_symbol, NEW.name, NEW.provider, COALESCE(NEW.liquidity_tier, 'standard'),
    NEW.enabled, NEW.scanner_enabled, NEW.paper_trading_enabled, NEW.watchlist_enabled, NEW.provider_status,
    NEW.supported_timeframes, NEW.unsupported_timeframes, NEW.last_successful_candle_at, NEW.last_checked_at,
    NEW.last_error, NEW.failure_code, NEW.cooldown_until, NEW.consecutive_failures, NEW.created_at, NEW.updated_at,
    NEW.base_asset, NEW.quote_asset, NEW.product_status, NEW.trading_enabled, NEW.market_status, NEW.verification_status,
    NEW.last_verified_at, NEW.replacement_symbol, NEW.verification_details, NEW.last_verification_attempt_at, NEW.status
  )
  ON CONFLICT (symbol) DO UPDATE SET
    display_symbol = EXCLUDED.display_symbol, provider_symbol = EXCLUDED.provider_symbol,
    name = EXCLUDED.name, provider = EXCLUDED.provider, liquidity_tier = EXCLUDED.liquidity_tier,
    enabled = EXCLUDED.enabled, scanner_enabled = EXCLUDED.scanner_enabled,
    paper_trading_enabled = EXCLUDED.paper_trading_enabled, watchlist_enabled = EXCLUDED.watchlist_enabled,
    provider_status = EXCLUDED.provider_status, supported_timeframes = EXCLUDED.supported_timeframes,
    unsupported_timeframes = EXCLUDED.unsupported_timeframes,
    last_successful_candle_at = EXCLUDED.last_successful_candle_at, last_checked_at = EXCLUDED.last_checked_at,
    last_error = EXCLUDED.last_error, failure_code = EXCLUDED.failure_code,
    cooldown_until = EXCLUDED.cooldown_until, consecutive_failures = EXCLUDED.consecutive_failures,
    updated_at = EXCLUDED.updated_at, base_asset = EXCLUDED.base_asset, quote_asset = EXCLUDED.quote_asset,
    product_status = EXCLUDED.product_status, trading_enabled = EXCLUDED.trading_enabled,
    market_status = EXCLUDED.market_status, verification_status = EXCLUDED.verification_status,
    last_verified_at = EXCLUDED.last_verified_at, replacement_symbol = EXCLUDED.replacement_symbol,
    verification_details = EXCLUDED.verification_details,
    last_verification_attempt_at = EXCLUDED.last_verification_attempt_at, status = EXCLUDED.status;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'crypto_markets mirror failed for %: %', NEW.symbol, SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS markets_mirror_crypto_to_legacy ON markets;
CREATE TRIGGER markets_mirror_crypto_to_legacy
  AFTER INSERT OR UPDATE ON markets
  FOR EACH ROW WHEN (NEW.asset_class = 'crypto')
  EXECUTE FUNCTION mirror_crypto_market_to_legacy();
