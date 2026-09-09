ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signal_view_mode text NOT NULL DEFAULT 'beginner';

UPDATE users
SET signal_view_mode = 'beginner'
WHERE signal_view_mode IS NULL
   OR signal_view_mode NOT IN ('beginner', 'advanced');

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_signal_view_mode_check;

ALTER TABLE users
  ADD CONSTRAINT users_signal_view_mode_check
  CHECK (signal_view_mode IN ('beginner', 'advanced'));
