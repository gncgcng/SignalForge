ALTER TABLE saved_signals
  ADD COLUMN IF NOT EXISTS setup_key text;

UPDATE saved_signals
SET setup_key = CONCAT(symbol, ':', timeframe, ':', direction, ':', EXTRACT(EPOCH FROM generated_at)::bigint)
WHERE setup_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_signals_user_setup_key
  ON saved_signals(user_id, setup_key)
  WHERE setup_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_detected_alerts_cooldown
  ON detected_alerts(user_id, symbol, timeframe, direction, detected_at DESC);
