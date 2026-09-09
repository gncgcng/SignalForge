CREATE TABLE IF NOT EXISTS telegram_connection_codes (
  code text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'expired', 'invalid')),
  chat_id text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_connection_pending_user
  ON telegram_connection_codes(user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_telegram_connection_expiry
  ON telegram_connection_codes(status, expires_at);

CREATE TABLE IF NOT EXISTS telegram_bot_state (
  id text PRIMARY KEY,
  last_update_id bigint NOT NULL DEFAULT 0,
  poll_lease_owner text,
  poll_lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO telegram_bot_state (id, last_update_id)
VALUES ('primary', 0)
ON CONFLICT (id) DO NOTHING;
