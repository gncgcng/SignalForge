ALTER TABLE generated_signals
  ADD COLUMN IF NOT EXISTS final_decision text,
  ADD COLUMN IF NOT EXISTS primary_decision_reason text,
  ADD COLUMN IF NOT EXISTS secondary_decision_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS decision_version text,
  ADD COLUMN IF NOT EXISTS decision_created_at timestamptz;

UPDATE generated_signals
SET
  final_decision = CASE
    WHEN source IN ('legacy_saved_signal', 'legacy_unlocked_signal', 'backtest_shadow', 'admin_test')
      OR status IN ('Watching', 'Avoid Trade', 'Hit TP', 'Hit SL', 'Expired', 'Manually closed', 'Cancelled', 'Invalidated')
      THEN 'admin_only'
    WHEN status ~* 'rejected' OR status IN ('Strategy Misread Rejected', 'Weak Pattern Match')
      THEN 'rejected'
    WHEN status IN (
      'Duplicate blocked', 'Cooldown blocked', 'Correlated duplicate', 'Quarantined timeframe',
      'Readiness failed', 'Invalid legacy ready signal', 'Weak strategy match', 'Poor entry quality',
      'Invalid stop loss', 'Unrealistic take profit', 'Weak risk/reward', 'Bad market regime',
      'Historical underperformer', 'Similar to past losers', 'Confidence below promotion minimum',
      'Calibration error'
    ) THEN 'blocked'
    WHEN status IN ('Active', 'Expiring Soon', 'Ready', 'Alerted') THEN 'ready_signal'
    ELSE 'admin_only'
  END,
  primary_decision_reason = COALESCE(primary_decision_reason, 'legacy_decision_backfill'),
  decision_version = COALESCE(decision_version, 'signal_decision_v1'),
  decision_created_at = COALESCE(decision_created_at, updated_at, created_at, now())
WHERE final_decision IS NULL;

ALTER TABLE generated_signals
  DROP CONSTRAINT IF EXISTS generated_signals_final_decision_check;

ALTER TABLE generated_signals
  ADD CONSTRAINT generated_signals_final_decision_check
  CHECK (final_decision IS NULL OR final_decision IN ('ready_signal', 'admin_only', 'blocked', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_generated_signals_final_decision
  ON generated_signals (final_decision, created_at DESC);

ALTER TABLE telegram_notification_queue
  ADD COLUMN IF NOT EXISTS signal_id text,
  ADD COLUMN IF NOT EXISTS preference_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS telegram_message_id text,
  ADD COLUMN IF NOT EXISTS telegram_response jsonb,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS final_error_code text,
  ADD COLUMN IF NOT EXISTS final_error_message text;

UPDATE telegram_notification_queue
SET signal_id = COALESCE(payload->>'signalId', payload->>'id')
WHERE signal_id IS NULL;

WITH ranked_deliveries AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY user_id, signal_id, alert_type
      ORDER BY
        CASE status WHEN 'sent' THEN 1 WHEN 'sending' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END,
        created_at,
        id
    ) AS delivery_rank
  FROM telegram_notification_queue
  WHERE signal_id IS NOT NULL
)
UPDATE telegram_notification_queue q
SET signal_id = NULL
FROM ranked_deliveries ranked
WHERE q.id = ranked.id
  AND ranked.delivery_rank > 1;

ALTER TABLE telegram_notification_queue
  DROP CONSTRAINT IF EXISTS telegram_notification_queue_status_check;

ALTER TABLE telegram_notification_queue
  ADD CONSTRAINT telegram_notification_queue_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'blocked'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_queue_signal_delivery
  ON telegram_notification_queue (user_id, signal_id, alert_type)
  WHERE signal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_queue_signal_status
  ON telegram_notification_queue (signal_id, status, created_at DESC);
