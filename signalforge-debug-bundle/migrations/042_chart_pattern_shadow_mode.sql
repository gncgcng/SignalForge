ALTER TABLE candidate_learning_events
  ADD COLUMN IF NOT EXISTS detected_pattern text,
  ADD COLUMN IF NOT EXISTS pattern_confidence numeric,
  ADD COLUMN IF NOT EXISTS pattern_bias text,
  ADD COLUMN IF NOT EXISTS pattern_expected_move boolean,
  ADD COLUMN IF NOT EXISTS pattern_invalidation_hit boolean,
  ADD COLUMN IF NOT EXISTS pattern_breakout_confirmed boolean,
  ADD COLUMN IF NOT EXISTS pattern_sample_size integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pattern_shadow_adjustment numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pattern_adjustment_applied boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_candidate_learning_pattern
  ON candidate_learning_events (detected_pattern, resolved_at DESC)
  WHERE detected_pattern IS NOT NULL;
