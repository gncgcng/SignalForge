ALTER TABLE telegram_notification_queue
  ADD COLUMN IF NOT EXISTS alert_type text NOT NULL DEFAULT 'ready_trade_signal';

ALTER TABLE telegram_notification_queue
  DROP CONSTRAINT IF EXISTS telegram_notification_queue_user_id_setup_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_queue_exact_message
  ON telegram_notification_queue (user_id, chat_id, setup_key, alert_type);
