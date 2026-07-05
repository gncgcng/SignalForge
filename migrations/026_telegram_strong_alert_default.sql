ALTER TABLE telegram_notification_settings
  ALTER COLUMN minimum_confidence SET DEFAULT 80;

UPDATE telegram_notification_settings
SET minimum_confidence = 80
WHERE minimum_confidence < 80;
