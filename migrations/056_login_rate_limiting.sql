CREATE TABLE IF NOT EXISTS login_attempts (
  id text PRIMARY KEY,
  email_hash text NOT NULL,
  ip_hash text NOT NULL,
  successful boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email_hash_created
  ON login_attempts(email_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_hash_created
  ON login_attempts(ip_hash, created_at);
