ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE sessions
SET expires_at = created_at + interval '7 days'
WHERE expires_at IS NULL;

ALTER TABLE sessions
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '7 days'),
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
