CREATE TABLE IF NOT EXISTS missed_setup_examples (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  pair text NOT NULL,
  timeframe text NOT NULL,
  direction text,
  attempted_strategy text,
  classification text NOT NULL CHECK (classification IN ('good_missed_setup', 'bad_missed_setup', 'unsure')),
  reason text,
  admin_note text,
  candles_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  indicators_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  analyzer_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS missed_setup_examples_created_at_idx ON missed_setup_examples (created_at DESC);
CREATE INDEX IF NOT EXISTS missed_setup_examples_pair_timeframe_idx ON missed_setup_examples (pair, timeframe, created_at DESC);
CREATE INDEX IF NOT EXISTS missed_setup_examples_strategy_idx ON missed_setup_examples (attempted_strategy, classification);
