ALTER TABLE support_tickets
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'authenticated_support';

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS requester_fingerprint_hash text;

CREATE INDEX IF NOT EXISTS idx_support_tickets_public_recovery_rate
  ON support_tickets(requester_fingerprint_hash, created_at DESC)
  WHERE source = 'public_account_recovery';
