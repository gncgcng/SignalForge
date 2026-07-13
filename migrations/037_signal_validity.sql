ALTER TABLE saved_signals
  ADD COLUMN IF NOT EXISTS valid_until timestamptz,
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;

UPDATE saved_signals
SET valid_until = generated_at + CASE timeframe
  WHEN '1m' THEN interval '30 minutes'
  WHEN '5m' THEN interval '2 hours'
  WHEN '15m' THEN interval '6 hours'
  WHEN '1h' THEN interval '24 hours'
  WHEN '4h' THEN interval '48 hours'
  ELSE interval '6 hours'
END
WHERE valid_until IS NULL;

ALTER TABLE saved_signals
  ALTER COLUMN valid_until SET NOT NULL;

UPDATE saved_signals s
SET expired_at = COALESCE(s.expired_at, o.resolved_at, o.updated_at)
FROM signal_outcomes o
WHERE o.saved_signal_id = s.id
  AND o.status = 'Expired'
  AND s.expired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_saved_signals_valid_until
  ON saved_signals(valid_until);

CREATE INDEX IF NOT EXISTS idx_signal_outcomes_active_expiration
  ON signal_outcomes(status, saved_signal_id)
  WHERE status = 'Active';
