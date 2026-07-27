ALTER TABLE signal_quality_gate_results
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS event_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

UPDATE signal_quality_gate_results
SET
  first_seen_at = COALESCE(first_seen_at, created_at),
  last_seen_at = COALESCE(last_seen_at, created_at),
  event_count = GREATEST(COALESCE(event_count, 1), 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_quality_gate_results_dedupe
  ON signal_quality_gate_results (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signal_quality_gate_results_last_seen
  ON signal_quality_gate_results (last_seen_at DESC);
