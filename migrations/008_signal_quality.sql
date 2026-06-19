ALTER TABLE saved_signals
  ADD COLUMN IF NOT EXISTS quality_score integer,
  ADD COLUMN IF NOT EXISTS setup_type text;
