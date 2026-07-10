CREATE TABLE IF NOT EXISTS signal_snapshots (
  saved_signal_id text PRIMARY KEY REFERENCES saved_signals(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_learning_events (
  id text PRIMARY KEY,
  signal_id text NOT NULL REFERENCES saved_signals(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair text NOT NULL,
  timeframe text NOT NULL,
  direction text NOT NULL,
  strategy text NOT NULL,
  outcome text NOT NULL,
  net_r numeric NOT NULL DEFAULT 0,
  post_mortem_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  closed_at timestamptz NOT NULL,
  UNIQUE(signal_id)
);

CREATE TABLE IF NOT EXISTS strategy_learning_stats (
  strategy text NOT NULL,
  market text NOT NULL,
  timeframe text NOT NULL,
  sample_size integer NOT NULL DEFAULT 0,
  win_rate numeric NOT NULL DEFAULT 0,
  avg_r numeric NOT NULL DEFAULT 0,
  expired_rate numeric NOT NULL DEFAULT 0,
  stop_loss_rate numeric NOT NULL DEFAULT 0,
  best_conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  worst_conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(strategy, market, timeframe)
);

CREATE TABLE IF NOT EXISTS factor_learning_stats (
  factor_name text NOT NULL,
  factor_value text NOT NULL,
  sample_size integer NOT NULL DEFAULT 0,
  win_rate numeric NOT NULL DEFAULT 0,
  avg_r numeric NOT NULL DEFAULT 0,
  stop_loss_rate numeric NOT NULL DEFAULT 0,
  expired_rate numeric NOT NULL DEFAULT 0,
  confidence_adjustment numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(factor_name, factor_value)
);

CREATE TABLE IF NOT EXISTS market_timeframe_learning_stats (
  market text NOT NULL,
  timeframe text NOT NULL,
  sample_size integer NOT NULL DEFAULT 0,
  win_rate numeric NOT NULL DEFAULT 0,
  avg_r numeric NOT NULL DEFAULT 0,
  best_strategy text,
  worst_strategy text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(market, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_signal_learning_events_user_closed
  ON signal_learning_events(user_id, closed_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_learning_events_pair_timeframe
  ON signal_learning_events(pair, timeframe, strategy);

