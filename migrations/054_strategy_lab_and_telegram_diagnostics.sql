ALTER TABLE generated_signals
  ADD COLUMN IF NOT EXISTS telegram_status text,
  ADD COLUMN IF NOT EXISTS telegram_block_reason text,
  ADD COLUMN IF NOT EXISTS telegram_block_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS telegram_last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS historical_strategy_status text,
  ADD COLUMN IF NOT EXISTS historical_strategy_reason text,
  ADD COLUMN IF NOT EXISTS strategy_validation_status text,
  ADD COLUMN IF NOT EXISTS strategy_validation_reason text;

CREATE INDEX IF NOT EXISTS idx_generated_signals_telegram_status
  ON generated_signals (telegram_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generated_signals_strategy_validation
  ON generated_signals (strategy_validation_status, created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_backtest_runs (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'queued',
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failed_reason text
);

CREATE INDEX IF NOT EXISTS idx_strategy_backtest_runs_created
  ON strategy_backtest_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_backtest_stats (
  id text PRIMARY KEY,
  strategy text NOT NULL,
  pair text NOT NULL,
  timeframe text NOT NULL,
  market_regime text NOT NULL DEFAULT 'unknown',
  source text NOT NULL DEFAULT 'historical_backtest',
  total_tested integer NOT NULL DEFAULT 0,
  valid_setup_count integer NOT NULL DEFAULT 0,
  hit_tp integer NOT NULL DEFAULT 0,
  hit_sl integer NOT NULL DEFAULT 0,
  expired integer NOT NULL DEFAULT 0,
  win_rate numeric NOT NULL DEFAULT 0,
  break_even_win_rate numeric NOT NULL DEFAULT 0,
  average_rr numeric NOT NULL DEFAULT 0,
  expectancy numeric NOT NULL DEFAULT 0,
  average_time_to_tp_minutes numeric,
  average_time_to_sl_minutes numeric,
  expired_rate numeric NOT NULL DEFAULT 0,
  max_losing_streak integer NOT NULL DEFAULT 0,
  recent_performance numeric NOT NULL DEFAULT 0,
  confidence_calibration_score numeric NOT NULL DEFAULT 0,
  sample_size_label text NOT NULL DEFAULT 'not_enough_data',
  walk_forward_status text NOT NULL DEFAULT 'not_enough_data',
  training_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strategy, pair, timeframe, market_regime, source)
);

CREATE INDEX IF NOT EXISTS idx_strategy_backtest_stats_strategy
  ON strategy_backtest_stats (strategy, timeframe, expectancy DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_backtest_stats_pair_timeframe
  ON strategy_backtest_stats (pair, timeframe, expectancy DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_backtest_stats_regime
  ON strategy_backtest_stats (market_regime, strategy, expectancy DESC);

CREATE TABLE IF NOT EXISTS strategy_backtest_examples (
  id text PRIMARY KEY,
  stat_id text REFERENCES strategy_backtest_stats(id) ON DELETE CASCADE,
  strategy text NOT NULL,
  pair text NOT NULL,
  timeframe text NOT NULL,
  market_regime text NOT NULL DEFAULT 'unknown',
  entry_candle_time timestamptz,
  entry numeric,
  stop_loss numeric,
  take_profit numeric,
  result text NOT NULL,
  qualification_reason text,
  chart_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  key_confirmations jsonb NOT NULL DEFAULT '[]'::jsonb,
  similarity_vector jsonb NOT NULL DEFAULT '{}'::jsonb,
  example_type text NOT NULL DEFAULT 'recent',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_strategy_backtest_examples_lookup
  ON strategy_backtest_examples (strategy, pair, timeframe, market_regime, example_type, created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_alert_diagnostics (
  id text PRIMARY KEY,
  signal_id text,
  setup_key text,
  user_id text,
  status text NOT NULL,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_alert_diagnostics_created
  ON telegram_alert_diagnostics (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_alert_diagnostics_status
  ON telegram_alert_diagnostics (status, created_at DESC);
