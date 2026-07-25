ALTER TABLE generated_signals
  ADD COLUMN IF NOT EXISTS quality_gate_status text,
  ADD COLUMN IF NOT EXISTS quality_gate_reason text,
  ADD COLUMN IF NOT EXISTS quality_gate_details jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS signal_quality_gate_results (
  id text PRIMARY KEY,
  signal_id text,
  candidate_id text,
  pair text,
  timeframe text,
  direction text,
  attempted_strategy text,
  gate_status text NOT NULL,
  rejection_reason text,
  explanation text,
  user_explanation text,
  raw_score numeric,
  calibrated_confidence numeric,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signal_quality_gate_results_created
  ON signal_quality_gate_results (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_quality_gate_results_reason
  ON signal_quality_gate_results (gate_status, rejection_reason, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_quality_gate_results_pair_tf
  ON signal_quality_gate_results (pair, timeframe, created_at DESC);

CREATE TABLE IF NOT EXISTS quality_gate_reason_stats (
  reason text NOT NULL,
  strategy text NOT NULL,
  timeframe text NOT NULL,
  pair text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reason, strategy, timeframe, pair)
);

CREATE INDEX IF NOT EXISTS idx_quality_gate_reason_stats_count
  ON quality_gate_reason_stats (count DESC, last_seen_at DESC);
