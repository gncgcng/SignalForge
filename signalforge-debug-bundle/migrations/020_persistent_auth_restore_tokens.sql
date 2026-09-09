CREATE TABLE IF NOT EXISTS auth_restore_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  device_fingerprint_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP INDEX IF EXISTS idx_auth_restore_tokens_user_device_active;

CREATE INDEX IF NOT EXISTS idx_auth_restore_tokens_user_device_active
  ON auth_restore_tokens(user_id, device_fingerprint_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_auth_restore_tokens_lookup
  ON auth_restore_tokens(token_hash, device_fingerprint_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_auth_restore_tokens_expires
  ON auth_restore_tokens(expires_at);
