CREATE TABLE IF NOT EXISTS setup_candidates (
  id text PRIMARY KEY,
  setup_key text NOT NULL,
  symbol text NOT NULL,
  provider text NOT NULL,
  timeframe text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  setup_type text NOT NULL,
  status text NOT NULL DEFAULT 'watching'
    CHECK (status IN ('watching', 'ready', 'alerted', 'expired', 'rejected', 'promoted_to_signal')),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  candidate_score numeric NOT NULL DEFAULT 0,
  readiness_score numeric NOT NULL DEFAULT 0,
  confidence_estimate numeric NOT NULL DEFAULT 0,
  entry_quality text NOT NULL DEFAULT 'poor'
    CHECK (entry_quality IN ('excellent', 'good', 'fair', 'poor')),
  current_price numeric,
  ideal_entry_zone jsonb NOT NULL DEFAULT '{}'::jsonb,
  invalidation_level numeric,
  potential_stop_loss numeric,
  potential_take_profit numeric,
  potential_rr numeric,
  reasons_for_watching jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_confirmations jsonb NOT NULL DEFAULT '[]'::jsonb,
  rejection_reason text,
  promoted_signal_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_setup_candidates_setup_key
  ON setup_candidates (setup_key);
CREATE INDEX IF NOT EXISTS idx_setup_candidates_active
  ON setup_candidates (status, expires_at, last_checked_at)
  WHERE status IN ('watching', 'ready');
CREATE INDEX IF NOT EXISTS idx_setup_candidates_market
  ON setup_candidates (symbol, timeframe, updated_at DESC);

CREATE TABLE IF NOT EXISTS candidate_learning_events (
  id text PRIMARY KEY,
  candidate_id text NOT NULL UNIQUE REFERENCES setup_candidates(id) ON DELETE CASCADE,
  market text NOT NULL,
  timeframe text NOT NULL,
  direction text NOT NULL,
  setup_type text NOT NULL,
  initial_score numeric NOT NULL DEFAULT 0,
  readiness_score numeric NOT NULL DEFAULT 0,
  final_status text NOT NULL,
  would_have_hit_tp boolean,
  would_have_hit_sl boolean,
  went_nowhere boolean,
  max_favorable_excursion numeric,
  max_adverse_excursion numeric,
  reason_not_promoted text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidate_learning_market
  ON candidate_learning_events (market, timeframe, resolved_at DESC);

ALTER TABLE paper_orders
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE paper_orders DROP CONSTRAINT IF EXISTS paper_orders_status_check;
ALTER TABLE paper_orders ADD CONSTRAINT paper_orders_status_check
  CHECK (status IN ('Pending', 'Open', 'Hit TP', 'Hit SL', 'Expired', 'Expired unfilled', 'Closed', 'Cancelled'));
