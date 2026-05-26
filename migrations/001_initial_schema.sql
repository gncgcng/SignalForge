CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  plan text NOT NULL DEFAULT 'trial',
  trial_signals_used integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'trialing',
  provider text NOT NULL DEFAULT 'stripe',
  provider_customer_id text,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_balances (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  trial_signals_used integer NOT NULL DEFAULT 0,
  free_signal_allowance integer NOT NULL DEFAULT 3,
  paid_credits integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saved_signals (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  timeframe text NOT NULL,
  direction text NOT NULL,
  entry_price numeric NOT NULL,
  stop_loss numeric NOT NULL,
  take_profit numeric NOT NULL,
  risk_reward_ratio numeric NOT NULL,
  confidence_score integer NOT NULL,
  reasoning text NOT NULL,
  confirmations jsonb NOT NULL DEFAULT '[]'::jsonb,
  indicators jsonb NOT NULL DEFAULT '{}'::jsonb,
  market_source text NOT NULL,
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unlocked_signals (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  saved_signal_id text NOT NULL UNIQUE REFERENCES saved_signals(id) ON DELETE CASCADE,
  unlocked_with text NOT NULL DEFAULT 'trial_credit',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_outcomes (
  saved_signal_id text PRIMARY KEY REFERENCES saved_signals(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'Active',
  status_reason text,
  resolved_at timestamptz,
  last_tracking_error text,
  last_tracking_attempt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saved_signals_user_created ON saved_signals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_outcomes_status ON signal_outcomes(status);
