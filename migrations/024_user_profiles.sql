ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS username_normalized text,
  ADD COLUMN IF NOT EXISTS username_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS public_profile_enabled boolean NOT NULL DEFAULT false;

UPDATE users
SET username_normalized = lower(username)
WHERE username IS NOT NULL
  AND username_normalized IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_normalized
  ON users(username_normalized)
  WHERE username_normalized IS NOT NULL;
