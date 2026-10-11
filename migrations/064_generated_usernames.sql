-- New accounts no longer pick a username at signup: they get a generated one (trader_NNNNNN) and
-- can rename it from profile settings. The flag lets onboarding still invite them to choose a name;
-- the first rename clears it. Existing accounts default to false: their usernames are untouched.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username_generated boolean NOT NULL DEFAULT false;
