CREATE TABLE IF NOT EXISTS support_tickets (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  username_snapshot text,
  email_snapshot text NOT NULL,
  subscription_tier_snapshot text NOT NULL DEFAULT 'free',
  credit_balance_snapshot integer NOT NULL DEFAULT 0,
  topic text NOT NULL,
  issue text NOT NULL,
  subject text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_review', 'waiting_for_user', 'resolved', 'closed')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  admin_notes text NOT NULL DEFAULT '',
  assigned_to text REFERENCES users(id) ON DELETE SET NULL,
  related_signal_id text,
  related_subscription_id text,
  user_agent text,
  page_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user_created
  ON support_tickets(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status_priority
  ON support_tickets(status, priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_open_created
  ON support_tickets(created_at ASC)
  WHERE status IN ('open', 'in_review', 'waiting_for_user');
