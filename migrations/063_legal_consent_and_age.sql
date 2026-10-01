-- Record when a new account accepted the Terms/Privacy/Risk documents, which version was in
-- effect, and when the user confirmed they are 18 or older. Only a timestamp is stored for age:
-- never a birthdate or an age number. Accounts created before this migration stay NULL.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS legal_consent_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS legal_consent_version text,
  ADD COLUMN IF NOT EXISTS age_confirmed_at timestamptz;

-- Google sign-in creates the account in the OAuth callback, not in /api/auth/google/start, so
-- the confirmations given at start must survive Google's redirect the same way affiliate_code does.
-- States created before this migration default to false and cannot create a new account.
ALTER TABLE oauth_login_states
  ADD COLUMN IF NOT EXISTS legal_consent_accepted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS age_confirmed boolean NOT NULL DEFAULT false;
