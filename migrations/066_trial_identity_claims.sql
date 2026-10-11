-- One free trial per email address / Google account. A row is written when an identity is first
-- granted free unlocks and is kept when the account is deleted, so deleting and re-signing up
-- with the same email (or Google account) no longer earns a second trial.
-- identity_hash is HMAC-SHA256 keyed by TRIAL_IDENTITY_SECRET over the normalized email or the
-- Google subject. There is deliberately no user_id: the row identifies no one on its own.
CREATE TABLE IF NOT EXISTS trial_identity_claims (
  identity_hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('email', 'google')),
  first_claimed_at timestamptz NOT NULL DEFAULT now()
);
