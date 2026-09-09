CREATE TABLE IF NOT EXISTS oauth_login_states (
  state_hash text PRIMARY KEY,
  provider text NOT NULL,
  nonce text NOT NULL,
  signup_ip_hash text,
  device_fingerprint_hash text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  provider text NOT NULL,
  provider_subject text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_subject),
  UNIQUE (provider, user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry
  ON oauth_login_states(expires_at)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user
  ON oauth_accounts(user_id);
