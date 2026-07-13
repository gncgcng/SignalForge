CREATE TABLE IF NOT EXISTS avoid_trade_learning_events (
  id text PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  market text NOT NULL,
  timeframe text NOT NULL,
  reason text NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  market_condition text NOT NULL,
  setup_quality_score numeric NOT NULL DEFAULT 0,
  entry_readiness_score numeric NOT NULL DEFAULT 0,
  became_good_signal boolean,
  would_have_failed boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_avoid_trade_learning_created
  ON avoid_trade_learning_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_avoid_trade_learning_market
  ON avoid_trade_learning_events (market, timeframe, created_at DESC);
