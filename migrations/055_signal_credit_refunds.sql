CREATE TABLE IF NOT EXISTS signal_credit_transactions (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  saved_signal_id text NOT NULL REFERENCES saved_signals(id) ON DELETE CASCADE,
  transaction_type text NOT NULL CHECK (transaction_type IN ('unlock_charge', 'terminal_refund')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity = 1),
  balance_delta integer NOT NULL CHECK (balance_delta IN (-1, 1)),
  credit_pool text NOT NULL DEFAULT 'unlock_credits_balance'
    CHECK (credit_pool = 'unlock_credits_balance'),
  reason text NOT NULL,
  original_transaction_id text REFERENCES signal_credit_transactions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (saved_signal_id, transaction_type),
  CHECK (
    (transaction_type = 'unlock_charge' AND balance_delta = -1 AND original_transaction_id IS NULL)
    OR
    (transaction_type = 'terminal_refund' AND balance_delta = 1 AND original_transaction_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_signal_credit_transactions_user_created
  ON signal_credit_transactions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_credit_transactions_signal
  ON signal_credit_transactions(saved_signal_id, transaction_type);

