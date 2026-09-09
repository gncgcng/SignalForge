ALTER TABLE telegram_notification_settings
  ALTER COLUMN favorite_markets_only SET DEFAULT false;

UPDATE telegram_notification_settings
SET favorite_markets_only = false
WHERE favorite_markets_only IS NULL;
