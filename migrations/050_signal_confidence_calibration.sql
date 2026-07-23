ALTER TABLE generated_signals
  ADD COLUMN IF NOT EXISTS original_confidence numeric,
  ADD COLUMN IF NOT EXISTS confidence_calibration jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE generated_signals
SET original_confidence = confidence
WHERE original_confidence IS NULL;

CREATE TABLE IF NOT EXISTS signal_performance_groups (
  id text PRIMARY KEY,
  group_key text NOT NULL UNIQUE,
  group_type text NOT NULL,
  group_value text NOT NULL,
  total_signals integer NOT NULL DEFAULT 0,
  active integer NOT NULL DEFAULT 0,
  hit_tp integer NOT NULL DEFAULT 0,
  hit_sl integer NOT NULL DEFAULT 0,
  expired integer NOT NULL DEFAULT 0,
  closed_signals integer NOT NULL DEFAULT 0,
  win_rate numeric NOT NULL DEFAULT 0,
  expired_rate numeric NOT NULL DEFAULT 0,
  average_rr numeric NOT NULL DEFAULT 0,
  average_realized_r numeric NOT NULL DEFAULT 0,
  estimated_expectancy numeric NOT NULL DEFAULT 0,
  average_confidence numeric NOT NULL DEFAULT 0,
  confidence_gap numeric NOT NULL DEFAULT 0,
  break_even_win_rate numeric NOT NULL DEFAULT 0,
  quality_adjusted_score numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  suggested_status text NOT NULL DEFAULT 'active',
  penalty numeric NOT NULL DEFAULT 0,
  confidence_cap numeric,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_strategy_statuses (
  group_key text PRIMARY KEY,
  group_type text NOT NULL,
  group_value text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  admin_note text,
  penalty_override numeric,
  confidence_cap_override numeric,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_confidence_adjustments (
  id text PRIMARY KEY,
  signal_id text,
  group_key text,
  original_confidence numeric NOT NULL,
  final_confidence numeric NOT NULL,
  confidence_cap numeric,
  penalty numeric NOT NULL DEFAULT 0,
  reason text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signal_performance_groups_type_status
  ON signal_performance_groups (group_type, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_performance_groups_strategy
  ON signal_performance_groups (group_value, updated_at DESC)
  WHERE group_type = 'strategy';

CREATE INDEX IF NOT EXISTS idx_signal_strategy_statuses_status
  ON signal_strategy_statuses (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_confidence_adjustments_signal
  ON signal_confidence_adjustments (signal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generated_signals_outcome_calibration
  ON generated_signals (strategy, pair, timeframe, direction, status, created_at DESC);
