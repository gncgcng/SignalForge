CREATE TABLE IF NOT EXISTS signal_validation_rejections (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  setup_key text,
  symbol text NOT NULL,
  timeframe text NOT NULL,
  direction text,
  strategy text NOT NULL,
  validation_score numeric(8,2) NOT NULL DEFAULT 0,
  confidence_score numeric(8,2) NOT NULL DEFAULT 0,
  risk_reward_ratio numeric(8,4) NOT NULL DEFAULT 0,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signal_validation_rejections_created_at
  ON signal_validation_rejections(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_validation_rejections_symbol_strategy
  ON signal_validation_rejections(symbol, strategy);

ALTER TABLE saved_signals
  ADD COLUMN IF NOT EXISTS validation_score numeric(8,2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS validation_passed boolean NOT NULL DEFAULT true;
