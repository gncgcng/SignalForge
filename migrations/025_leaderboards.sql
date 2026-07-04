ALTER TABLE users
  ADD COLUMN IF NOT EXISTS public_leaderboard_enabled boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_public_leaderboard
  ON users(public_leaderboard_enabled, public_profile_enabled)
  WHERE public_leaderboard_enabled = true
    AND public_profile_enabled = true
    AND username_normalized IS NOT NULL;
