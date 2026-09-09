ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('user', 'tester'));

CREATE TABLE IF NOT EXISTS tester_access_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tester_requests_pending_user
  ON tester_access_requests(user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_tester_requests_status_requested
  ON tester_access_requests(status, requested_at DESC);
