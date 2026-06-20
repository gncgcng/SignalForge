CREATE TABLE IF NOT EXISTS trade_journals (
  paper_trade_id text PRIMARY KEY REFERENCES paper_trades(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notes_before_entry text NOT NULL DEFAULT '',
  notes_after_exit text NOT NULL DEFAULT '',
  emotion_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  rating integer CHECK (rating BETWEEN 1 AND 5),
  screenshot_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trade_journals_user_updated
  ON trade_journals(user_id, updated_at DESC);
