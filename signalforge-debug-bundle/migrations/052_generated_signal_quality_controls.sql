CREATE INDEX IF NOT EXISTS idx_generated_signals_recent_active_quality
  ON generated_signals (pair, direction, status, created_at DESC)
  WHERE source NOT IN ('legacy_saved_signal', 'legacy_unlocked_signal');

CREATE INDEX IF NOT EXISTS idx_generated_signals_recent_failure_quality
  ON generated_signals (pair, timeframe, direction, status, updated_at DESC)
  WHERE status IN ('Hit SL', 'Expired')
    AND source NOT IN ('legacy_saved_signal', 'legacy_unlocked_signal');

CREATE INDEX IF NOT EXISTS idx_generated_signals_source_strategy_timeframe_quality
  ON generated_signals (source, strategy, timeframe, status)
  WHERE source NOT IN ('legacy_saved_signal', 'legacy_unlocked_signal');

UPDATE generated_signals
SET status = 'Invalid legacy ready signal',
  result_reason = COALESCE(result_reason, 'Legacy record had readiness 0 and is excluded from current live-engine ready performance.'),
  updated_at = now()
WHERE source IN ('legacy_saved_signal', 'legacy_unlocked_signal')
  AND COALESCE(entry_readiness_score, 0) <= 0
  AND status = 'Active';
