ALTER TABLE setup_candidates
  ADD COLUMN IF NOT EXISTS display_pair text,
  ADD COLUMN IF NOT EXISTS setup_quality_score numeric,
  ADD COLUMN IF NOT EXISTS entry_readiness_score numeric,
  ADD COLUMN IF NOT EXISTS ideal_entry numeric,
  ADD COLUMN IF NOT EXISTS ideal_entry_zone_low numeric,
  ADD COLUMN IF NOT EXISTS ideal_entry_zone_high numeric;

UPDATE setup_candidates
SET display_pair = COALESCE(display_pair, replace(replace(symbol, '-', ''), '/', '')),
    setup_quality_score = COALESCE(setup_quality_score, candidate_score),
    entry_readiness_score = COALESCE(entry_readiness_score, readiness_score),
    ideal_entry_zone_low = COALESCE(ideal_entry_zone_low, NULLIF(ideal_entry_zone->>'low', '')::numeric),
    ideal_entry_zone_high = COALESCE(ideal_entry_zone_high, NULLIF(ideal_entry_zone->>'high', '')::numeric),
    ideal_entry = COALESCE(
      ideal_entry,
      (NULLIF(ideal_entry_zone->>'low', '')::numeric + NULLIF(ideal_entry_zone->>'high', '')::numeric) / 2,
      current_price
    );

ALTER TABLE setup_candidates DROP CONSTRAINT IF EXISTS setup_candidates_status_check;
ALTER TABLE setup_candidates ADD CONSTRAINT setup_candidates_status_check
  CHECK (status IN ('watching', 'almost_ready', 'ready', 'alerted', 'expired', 'rejected', 'promoted_to_signal'));

DROP INDEX IF EXISTS idx_setup_candidates_active;
CREATE INDEX IF NOT EXISTS idx_setup_candidates_active
  ON setup_candidates (status, expires_at, last_checked_at)
  WHERE status IN ('watching', 'almost_ready', 'ready');

ALTER TABLE candidate_learning_events
  ADD COLUMN IF NOT EXISTS initial_setup_score numeric,
  ADD COLUMN IF NOT EXISTS initial_readiness_score numeric,
  ADD COLUMN IF NOT EXISTS entry_never_filled boolean,
  ADD COLUMN IF NOT EXISTS shadow_confidence_adjustment numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadow_adjustment_applied boolean NOT NULL DEFAULT false;

UPDATE candidate_learning_events
SET initial_setup_score = COALESCE(initial_setup_score, initial_score),
    initial_readiness_score = COALESCE(initial_readiness_score, readiness_score),
    entry_never_filled = COALESCE(entry_never_filled, reason_not_promoted ILIKE '%entry never filled%');
