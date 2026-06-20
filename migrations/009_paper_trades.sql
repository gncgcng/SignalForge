CREATE TABLE IF NOT EXISTS paper_trades (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  saved_signal_id text NOT NULL REFERENCES saved_signals(id) ON DELETE CASCADE,
  entered_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, saved_signal_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_user_entered
  ON paper_trades(user_id, entered_at DESC);
