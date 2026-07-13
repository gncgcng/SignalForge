ALTER TABLE setup_candidates
  ADD COLUMN IF NOT EXISTS next_conditions jsonb NOT NULL DEFAULT '[]'::jsonb;

