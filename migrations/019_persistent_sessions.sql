ALTER TABLE sessions
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '180 days');

UPDATE sessions
SET expires_at = GREATEST(expires_at, now() + interval '180 days')
WHERE expires_at > now();
