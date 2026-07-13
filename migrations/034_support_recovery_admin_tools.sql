ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS public_response text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS admin_support_audit_log (
  id text PRIMARY KEY,
  admin_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id text REFERENCES users(id) ON DELETE SET NULL,
  ticket_id text NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_support_audit_ticket_created
  ON admin_support_audit_log(ticket_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_support_audit_admin_action
  ON admin_support_audit_log(admin_user_id, action, created_at DESC);
