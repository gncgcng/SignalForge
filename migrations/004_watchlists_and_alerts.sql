CREATE TABLE IF NOT EXISTS watchlist_markets (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS alert_preferences (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  timeframe text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long', 'short', 'both')),
  minimum_confidence integer NOT NULL CHECK (minimum_confidence BETWEEN 0 AND 100),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS detected_alerts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preference_id text REFERENCES alert_preferences(id) ON DELETE SET NULL,
  setup_id text NOT NULL,
  symbol text NOT NULL,
  timeframe text NOT NULL,
  direction text NOT NULL,
  confidence_score integer NOT NULL,
  risk_reward_ratio numeric NOT NULL,
  reasoning text NOT NULL,
  confirmations jsonb NOT NULL DEFAULT '[]'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (user_id, preference_id, setup_id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_user_created
  ON watchlist_markets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_preferences_user
  ON alert_preferences(user_id, enabled);
CREATE INDEX IF NOT EXISTS idx_detected_alerts_user_detected
  ON detected_alerts(user_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_detected_alerts_user_unread
  ON detected_alerts(user_id, read_at) WHERE read_at IS NULL;
