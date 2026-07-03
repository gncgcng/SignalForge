CREATE TABLE IF NOT EXISTS product_analytics_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  auth_provider text,
  symbol text,
  timeframe text,
  plan text,
  amount_cents integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_type IN (
    'signup',
    'scan',
    'unlock',
    'subscription',
    'affiliate_conversion',
    'checkout_started',
    'checkout_completed'
  )),
  CHECK (auth_provider IS NULL OR auth_provider IN ('email', 'google')),
  CHECK (amount_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_product_analytics_events_type_time
  ON product_analytics_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_analytics_events_user_time
  ON product_analytics_events(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_analytics_events_symbol_type
  ON product_analytics_events(symbol, event_type)
  WHERE symbol IS NOT NULL;
