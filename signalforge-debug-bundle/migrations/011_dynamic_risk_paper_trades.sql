ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS account_size numeric NOT NULL DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS requested_risk_percent numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS effective_risk_percent numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS risk_amount numeric NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS position_size numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS potential_profit numeric NOT NULL DEFAULT 0;

ALTER TABLE paper_trades
  DROP CONSTRAINT IF EXISTS paper_trades_risk_percent_check;

ALTER TABLE paper_trades
  ADD CONSTRAINT paper_trades_risk_percent_check
  CHECK (
    requested_risk_percent IN (0.25, 0.5, 1, 2)
    AND effective_risk_percent > 0
    AND effective_risk_percent <= 2
  );
