-- "Confirm with Google" re-authentication for accounts that have no password.
--
-- A re-auth round trip is its own OAuth state, never a login: purpose separates the two so a
-- state minted for one can't be completed as the other, and a re-auth state is bound to the
-- user and session that started it.
ALTER TABLE oauth_login_states
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'login',
  ADD COLUMN IF NOT EXISTS user_id text REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS session_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_login_states_purpose_check') THEN
    ALTER TABLE oauth_login_states
      ADD CONSTRAINT oauth_login_states_purpose_check CHECK (
        (purpose = 'login' AND user_id IS NULL AND session_id IS NULL) OR
        (purpose = 'reauth' AND user_id IS NOT NULL AND session_id IS NOT NULL)
      );
  END IF;
END $$;

-- Stamped by a successful re-auth on the session that performed it; the app treats it as valid
-- for 10 minutes. Sessions are per device, so a re-auth never carries over to another device.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS recent_reauth_at timestamptz;

-- Accounts created through Google used to get a random, never-disclosed legacy sha256 password.
-- Nobody can sign in with it, so it is cleared to the same empty "no password" marker deleted
-- accounts use. Only rows still holding that original legacy hash qualify: a password set later
-- (reset link, admin recovery) is scrypt, and a legacy hash can only be upgraded by a login
-- that knows it.
UPDATE users u
SET password_salt = '', password_hash = '', updated_at = now()
WHERE u.password_hash <> ''
  AND u.password_hash NOT LIKE 'scrypt$%'
  AND EXISTS (
    SELECT 1 FROM product_analytics_events e
    WHERE e.user_id = u.id AND e.event_type = 'signup' AND e.auth_provider = 'google'
  )
  AND EXISTS (
    SELECT 1 FROM oauth_accounts o
    WHERE o.user_id = u.id AND o.provider = 'google'
  );
