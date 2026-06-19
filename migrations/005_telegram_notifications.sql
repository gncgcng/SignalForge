CREATE TABLE IF NOT EXISTS telegram_notification_settings (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  favorite_markets_only boolean NOT NULL DEFAULT true,
  timeframes text[] NOT NULL DEFAULT ARRAY['1h', '4h']::text[],
  direction text NOT NULL DEFAULT 'both'
    CHECK (direction IN ('long', 'short', 'both')),
  minimum_confidence integer NOT NULL DEFAULT 75
    CHECK (minimum_confidence BETWEEN 0 AND 100),
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_notification_queue (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setup_key text NOT NULL,
  chat_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, setup_key)
);

CREATE INDEX IF NOT EXISTS idx_telegram_queue_pending
  ON telegram_notification_queue(status, next_attempt_at, created_at);
