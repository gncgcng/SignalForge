-- First-touch acquisition source (utm_source, else the referring host, else "direct") is
-- stored in the signup event's metadata. Google sign-in creates the account in the OAuth
-- callback, so the source given at start must survive Google's redirect the same way
-- affiliate_code does. States created before this migration carry no source.
ALTER TABLE oauth_login_states
  ADD COLUMN IF NOT EXISTS signup_attribution jsonb NOT NULL DEFAULT '{}'::jsonb;
