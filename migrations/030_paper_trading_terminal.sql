CREATE TABLE IF NOT EXISTS paper_accounts (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  starting_balance numeric NOT NULL DEFAULT 10000,
  balance numeric NOT NULL DEFAULT 10000,
  realized_pnl numeric NOT NULL DEFAULT 0,
  reset_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starting_balance > 0)
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  saved_signal_id text REFERENCES saved_signals(id) ON DELETE SET NULL,
  symbol text NOT NULL,
  timeframe text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  order_type text NOT NULL CHECK (order_type IN ('market', 'limit')),
  status text NOT NULL CHECK (status IN ('Pending', 'Open', 'Hit TP', 'Hit SL', 'Expired', 'Closed', 'Cancelled')),
  quantity numeric NOT NULL CHECK (quantity > 0),
  position_size_usd numeric NOT NULL CHECK (position_size_usd > 0),
  entry_price numeric,
  limit_price numeric,
  stop_loss numeric NOT NULL,
  take_profit numeric NOT NULL,
  notes text NOT NULL DEFAULT '',
  opened_at timestamptz,
  filled_at timestamptz,
  closed_at timestamptz,
  exit_price numeric,
  outcome text,
  realized_pnl numeric NOT NULL DEFAULT 0,
  r_multiple numeric NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paper_orders_user_status
  ON paper_orders(user_id, status, created_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_paper_orders_user_symbol
  ON paper_orders(user_id, symbol, timeframe, created_at DESC)
  WHERE archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_orders_user_signal
  ON paper_orders(user_id, saved_signal_id)
  WHERE saved_signal_id IS NOT NULL AND archived_at IS NULL AND status <> 'Cancelled';

INSERT INTO paper_orders (
  id, user_id, saved_signal_id, symbol, timeframe, direction, order_type, status,
  quantity, position_size_usd, entry_price, stop_loss, take_profit, notes,
  opened_at, filled_at, closed_at, exit_price, outcome, realized_pnl, r_multiple,
  created_at, updated_at
)
SELECT
  p.id,
  p.user_id,
  p.saved_signal_id,
  s.symbol,
  s.timeframe,
  s.direction,
  'market',
  CASE COALESCE(o.status, 'Active')
    WHEN 'Active' THEN 'Open'
    WHEN 'Hit TP' THEN 'Hit TP'
    WHEN 'Hit SL' THEN 'Hit SL'
    WHEN 'Expired' THEN 'Expired'
    ELSE 'Closed'
  END,
  GREATEST(COALESCE(p.position_size, 0), 0.00000001),
  GREATEST(COALESCE(p.position_size, 0) * s.entry_price, 0.01),
  s.entry_price,
  s.stop_loss,
  s.take_profit,
  'Migrated from SignalForge Paper Portfolio',
  p.entered_at,
  p.entered_at,
  o.resolved_at,
  CASE COALESCE(o.status, 'Active')
    WHEN 'Hit TP' THEN s.take_profit
    WHEN 'Hit SL' THEN s.stop_loss
    ELSE NULL
  END,
  CASE WHEN COALESCE(o.status, 'Active') = 'Active' THEN NULL ELSE o.status END,
  CASE COALESCE(o.status, 'Active')
    WHEN 'Hit TP' THEN COALESCE(p.potential_profit, 0)
    WHEN 'Hit SL' THEN -COALESCE(p.risk_amount, 0)
    ELSE 0
  END,
  CASE COALESCE(o.status, 'Active')
    WHEN 'Hit TP' THEN s.risk_reward_ratio
    WHEN 'Hit SL' THEN -1
    ELSE 0
  END,
  p.created_at,
  COALESCE(o.updated_at, p.created_at)
FROM paper_trades p
JOIN saved_signals s ON s.id = p.saved_signal_id AND s.user_id = p.user_id
LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
ON CONFLICT DO NOTHING;

INSERT INTO paper_accounts (user_id, starting_balance, balance, realized_pnl)
SELECT
  u.id,
  10000,
  10000 + COALESCE(SUM(po.realized_pnl) FILTER (WHERE po.status IN ('Hit TP', 'Hit SL', 'Closed')), 0),
  COALESCE(SUM(po.realized_pnl) FILTER (WHERE po.status IN ('Hit TP', 'Hit SL', 'Closed')), 0)
FROM users u
LEFT JOIN paper_orders po ON po.user_id = u.id AND po.archived_at IS NULL
GROUP BY u.id
ON CONFLICT (user_id) DO NOTHING;
