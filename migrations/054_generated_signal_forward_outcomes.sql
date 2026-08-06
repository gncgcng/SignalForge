ALTER TABLE generated_signals
  ADD COLUMN IF NOT EXISTS realized_r numeric,
  ADD COLUMN IF NOT EXISTS outcome_evaluated_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_r_version text;
