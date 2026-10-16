-- "Want stocks & ETFs? Tell us" on the backtesting page: one row per user and feature, so a
-- user who clicks again is not counted twice. Admin shows the count per feature.
CREATE TABLE IF NOT EXISTS feature_requests (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature)
);
