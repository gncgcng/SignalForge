CREATE TABLE IF NOT EXISTS daily_market_brief_observations (
  symbol text NOT NULL,
  timeframe text NOT NULL,
  scanner_snapshot_id text NOT NULL,
  observation jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_market_brief_observations_recent
  ON daily_market_brief_observations (observed_at DESC);

CREATE TABLE IF NOT EXISTS daily_market_briefs (
  id text PRIMARY KEY,
  scope text NOT NULL UNIQUE DEFAULT 'crypto',
  generated_at timestamptz NOT NULL DEFAULT now(),
  market_condition text NOT NULL,
  strongest_pairs jsonb NOT NULL DEFAULT '[]'::jsonb,
  weakest_pairs jsonb NOT NULL DEFAULT '[]'::jsonb,
  watching_count integer NOT NULL DEFAULT 0,
  avoid_count integer NOT NULL DEFAULT 0,
  ready_signal_count integer NOT NULL DEFAULT 0,
  main_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  pair_summaries jsonb NOT NULL DEFAULT '[]'::jsonb,
  watching_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  scanner_snapshot_id text NOT NULL,
  pairs_scanned integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_market_briefs_generated
  ON daily_market_briefs (generated_at DESC);
