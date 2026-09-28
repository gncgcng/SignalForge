ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_account_status_check;

ALTER TABLE users
  ADD CONSTRAINT users_account_status_check
  CHECK (account_status IN ('active', 'disabled', 'deleted'));
