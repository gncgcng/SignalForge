-- "My trades": real trades the user logs, to show their own track record. Separate from paper trading
-- (paper_trades, paper_orders, trade_journals), which is unchanged. Named real_trades so it can't be confused
-- with the paper-journal table trade_journals.
CREATE TABLE IF NOT EXISTS real_trades (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  market text NOT NULL CHECK (char_length(market) BETWEEN 1 AND 32 AND market = upper(market)),
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  -- A key from data/track-records/track-records.v1.json (checked by the API), or NULL for "My own setup".
  setup_key text CHECK (setup_key IS NULL OR char_length(setup_key) BETWEEN 1 AND 120),
  timeframe text CHECK (timeframe IS NULL OR char_length(timeframe) BETWEEN 1 AND 8),
  entry_price numeric NOT NULL CHECK (entry_price > 0),
  stop_price numeric NOT NULL CHECK (stop_price > 0),
  target_price numeric CHECK (target_price IS NULL OR target_price > 0),
  size_units numeric NOT NULL CHECK (size_units > 0),
  opened_at timestamptz NOT NULL,
  exit_price numeric CHECK (exit_price IS NULL OR exit_price > 0),
  closed_at timestamptz,
  fees_paid numeric CHECK (fees_paid IS NULL OR fees_paid >= 0),
  fee_rate_pct numeric CHECK (fee_rate_pct IS NULL OR (fee_rate_pct >= 0 AND fee_rate_pct < 100)),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  CONSTRAINT real_trades_stop_side_check CHECK (
    (direction = 'long' AND stop_price < entry_price) OR (direction = 'short' AND stop_price > entry_price)
  ),
  CONSTRAINT real_trades_closed_fields_check CHECK (
    (status = 'closed' AND exit_price IS NOT NULL AND closed_at IS NOT NULL)
    OR (status = 'open' AND exit_price IS NULL AND closed_at IS NULL)
  ),
  CONSTRAINT real_trades_close_after_open_check CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

CREATE INDEX IF NOT EXISTS idx_real_trades_user_opened
  ON real_trades(user_id, opened_at DESC);
