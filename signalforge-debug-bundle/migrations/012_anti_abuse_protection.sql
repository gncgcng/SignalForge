ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS trial_used boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS signup_ip_hash text,
  ADD COLUMN IF NOT EXISTS device_fingerprint_hash text,
  ADD COLUMN IF NOT EXISTS abuse_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS abuse_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS abuse_review_status text NOT NULL DEFAULT 'clear';

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_abuse_review_status_check;

ALTER TABLE users
  ADD CONSTRAINT users_abuse_review_status_check
  CHECK (abuse_review_status IN ('clear', 'flagged', 'reviewed'));

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signup_attempts (
  id text PRIMARY KEY,
  ip_hash text NOT NULL,
  device_fingerprint_hash text,
  email_domain text,
  disposable_email boolean NOT NULL DEFAULT false,
  successful boolean NOT NULL DEFAULT false,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_trial_history (
  device_fingerprint_hash text PRIMARY KEY,
  first_user_id text REFERENCES users(id) ON DELETE SET NULL,
  trial_granted_at timestamptz NOT NULL DEFAULT now(),
  trial_used boolean NOT NULL DEFAULT false,
  trial_used_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signup_attempts_ip_created
  ON signup_attempts(ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_device_created
  ON signup_attempts(device_fingerprint_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_abuse_review
  ON users(abuse_review_status, abuse_score DESC);
CREATE INDEX IF NOT EXISTS idx_verification_tokens_expiry
  ON email_verification_tokens(expires_at)
  WHERE used_at IS NULL;

UPDATE users
SET email_verified_at = COALESCE(email_verified_at, created_at)
WHERE email_verified_at IS NULL;

UPDATE users
SET trial_used = true
WHERE trial_signals_used > 0;
